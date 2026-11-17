import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const token = account => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64")}.fake`;

async function host(scenario, check) {
  const dir = mkdtempSync(join(tmpdir(), "routing-host-"));
  const cwd = join(dir, "checkout");
  mkdirSync(cwd);
  const git = (...args) => assert.equal(spawnSync("git", ["-C", cwd, ...args]).status, 0);
  if (!scenario.nonrepo) {
    git("init", "-q");
    git("remote", "add", "origin", scenario.sibp ? "git@github.com:sibp/fixture.git" : "git@github.com:personal/fixture.git");
  }
  const personalToken = token("personal");
  const workToken = token("work");
  if (!scenario.profile) {
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex:personal": { type: "oauth", access: personalToken, refresh: "fake-personal", expires: Date.now() + 86400000 },
    "openai-codex:work": { type: "oauth", access: workToken, refresh: "fake-work", expires: scenario.guard || scenario.expired ? 1 : Date.now() + 86400000 },
    "github-copilot": { type: "api_key", key: "fake-copilot" },
  }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 } }));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
    "openai-codex:personal": { baseUrl: scenario.baseUrl ? `${scenario.baseUrl}/personal` : "http://127.0.0.1:1/personal", headers: { "account-config": "personal" } },
    "openai-codex:work": { baseUrl: scenario.baseUrl ? `${scenario.baseUrl}/work` : "http://127.0.0.1:1/work", headers: { "account-config": "work" } },
    "github-copilot": { baseUrl: scenario.baseUrl ? `${scenario.baseUrl}/copilot` : "http://127.0.0.1:1/copilot", headers: { "account-config": "copilot" } },
  } }));
  }
  if (scenario.badState) {
    mkdirSync(join(dir, "codex-routing"));
    writeFileSync(join(dir, "codex-routing", `${scenario.badState}.bad.json`), "{}");
  }
  const env = { ...process.env, PI_CODING_AGENT_DIR: scenario.profile ?? dir, ROUTING_SCENARIO: JSON.stringify({ ...scenario, personalToken, workToken }) };
  for (const name of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|COPILOT|GITHUB_TOKEN|GH_TOKEN)/.test(name)) delete env[name];
  const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", "rpc", "--no-session", "--thinking", scenario.thinking ?? "high", "--model", scenario.review ? "profile-review/claude-opus-5.5" : `${scenario.alias ?? "openai-codex:personal"}/gpt-6.1-sol`, "-e", join(root, "index.ts"), "-e", join(root, "test", "host-probe.ts")], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  let diagnostics = "";
  let buffer = "";
  let sequence = 0;
  const pending = new Map();
  const records = [];
  child.stderr.on("data", chunk => diagnostics += chunk);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      records.push(record);
      const resolve = pending.get(record.id);
      if (resolve) { pending.delete(record.id); resolve(record); }
    }
  });
  const rpc = (type, data = {}) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => reject(new Error(`Pi RPC timeout ${type}: ${diagnostics}`)), 15000);
    pending.set(id, record => { clearTimeout(timer); resolve(record); });
    child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
  });
  try {
    const entries = await rpc("get_entries");
    assert.equal(entries.success, true, entries.error || diagnostics);
    const error = entries.data.entries.find(entry => entry.customType === "routing-test-error");
    assert.equal(error, undefined, JSON.stringify(error?.data, null, 2));
    assert.ok(entries.data.entries.some(entry => entry.customType === "routing-probe-ready"), diagnostics);
    if (check) await check({ child, rpc, records, entries: entries.data.entries, dir, cwd });
    const diversityNotices = records.filter(record => record.method === "notify" && record.message?.includes("Cross-family review diversity is reduced"));
    assert.equal(diversityNotices.length, scenario.review && scenario.answer?.startsWith("openai-codex:") && scenario.stop !== "error" ? 1 : 0);
    assert.equal(diagnostics.trim(), "", diagnostics);
    return { entries: entries.data.entries, records };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit;
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  { name: "unreadable work state avoids work refresh and uses personal", sibp: true, expired: true, badState: "work-codex", expected: ["personal"], answer: "openai-codex:personal" },
  { name: "malformed Copilot state cannot authorize substitution", review: true, badState: "copilot-review", expected: [], answer: "profile-review", stop: "error" },
  { name: "personal alias uses work first", sibp: true, mode: "success", expected: ["work"], answer: "openai-codex:work" },
  { name: "work alias uses work inside SIBP", alias: "openai-codex:work", sibp: true, mode: "success", expected: ["work"], answer: "openai-codex:work" },
  { name: "personal alias stays personal outside SIBP", expected: ["personal"], answer: "openai-codex:personal" },
  { name: "minimal thinking survives normalization", sibp: true, mode: "success", thinking: "minimal", wireThinking: "low", expected: ["work"], answer: "openai-codex:work" },
  { name: "maximum thinking survives normalization", sibp: true, mode: "success", thinking: "max", expected: ["work"], answer: "openai-codex:work" },
  { name: "work alias outside SIBP normalizes before expired work refresh", alias: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "explicit work in a nonrepository location is personal-only", nonrepo: true, alias: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "model_select normalizes explicit work outside SIBP", select: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "structured SSE quota falls back with host retries disabled", sibp: true, mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "structured HTTP quota falls back with host retries disabled", sibp: true, mode: "http", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "known HTTP quota stops explicit native retries", sibp: true, mode: "http", retries: 3, expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "known SSE quota stops explicit native retries", sibp: true, mode: "quota", retries: 3, expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "empty zero-usage success is not a quota failure", sibp: true, mode: "empty", expected: ["work"], answer: "openai-codex:work" },
  { name: "raw usage before failure prevents replay", sibp: true, mode: "raw-usage", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "thinking before failure prevents replay", sibp: true, mode: "thinking", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "tool arguments before failure prevent replay", sibp: true, mode: "tool", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "authentication failure never falls back", sibp: true, mode: "unauthorized", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "generic 429 never falls back", sibp: true, mode: "rate", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "partial output never replays", sibp: true, mode: "partial", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "caller abort wins over quota", sibp: true, mode: "abort", expected: ["work"], answer: "openai-codex:work", stop: "aborted" },
  { name: "HTTP hook failure never falls back", sibp: true, mode: "hook", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "stream hook failure never falls back", sibp: true, mode: "event-hook", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "malformed stream never falls back", sibp: true, mode: "malformed", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "direct physical personal follows account policy", sibp: true, direct: "openai-codex:personal", mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "review Copilot quota falls back only to personal outside SIBP", review: true, expected: ["copilot", "personal"], answer: "openai-codex:personal" },
  { name: "failed Codex review attempt does not claim a reduced-diversity answer", review: true, reviewError: true, expected: ["copilot", "personal"], answer: "openai-codex:personal", stop: "error" },
  { name: "review follows Copilot work personal plan", review: true, sibp: true, mode: "quota", expected: ["copilot", "work", "personal"], answer: "openai-codex:personal" },
  { name: "review success keeps Copilot attribution", review: true, lowLevelReview: true, mode: "copilot-ok", expected: ["copilot"], answer: "github-copilot" },
  { name: "ordinary Copilot remains untouched on quota", direct: "github-copilot", expected: ["copilot"], answer: "github-copilot", stop: "error" },
  { name: "review generic 429 never substitutes model family", review: true, mode: "copilot-rate", expected: ["copilot"], answer: "github-copilot", stop: "error" },
];
for (const scenario of cases) test(`host Pi ${scenario.name}`, { timeout: 30000 }, () => host(scenario));

test("stream commitment, event snapshots, scope changes and malformed providers", { timeout: 30000 }, () => host({ sibp: true, synthetic: true }));

test("host Pi child-shaped processes share cooldown but independently resolve cwd", { timeout: 30000 }, async () => {
  await host({ sibp: true, mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" }, async ({ dir }) => {
    await host({ profile: dir, sibp: true, mode: "success", expected: ["personal"], answer: "openai-codex:personal" });
    await host({ profile: dir, alias: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" });
  });
});

test("host Pi review cooldown is shared across child-shaped invocations", { timeout: 30000 }, async () => {
  await host({ review: true, expected: ["copilot", "personal"], answer: "openai-codex:personal" }, async ({ dir }) => {
    await host({ profile: dir, review: true, expected: ["personal"], answer: "openai-codex:personal" });
  });
});

test("host Pi actual agent request uses local native auto transport and physical fallback attribution", { timeout: 30000 }, async () => {
  const requests = [];
  const server = createServer((request, response) => {
    if (request.headers.upgrade) { response.writeHead(426); response.end(); return; }
    requests.push({ url: request.url, account: request.headers["chatgpt-account-id"], auth: request.headers.authorization });
    request.resume();
    if (!request.headers["chatgpt-account-id"]) {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "quota_exceeded", message: "You have no quota" } }));
    } else if (request.headers["chatgpt-account-id"] === "work") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 600 } }));
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
        { type: "response.content_part.added", item_id: "m", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "fixture summary" },
        { type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await host({ sibp: true, agent: true, baseUrl: `http://127.0.0.1:${server.address().port}` }, async ({ rpc, records, dir, cwd }) => {
      assert.equal((await rpc("prompt", { message: "local fixture only" })).success, true);
      const end = Date.now() + 10000;
      while (!records.some(record => record.type === "agent_end")) {
        assert.ok(Date.now() < end, JSON.stringify(records));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const result = records.find(record => record.type === "message_end" && record.message.role === "assistant").message;
      assert.equal(result.provider, "openai-codex:personal");
      assert.equal(result.model, "gpt-6.1-sol");
      assert.equal(result.thinkingLevel, "high");
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.deepEqual(requests.map(request => request.account), ["work", "personal"]);
      assert.ok(requests[1].url.startsWith("/personal/"));
      assert.equal((await rpc("get_state")).data.model.provider, "codex-policy");
      const compact = await rpc("compact", { customInstructions: "local fixture summary" });
      assert.equal(compact.success, true, JSON.stringify(compact));
      assert.ok(requests.length > 2, JSON.stringify(compact));
      assert.ok(requests.slice(2).every(request => request.account === "personal"), JSON.stringify(requests));
      const previous = requests.length;
      const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", "json", "--print", "--no-session", "--model", "profile-review/claude-opus-5.5", "-e", join(root, "index.ts"), "-e", join(root, "test/host-probe.ts"), "--", "local fixture review"], {
        cwd, env: { ...process.env, PI_CODING_AGENT_DIR: dir, ROUTING_SCENARIO: JSON.stringify({ agent: true, review: true }) },
        timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      assert.deepEqual(await once(child, "exit"), [0, null], stderr);
      const messages = stdout.trim().split("\n").map(line => JSON.parse(line)).filter(record => record.type === "message_end" && record.message.role === "assistant");
      assert.equal(messages.length, 1, stdout);
      assert.equal(messages[0].message.provider, "openai-codex:personal");
      assert.match(messages[0].message.content[0].text, /Cross-family diversity is reduced/);
      assert.deepEqual(requests.slice(previous).map(request => request.account), [undefined, "personal"]);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
