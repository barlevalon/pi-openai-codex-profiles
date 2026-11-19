import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "personal" } })).toString("base64url")}.fake`;
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

for (const mode of ["json", "print"]) for (const finish of ["copilot", "length"]) test(`headless ${mode} review discloses Codex contribution when finishing with ${finish}`, { timeout: 25000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "review-notice-"));
  const cwd = join(directory, "checkout");
  mkdirSync(cwd);
  assert.equal(spawnSync("git", ["-C", cwd, "init", "-q"]).status, 0);
  const requests = [];
  let copilotRequests = 0;
  const server = createServer((request, response) => {
    if (request.headers.upgrade) { response.writeHead(426); response.end(); return; }
    request.resume();
    const account = request.headers["chatgpt-account-id"] ?? "copilot";
    requests.push(account);
    if (account === "copilot") {
      copilotRequests++;
      if (copilotRequests === 1) {
        response.writeHead(402, { "content-type": "application/json", "retry-after": "1" });
        response.end(JSON.stringify({ error: { code: "quota_exceeded" } }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse([
          { type: "message_start", message: { id: "final", type: "message", role: "assistant", model: "claude-sonnet-5.5", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "COPILOT-FINAL" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]));
      }
      return;
    }
    assert.equal(account, "personal");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (finish === "length") {
      response.end(sse([
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "TRUNCATED" },
        { type: "response.completed", response: { id: "partial", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ]));
      return;
    }
    const call = { type: "function_call", id: "fc", call_id: "call", name: "bash", arguments: JSON.stringify({ command: "sleep 1.1; printf fixture" }) };
    response.end(sse([
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: call.arguments },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { id: "tool", status: "completed", output: [call], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(directory, "codex-routing-policy.json"), JSON.stringify({ version: 1, copilotProfile: "work", accountOrder: ["personal"], work: { roots: [directory] }, review: { copilotModel: "claude-sonnet-5.5", codexFallbackModel: "gpt-5.6-luna" } }));
  writeFileSync(join(directory, "auth.json"), JSON.stringify({
    "openai-codex:personal": { type: "oauth", access: token, refresh: "fake", expires: Date.now() + 86400000 },
    "github-copilot": { type: "api_key", key: "fake-copilot" },
  }));
  writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: {
    "openai-codex:personal": { baseUrl: `${base}/personal` },
    "github-copilot": { baseUrl: `${base}/copilot` },
  } }));
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", mode === "print" ? "text" : mode, "--print", "--no-session", "--thinking", "high", "--model", "profile-review/claude-sonnet-5.5", "-e", join(root, "index.ts"), "-e", join(root, "test/host-probe.ts"), "--", "local fixture review"], {
    cwd, env: { ...process.env, PI_CODING_AGENT_DIR: directory, ROUTING_SCENARIO: JSON.stringify({ agent: true, review: true }) },
    timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  assert.deepEqual(await exited, [mode === "print" && finish === "length" ? 1 : 0, null], stderr);
  assert.deepEqual(requests, finish === "length" ? ["copilot", "personal"] : ["copilot", "personal", "copilot"]);
  assert.doesNotMatch(stdout, /diversity/i);
  if (mode === "print") {
    assert.match(stdout, /This review used the configured Codex fallback after Copilot quota exhaustion/);
    assert.match(stdout, finish === "length" ? /TRUNCATED/ : /COPILOT-FINAL/);
    return;
  }
  const messages = stdout.trim().split("\n").map(line => JSON.parse(line)).filter(record => record.type === "message_end" && record.message.role === "assistant").map(record => record.message);
  const final = messages.at(-1);
  assert.match(final.content[0].text, /This review used the configured Codex fallback after Copilot quota exhaustion/);
  assert.equal(final.stopReason, finish === "length" ? "length" : "stop");
  assert.equal(final.provider, finish === "length" ? "openai-codex:personal" : "github-copilot");
  if (finish === "copilot") assert.ok(final.content.some(part => part.type === "text" && part.text === "COPILOT-FINAL"));
});
