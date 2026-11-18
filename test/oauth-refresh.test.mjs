import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./oauth-refresh-probe.ts", import.meta.url));

for (const [kind, name] of [
  ["scope-loss", "native file auth saves a rotated token after scope loss but denies its use"],
  ["caller-cancel", "native caller cancellation after refresh starts preserves the rotated token"],
  ["ineligible-start", "work refresh cannot start outside an eligible root"],
]) test(name, { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-oauth-refresh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: directory, TMPDIR: directory, PI_CODING_AGENT_DIR: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", OAUTH_REFRESH_CASE: kind,
  };
  const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--no-extensions", "--mode", "rpc", "--no-session", "-e", probe], {
    cwd: directory, env, timeout: 20000, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  child.stdin.end(JSON.stringify({ id: "oauth-refresh", type: "get_entries" }) + "\n");
  assert.deepEqual(await exited, [0, null], stderr);
  const response = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(record => record.id === "oauth-refresh");
  assert.equal(response?.success, true, stderr || stdout);
  const entries = response.data.entries;
  const observations = entries.find(entry => entry.customType === "oauth-refresh-observations");
  if (observations) t.diagnostic(JSON.stringify(observations.data));
  const result = entries.find(entry => entry.customType === "oauth-refresh-result");
  assert.ok(result, stderr || stdout);
  assert.equal(result.data.error, undefined, result.data.stack || result.data.error);
  assert.equal(result.data.passed, kind);
  assert.equal(stderr.trim(), "", stderr);
});
