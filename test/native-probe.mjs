import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const probe = fileURLToPath(new URL("./domain-probe.ts", import.meta.url));

export function probeTest(name, kind, check = () => {}, extra = {}, probePath = probe) {
  test(name, { timeout: 30000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "codex-probe-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await check(await nativeProbe(kind, directory, directory, extra, probePath));
  });
}

export async function nativeProbe(kind, directory, cwd = directory, extra = {}, probePath = probe) {
  const env = { ...process.env, ...extra, PI_CODING_AGENT_DIR: directory, DOMAIN_CASE: kind };
  for (const name of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|COPILOT|GITHUB_TOKEN|GH_TOKEN)/.test(name)) delete env[name];
  const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", "rpc", "--no-session", "-e", probePath], {
    cwd, env, timeout: 20000, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  child.stdin.end(JSON.stringify({ id: "probe", type: "get_entries" }) + "\n");
  assert.deepEqual(await exited, [0, null], stderr);
  const response = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(record => record.id === "probe");
  assert.equal(response?.success, true, stderr || stdout);
  const result = response.data.entries.find(entry => entry.customType === "domain-probe");
  assert.ok(result, stderr || stdout);
  assert.equal(result.data.error, undefined, result.data.stack || result.data.error);
  assert.equal(stderr.trim(), "", stderr);
  return result.data;
}
