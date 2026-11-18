import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.env.PROFILE_SCOPE_TARGET ?? join(directory, ".."));
const require = createRequire(import.meta.url);
const sdkPackage = name => process.env.PROFILE_SCOPE_SDK
  ? join(resolve(process.env.PROFILE_SCOPE_SDK), "node_modules/@earendil-works", name)
  : dirname(dirname(require.resolve(`@earendil-works/${name}`)));
const cli = join(sdkPackage("pi-coding-agent"), "dist/cli.js");
const networkGuard = "data:text/javascript," + encodeURIComponent('globalThis.fetch = async input => { process.stderr.write(`Unexpected startup fetch ${String(input)}\\n`); process.exit(86); };');
const chatId = "gpt-5.6-luna";
const scenarios = [
  { policy: "missing", eligible: false },
  { policy: "malformed", eligible: false },
  { policy: "legacy", eligible: true },
  { policy: "work", eligible: false },
  { policy: "work", eligible: true },
  { policy: "personal", eligible: false },
].flatMap(scenario => ["api_key", "oauth"].map(credential => ({ ...scenario, credential })));

async function probe(scenario) {
  for (const name of ["pi-ai", "pi-coding-agent"]) {
    const metadata = JSON.parse(readFileSync(join(sdkPackage(name), "package.json"), "utf8"));
    assert.equal(metadata.version, "1.5.2", `Expected actual SDK 1.5.2 for ${name}`);
  }
  const profile = mkdtempSync(join(tmpdir(), "pi-profile-scope-"));
  const cwd = join(profile, "checkout");
  mkdirSync(cwd);
  const env = {
    PATH: process.env.PATH,
    HOME: profile,
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_CACHE_HOME: join(profile, "cache"),
    XDG_DATA_HOME: join(profile, "data"),
    GIT_CONFIG_NOSYSTEM: "1",
    PI_CODING_AGENT_DIR: profile,
    PROFILE_SCOPE_SCENARIO: JSON.stringify(scenario),
  };
  const fixture = (name, value) => writeFileSync(join(profile, name), typeof value === "string" ? value : JSON.stringify(value));
  for (const command of [["init", "-q"], ["remote", "add", "origin", `git@github.com:${scenario.eligible ? "fixture-work" : "fixture-personal"}/scope.git`]]) {
    const git = spawnSync("git", ["-C", cwd, ...command], { env, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  if (scenario.policy !== "missing") fixture("codex-routing-policy.json", scenario.policy === "malformed" ? "{" : {
    version: 1,
    accountOrder: ["personal"],
    work: { githubOwners: ["fixture-work"] },
    ...(scenario.policy === "legacy" ? {} : { copilotProfile: scenario.policy }),
  });
  fixture("settings.json", { retry: { enabled: false }, compaction: { enabled: false } });
  fixture("models.json", { providers: { "github-copilot": { baseUrl: "https://fixture.invalid/copilot" } } });
  fixture("auth.json", { "github-copilot": scenario.credential === "api_key"
    ? { type: "api_key", key: "fixture-stored-key" }
    : { type: "oauth", access: "fixture-copilot-access;proxy-ep=proxy.fixture.invalid", refresh: "fixture-refresh", expires: 4102444800000, availableModelIds: [chatId] } });
  const beforeAuth = readFileSync(join(profile, "auth.json"), "utf8");
  const child = spawn(process.execPath, ["--import", networkGuard, cli, "--offline", "--no-mcp", "--no-context-files", "--no-approve", "--no-extensions", "--mode", "rpc", "--no-session", "-e", join(target, "index.ts"), "-e", join(directory, "profile-scope-probe.ts")], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const result = await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => finish(new Error(`Native scope probe timed out\n${stdout}\n${stderr}`)), 30000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolveResult(value); };
      child.once("error", error => finish(error));
      child.once("exit", code => finish(new Error(`Native scope probe exited ${code}\n${stdout}\n${stderr}`)));
      let buffer = "";
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          if (response.id !== "scope") continue;
          const entry = response.data?.entries?.find(item => item.customType === "profile-scope-result");
          if (!response.success || !entry) finish(new Error(`Missing scope probe result\n${line}\n${stderr}`));
          else finish(null, entry.data);
        }
      });
      child.stdin.write(JSON.stringify({ id: "scope", type: "get_entries" }) + "\n");
    });
    assert.equal(readFileSync(join(profile, "auth.json"), "utf8"), beforeAuth, "Synthetic credentials remain untouched");
    assert.equal(result.probeError, undefined, result.stack ?? JSON.stringify(result));
    assert.deepEqual(result.unexpectedRequests, [], "No external request, including auth, may escape the fake transport");
    return { ...result, diagnostics: stderr.trim() };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", done));
    rmSync(profile, { recursive: true, force: true });
  }
}

for (const scenario of scenarios) {
  const allowed = scenario.policy === "personal" || scenario.policy === "work" && scenario.eligible;
  test(`native Copilot ${scenario.policy}, ${scenario.eligible ? "work" : "personal"} repository, ${scenario.credential}`, async t => {
    const trace = await probe(scenario);
    t.diagnostic(JSON.stringify(trace));
    for (const name of ["registry-simple", "registry-raw", "native-simple-explicit", "native-raw-explicit", "native-forged-provider", "native-stale-selection", "registry-classifier", "native-classifier-explicit"]) {
      await t.test(name, () => {
        const observed = trace.operations[name];
        assert.ok(observed, `Probe must execute ${name}`);
        if (!allowed) {
          assert.equal(observed.requests, 0, `${name} must deny before transport, including explicit keys`);
          if (name.includes("classifier")) assert.equal(observed.thrown, undefined, "Native classifier failures return error results, not rejections");
          if (observed.thrown) assert.match(observed.thrown, /copilot|ownership|profile|restricted|scope|policy|work/i);
          else {
            assert.equal(observed.value.stopReason, "error", "Scope denial is an error, not cancellation or quota fallback");
            assert.match(observed.value.errorMessage, /copilot|ownership|profile|restricted|scope|policy|work/i);
          }
          return;
        }
        assert.equal(observed.thrown, undefined, JSON.stringify(observed));
        assert.equal(observed.requests, 1, "Allowed ordinary Copilot must use the native transport once");
        assert.equal(observed.value.stopReason, "stop", JSON.stringify(observed));
        const request = trace.requests.find(item => item.operation === name);
        const storedKey = scenario.credential === "oauth" ? "fixture-copilot-access;proxy-ep=proxy.fixture.invalid" : "fixture-stored-key";
        assert.equal(request.authorization, `Bearer ${["registry-simple", "registry-classifier"].includes(name) ? storedKey : "fixture-explicit-key"}`);
        if (name.includes("classifier")) {
          assert.deepEqual(observed.value.answers, { allowed: { type: "bool", probability: 0.875 } });
          assert.match(request.url, /\/v1\/systemone$/);
        } else {
          assert.deepEqual(observed.value.events, ["start", "text_start", "text_delta", "done"]);
          assert.ok(observed.value.content.some(part => part.type === "text" && part.text === "scope fixture"));
          assert.equal(observed.value.usage.input, 2);
          assert.equal(observed.value.usage.output, 3);
        }
      });
    }
    await t.test("native auth is scope guarded", () => {
      const auth = trace.operations.auth;
      assert.equal(auth.thrown, undefined);
      assert.equal(auth.value.ok, allowed, "Physical Copilot auth must be denied before returning a stored key");
      const ambient = trace.operations["ambient-api-key-auth"];
      if (allowed) {
        assert.equal(ambient.value?.auth.apiKey, "fixture-ambient-key");
        assert.deepEqual(trace.ambientAuthReads, ["COPILOT_GITHUB_TOKEN"]);
      } else {
        assert.equal(ambient.value, undefined, "Denied API-key auth cannot expose an ambient key");
        assert.deepEqual(trace.ambientAuthReads, [], "Deny before native auth reads the environment");
      }
      const oauth = trace.operations["oauth-to-auth"];
      if (allowed) assert.equal(oauth.value?.apiKey, "fixture-copilot-access;proxy-ep=proxy.fixture.invalid");
      else {
        assert.equal(oauth.value, undefined, "Direct native OAuth conversion must not expose a denied credential");
        assert.match(oauth.thrown, /copilot|ownership|profile|restricted|scope|policy|work/i);
      }
    });
    await t.test("cold and refreshed native availability preserves ownership and OAuth metadata", () => {
      if (!allowed) {
        assert.deepEqual(trace.coldAvailable, []);
        assert.deepEqual(trace.available, []);
        assert.deepEqual(trace.availableChat, []);
        assert.deepEqual(trace.availableClassifiers, []);
      } else {
        for (const ids of [trace.coldAvailable, trace.available, trace.availableChat]) {
          assert.ok(ids.includes(chatId), "Eligible Copilot available during actual session startup");
          if (scenario.credential === "oauth") assert.deepEqual(ids, [chatId], "Keep native OAuth availableModelIds filtering");
        }
        assert.ok(trace.availableClassifiers.includes(trace.classifierId), "Keep native non-chat availability semantics");
      }
    });
    if (["legacy", "personal", "work"].includes(scenario.policy)) {
      await t.test("fixture policy is accepted", () => assert.doesNotMatch(trace.diagnostics, /Cannot load Codex routing policy/));
    }
  });
}
