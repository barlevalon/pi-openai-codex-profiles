import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const cli = join(sdk, "dist/cli.js");
const networkGuard = "data:text/javascript," + encodeURIComponent('globalThis.fetch = async () => { process.stderr.write("Unexpected startup fetch\\n"); process.exit(86); };');
const policyModel = "codex-policy/gpt-5.6-luna";
const workModel = "openai-codex:work/gpt-5.6-luna";
const copilotModel = "github-copilot/claude-sonnet-5.5";
const reviewModel = "profile-review/claude-sonnet-5.5";
const restricted = new Set(["openai-codex:work", "github-copilot", "profile-review"]);
const modelId = model => `${model.provider}/${model.id}`;

function fixture(t, settings = {}) {
  const profile = mkdtempSync(join(tmpdir(), "pi-startup-scope-"));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: profile,
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_CACHE_HOME: join(profile, "cache"),
    XDG_DATA_HOME: join(profile, "data"),
    GIT_CONFIG_NOSYSTEM: "1",
    PI_CODING_AGENT_DIR: profile,
  };
  const repos = {};
  for (const [name, owner] of [["work", "example-org"], ["personal", "example-personal"]]) {
    const cwd = repos[name] = join(profile, name);
    mkdirSync(cwd);
    for (const args of [["init", "-q"], ["remote", "add", "origin", `git@github.com:${owner}/fixture.git`]]) {
      const git = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
    }
  }
  const write = (name, value) => writeFileSync(join(profile, name), JSON.stringify(value));
  write("codex-routing-policy.json", {
    version: 1,
    accountOrder: ["work", "personal"],
    copilotProfile: "work",
    work: { githubOwners: ["example-org"] },
    review: { copilotModel: "claude-sonnet-5.5", codexFallbackModel: "gpt-5.6-luna" },
  });
  write("settings.json", {
    retry: { enabled: false }, compaction: { enabled: false },
    defaultProvider: "codex-policy", defaultModel: "gpt-5.6-luna",
    ...settings,
  });
  write("auth.json", {
    "openai-codex:personal": { type: "oauth", access: "fake-personal", refresh: "fake-personal", expires: 4102444800000 },
    "openai-codex:work": { type: "oauth", access: "fake-work", refresh: "fake-work", expires: 4102444800000 },
    "github-copilot": { type: "api_key", key: "fake-copilot" },
  });
  const probe = join(profile, "startup-probe.ts");
  writeFileSync(probe, `export default function (pi) {
    pi.on("session_start", (_event, ctx) => {
      pi.appendEntry("startup-scope", { cwd: ctx.cwd, models: ctx.scopedModels.map(entry => entry.model) });
    });
  }`);
  const args = ["--import", networkGuard, cli, "--offline", "--no-mcp", "--no-context-files", "--no-approve", "--no-extensions", "-e", join(root, "index.ts"), "-e", probe];
  return {
    repos,
    resume(name) {
      const directory = join(profile, "resume-fixtures");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${name}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: `fixture-${name}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: repos[name] }) + "\n");
      return path;
    },
    list(name) {
      const result = spawnSync(process.execPath, [...args, "--list-models"], { cwd: repos[name], env, encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.error?.stack ?? result.stderr);
      return result.stdout.split("\n").slice(1).filter(Boolean).map(line => {
        const [provider, id] = line.trim().split(/\s+/);
        return { provider, id };
      });
    },
    async rpc(name, commands, session) {
      const child = spawn(process.execPath, [...args, "--mode", "rpc", ...(session ? ["--session", session] : ["--no-session"])], { cwd: repos[name], env, stdio: ["pipe", "pipe", "pipe"] });
      const exited = once(child, "exit");
      let stdout = "";
      let stderr = "";
      let buffer = "";
      let pending;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdout.on("data", chunk => {
        stdout += chunk;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          if (response.id === pending?.id) pending.resolve(response);
        }
      });
      const request = async (type, id) => {
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Startup probe timed out\n${stdout}\n${stderr}`)), 30000);
          pending = { id, resolve: value => { clearTimeout(timer); resolve(value); } };
          exited.then(([code]) => { clearTimeout(timer); reject(new Error(`Startup probe exited ${code}\n${stdout}\n${stderr}`)); }, reject);
          child.stdin.write(JSON.stringify({ id, type }) + "\n");
        });
        assert.equal(response.success, true, JSON.stringify(response));
        return response.data;
      };
      try {
        const entries = await request("get_entries", "startup");
        const startup = entries.entries.find(entry => entry.customType === "startup-scope")?.data;
        assert.ok(startup, stdout + stderr);
        const responses = [];
        for (const [index, command] of commands.entries()) responses.push(await request(command, `command-${index}`));
        return { startup, responses, stderr };
      } finally {
        child.stdin.end();
        if (child.exitCode === null) child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

function noWarnings(result) {
  assert.doesNotMatch(result.stderr, /No models match pattern/);
}

function noWork(models) {
  assert.deepEqual(models.filter(model => restricted.has(model.provider)).map(modelId), []);
}

test("work startup resolves every enabled model before session_start", async t => {
  const models = [policyModel, workModel, copilotModel];
  const host = fixture(t, { enabledModels: models });
  const result = await host.rpc("work", []);
  noWarnings(result);
  assert.deepEqual(result.startup.models.map(modelId), models);
});

test("work cycle_model alternates between policy Codex and Copilot", async t => {
  const models = [policyModel, copilotModel];
  const host = fixture(t, { enabledModels: models });
  const result = await host.rpc("work", ["get_state", "cycle_model", "cycle_model", "cycle_model", "cycle_model"]);
  noWarnings(result);
  assert.deepEqual(result.startup.models.map(modelId), models);
  assert.deepEqual(result.responses.map(response => modelId(response.model)), [policyModel, copilotModel, policyModel, copilotModel, policyModel]);
});

test("work --list-models includes Work Codex, Copilot, and review", t => {
  const host = fixture(t);
  const models = host.list("work").map(modelId);
  for (const expected of [workModel, copilotModel, reviewModel]) assert.ok(models.includes(expected), `Missing ${expected}`);
});

test("work defaultProvider selects Copilot at startup", async t => {
  const host = fixture(t, { defaultProvider: "github-copilot", defaultModel: "claude-sonnet-5.5" });
  const result = await host.rpc("work", ["get_state"]);
  assert.equal(modelId(result.responses[0].model), copilotModel);
});

test("personal startup hides work providers from list, scope, and RPC availability", async t => {
  const host = fixture(t, { enabledModels: [policyModel, workModel, copilotModel, reviewModel] });
  noWork(host.list("personal"));
  const result = await host.rpc("personal", ["get_available_models"]);
  assert.deepEqual(result.startup.models.map(modelId), [policyModel]);
  noWork(result.startup.models);
  noWork(result.responses[0].models);
});

test("work launch resuming a personal session keeps Copilot hidden", async t => {
  const host = fixture(t, { enabledModels: [policyModel, copilotModel] });
  const result = await host.rpc("work", ["get_available_models"], host.resume("personal"));
  assert.equal(result.startup.cwd, host.repos.personal);
  assert.deepEqual(result.startup.models.map(modelId), [policyModel]);
  noWork(result.responses[0].models);
});

test("personal launch resuming a work session discovers Copilot without startup warnings", async t => {
  const host = fixture(t, { enabledModels: [policyModel, copilotModel] });
  const result = await host.rpc("personal", ["get_available_models"], host.resume("work"));
  noWarnings(result);
  assert.equal(result.startup.cwd, host.repos.work);
  assert.deepEqual(result.startup.models.map(modelId), [policyModel, copilotModel]);
  assert.ok(result.responses[0].models.some(model => modelId(model) === copilotModel));
});
