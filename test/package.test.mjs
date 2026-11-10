import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Pi package uses host dependencies and registers both Codex profiles", { timeout: 60000 }, async () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");

  const directory = mkdtempSync(join(tmpdir(), "pi-codex-profiles-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory, npm_config_ignore_scripts: "true" };
  let child;
  let exited;
  let diagnostics = "";
  try {
    const install = spawnSync("pi", ["install", process.env.PI_PACKAGE_TEST_SOURCE || root, "--no-approve"], {
      cwd: directory, env, encoding: "utf8", timeout: 30000,
    });
    assert.equal(install.status, 0, install.error?.message || install.stderr || install.stdout);
    const probe = join(directory, "probe.ts");
    writeFileSync(probe, `export default function (pi) {
      pi.on("session_start", (_event, ctx) => {
        pi.appendEntry("profiles-package-test", ["openai-codex", "openai-codex:personal", "openai-codex:work"].map(id => {
          const provider = ctx.modelRegistry.getProvider(id);
          return { id, models: provider?.getModels().map(model => ({ id: model.id, provider: model.provider })) };
        }));
      });
    }`);
    child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", "rpc", "--no-session", "-e", probe], {
      cwd: directory, env, stdio: ["pipe", "pipe", "pipe"],
    });
    exited = once(child, "exit");
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    const response = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Pi RPC response timed out")), 15000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", code => fail(new Error(`Pi exited before replying (${code}): ${diagnostics}`)));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.id === "entries") {
            clearTimeout(timer);
            resolve(record);
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: "entries", type: "get_entries" }) + "\n");
    });
    assert.equal(response.success, true, response.error);
    const entry = response.data.entries.find(entry => entry.customType === "profiles-package-test");
    assert.ok(entry, "package probe ran after extension loading");
    const [base, personal, work] = entry.data;
    assert.ok(base.models.length > 0, "bundled Codex catalogue is populated");
    for (const profile of [personal, work]) {
      assert.deepEqual(profile.models.map(model => model.id), base.models.map(model => model.id));
      assert.ok(profile.models.every(model => model.provider === profile.id));
    }
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
    assert.equal(diagnostics.trim(), "", diagnostics);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited.catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
