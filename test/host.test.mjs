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
    git("remote", "add", "origin", scenario.eligible ? "git@github.com:example-org/fixture.git" : "git@github.com:personal/fixture.git");
  }
  const personalToken = token("personal");
  const workToken = token("work");
  if (!scenario.profile) {
    if (scenario.policy !== "missing") writeFileSync(join(dir, "codex-routing-policy.json"), scenario.policy === "malformed" ? "{" : JSON.stringify(scenario.policy ?? { version: 1, copilotProfile: "work", accountOrder: scenario.order ?? ["work", "personal"], work: { githubOwners: ["example-org"] }, review: { copilotModel: scenario.reviewId ?? "claude-sonnet-5.5", codexFallbackModel: scenario.fallbackId ?? "gpt-5.6-luna" } }));
    if (scenario.projectPolicy) writeFileSync(join(cwd, "codex-routing-policy.json"), JSON.stringify({ version: 1, accountOrder: ["work", "personal"], work: { githubOwners: ["example-org"] } }));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      "openai-codex:personal": { type: "oauth", access: personalToken, refresh: "fake-personal", expires: Date.now() + 86400000 },
      ...(!scenario.noWorkAuth ? { "openai-codex:work": { type: "oauth", access: workToken, refresh: "fake-work", expires: scenario.guard || scenario.expired ? 1 : Date.now() + 86400000 } } : {}),
      ...(!scenario.noCopilotAuth ? { "github-copilot": { type: "api_key", key: "fake-copilot" } } : {}),
    }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 } }));
    const modelOverrides = scenario.reviewTarget ? { modelOverrides: { [scenario.fallbackId ?? "gpt-5.6-luna"]: scenario.capabilities } } : {};
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
      "openai-codex:personal": { baseUrl: scenario.baseUrl ? `${scenario.baseUrl}/personal` : "http://127.0.0.1:1/personal", headers: { "account-config": "personal" }, ...(scenario.reviewTarget === "personal" ? modelOverrides : {}) },
      "openai-codex:work": { baseUrl: scenario.baseUrl ? `${scenario.baseUrl}/work` : "http://127.0.0.1:1/work", headers: { "account-config": "work" }, ...(scenario.reviewTarget === "work" ? modelOverrides : {}) },
      "github-copilot": { baseUrl: scenario.baseUrl ? `${scenario.baseUrl}/copilot` : "http://127.0.0.1:1/copilot", headers: { "account-config": "copilot" }, ...(scenario.mismatch ? { modelOverrides: { "claude-sonnet-5.5": { inputLimits: { images: { resize: { maxWidth: 1234 } } } } } } : {}) },
    } }));
  }
  for (const key of scenario.cool ?? []) {
    mkdirSync(join(dir, "codex-routing"), { recursive: true });
    writeFileSync(join(dir, "codex-routing", `${key}.fixture.json`), JSON.stringify({ version: 1, key, until: Date.now() + 600000 }));
  }
  if (scenario.badState) {
    mkdirSync(join(dir, "codex-routing"));
    writeFileSync(join(dir, "codex-routing", `${scenario.badState}.bad.json`), "{}");
  }
  const env = { ...process.env, PI_CODING_AGENT_DIR: scenario.profile ?? dir, ROUTING_SCENARIO: JSON.stringify({ ...scenario, personalToken, workToken }) };
  for (const name of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|COPILOT|GITHUB_TOKEN|GH_TOKEN)/.test(name)) delete env[name];
  const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", "rpc", "--no-session", "--thinking", scenario.thinking ?? "high", "--model", scenario.review ? `profile-review/${scenario.reviewId ?? "claude-sonnet-5.5"}` : `${scenario.alias ?? "openai-codex:personal"}/gpt-5.6-luna`, "-e", join(root, "index.ts"), "-e", join(root, "test", "host-probe.ts")], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
    const fallbackNotices = records.filter(record => record.method === "notify" && record.message?.includes("configured Codex fallback"));
    assert.equal(fallbackNotices.length, scenario.review && scenario.answer?.startsWith("openai-codex:") && scenario.stop !== "error" ? 1 : 0);
    if (scenario.policy === "malformed") assert.equal(diagnostics.trim(), "Cannot load Codex routing policy. Using personal only with review disabled.");
    else assert.equal(diagnostics.trim(), "", diagnostics);
    return { entries: entries.data.entries, records };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit;
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  { name: "missing policy denies work even in eligible repo", policy: "missing", eligible: true, guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "malformed policy keeps core guards loaded", policy: "malformed", eligible: true, guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "personal-only policy denies work", policy: { version: 1, accountOrder: ["personal"] }, eligible: true, guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "selectors cannot enable work in a personal-only order", policy: { version: 1, accountOrder: ["personal"], work: { githubOwners: ["example-org"] } }, eligible: true, guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "repo-local policy cannot enable work", policy: "missing", projectPolicy: true, eligible: true, guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "policy changes require reload", eligible: true, snapshot: true, mode: "success", expected: ["work"], answer: "openai-codex:work" },
  { name: "personal-first stays personal when eligible", eligible: true, order: ["personal", "work"], mode: "success", expected: ["personal"], answer: "openai-codex:personal" },
  { name: "known personal exhaustion falls back to work in eligible repo", eligible: true, order: ["personal", "work"], personalQuota: true, mode: "success", expected: ["personal", "work"], answer: "openai-codex:work" },
  { name: "personal exhaustion never enables work outside scope", order: ["personal", "work"], personalQuota: true, expected: ["personal"], answer: "openai-codex:personal", stop: "error" },
  { name: "known personal cooldown skips to work", eligible: true, order: ["personal", "work"], cool: ["personal-codex"], mode: "success", expected: ["work"], answer: "openai-codex:work" },
  { name: "personal cooldown outside scope errors before auth", cool: ["personal-codex"], expected: [], answer: "codex-policy", stop: "error" },
  { name: "all account cooldowns error before auth", eligible: true, cool: ["personal-codex", "work-codex"], expected: [], answer: "codex-policy", stop: "error" },
  { name: "corrupt personal state errors without work substitution", eligible: true, badState: "personal-codex", expected: [], answer: "codex-policy", stop: "error" },
  { name: "missing work auth is not quota exhaustion", eligible: true, noWorkAuth: true, expected: [], answer: "codex-policy", stop: "error" },
  { name: "missing review auth is not quota exhaustion", review: true, eligible: true, noCopilotAuth: true, expected: [], answer: "github-copilot", stop: "error" },
  { name: "configured missing primary is an error-only review selection", review: true, eligible: true, reviewId: "not-in-native-catalog", thinking: "off", expected: [], answer: "profile-review", stop: "error" },
  { name: "configured missing fallback never substitutes neighboring model", review: true, eligible: true, fallbackId: "not-in-native-catalog", thinking: "off", expected: [], answer: "profile-review", stop: "error" },
  { name: "runtime capability mismatch blocks review before physical auth", review: true, eligible: true, mismatch: true, expected: [], answer: "profile-review", stop: "error" },
  { name: "review capability mismatch does not break personal core", mismatch: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "configured review catalog advertises compatible shared limits", review: true, eligible: true, catalogOnly: true },
  { name: "another native Copilot ID has a derived review selection", review: true, eligible: true, reviewId: "gpt-5.6-luna", catalogOnly: true },
  { name: "same-family review uses exactly the configured primary", review: true, eligible: true, reviewId: "gpt-5.6-luna", mode: "copilot-ok", expected: ["copilot"], answer: "github-copilot" },
  { name: "same-family review quota uses a factual fallback notice", review: true, order: ["personal"], eligible: true, reviewId: "gpt-5.6-luna", expected: ["copilot", "personal"], answer: "openai-codex:personal" },
  { name: "stale direct review selection is rejected", review: true, eligible: true, staleReview: true, mode: "copilot-ok", expected: ["copilot"], answer: "github-copilot" },
  { name: "all review targets cooling fails before auth", review: true, order: ["personal"], eligible: true, cool: ["copilot-review", "personal-codex"], expected: [], answer: "profile-review", stop: "error" },
  { name: "last Copilot HTTP quota cancellation is error not caller abort", review: true, eligible: true, order: ["personal"], cool: ["personal-codex"], retries: 3, expected: ["copilot"], answer: "github-copilot", stop: "error" },
  { name: "unreadable work state avoids work refresh and uses personal", eligible: true, expired: true, badState: "work-codex", expected: ["personal"], answer: "openai-codex:personal" },
  { name: "malformed Copilot state cannot authorize substitution", review: true, eligible: true, badState: "copilot-review", expected: [], answer: "profile-review", stop: "error" },
  { name: "personal alias uses work first", eligible: true, mode: "success", expected: ["work"], answer: "openai-codex:work" },
  { name: "work alias uses work inside eligible repositories", alias: "openai-codex:work", eligible: true, mode: "success", expected: ["work"], answer: "openai-codex:work" },
  { name: "personal alias stays personal outside eligible repositories", expected: ["personal"], answer: "openai-codex:personal" },
  { name: "minimal thinking survives normalization", eligible: true, mode: "success", thinking: "minimal", wireThinking: "low", expected: ["work"], answer: "openai-codex:work" },
  { name: "maximum thinking survives normalization", eligible: true, mode: "success", thinking: "max", expected: ["work"], answer: "openai-codex:work" },
  { name: "work alias outside eligible repositories normalizes before expired work refresh", alias: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "explicit work in a nonrepository location is personal-only", nonrepo: true, alias: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "model_select normalizes explicit work outside eligible repositories", select: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" },
  { name: "structured SSE quota falls back with host retries disabled", eligible: true, mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "structured HTTP quota falls back with host retries disabled", eligible: true, mode: "http", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "known HTTP quota stops explicit native retries", eligible: true, mode: "http", retries: 3, expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "known SSE quota stops explicit native retries", eligible: true, mode: "quota", retries: 3, expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "last personal SSE quota cancellation is error not caller abort", order: ["personal"], personalQuota: true, retries: 3, expected: ["personal"], answer: "openai-codex:personal", stop: "error" },
  { name: "last personal HTTP quota cancellation is error not caller abort", order: ["personal"], personalQuota: true, mode: "http", retries: 3, expected: ["personal"], answer: "openai-codex:personal", stop: "error" },
  { name: "last available work quota cancellation is error", eligible: true, mode: "quota", cool: ["personal-codex"], retries: 3, expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "quota cancellation on every finite target ends as error", eligible: true, mode: "quota", personalQuota: true, retries: 3, expected: ["work", "personal"], answer: "openai-codex:personal", stop: "error" },
  { name: "caller cancellation wins simultaneous native quota cancellation", eligible: true, mode: "abort", retries: 3, expected: ["work"], answer: "openai-codex:work", stop: "aborted" },
  { name: "raw Codex preserves native options through quota fallback", eligible: true, direct: "openai-codex:personal", raw: true, mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "empty zero-usage success is not a quota failure", eligible: true, mode: "empty", expected: ["work"], answer: "openai-codex:work" },
  { name: "raw usage before failure prevents replay", eligible: true, mode: "raw-usage", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "thinking before failure prevents replay", eligible: true, mode: "thinking", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "tool arguments before failure prevent replay", eligible: true, mode: "tool", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "authentication failure never falls back", eligible: true, mode: "unauthorized", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "generic 429 never falls back", eligible: true, mode: "rate", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "partial output never replays", eligible: true, mode: "partial", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "quota after partial output stays an error with native retries", eligible: true, mode: "partial", retries: 3, expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "quota after thinking stays an error with native retries", eligible: true, mode: "thinking", retries: 3, expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "caller abort wins over quota", eligible: true, mode: "abort", expected: ["work"], answer: "openai-codex:work", stop: "aborted" },
  { name: "HTTP hook failure never falls back", eligible: true, mode: "hook", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "stream hook failure never falls back", eligible: true, mode: "event-hook", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "malformed stream never falls back", eligible: true, mode: "malformed", expected: ["work"], answer: "openai-codex:work", stop: "error" },
  { name: "direct physical personal follows account policy", eligible: true, direct: "openai-codex:personal", mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" },
  { name: "review outside eligible repositories refuses before transport without fallback", review: true, expected: [], answer: "profile-review", stop: "error" },
  { name: "failed Codex review attempt does not claim a fallback contribution", review: true, order: ["personal"], eligible: true, reviewError: true, expected: ["copilot", "personal"], answer: "openai-codex:personal", stop: "error" },
  { name: "review follows Copilot work personal plan", review: true, eligible: true, mode: "quota", expected: ["copilot", "work", "personal"], answer: "openai-codex:personal" },
  { name: "review success keeps Copilot attribution", review: true, eligible: true, lowLevelReview: true, mode: "copilot-ok", expected: ["copilot"], answer: "github-copilot" },
  { name: "ordinary Copilot remains untouched on quota", direct: "github-copilot", eligible: true, expected: ["copilot"], answer: "github-copilot", stop: "error" },
  { name: "review generic 429 never substitutes model family", review: true, eligible: true, mode: "copilot-rate", expected: ["copilot"], answer: "github-copilot", stop: "error" },
];
for (const scenario of cases) test(`host Pi ${scenario.name}`, { timeout: 30000 }, () => host(scenario));

for (const reviewTarget of ["personal", "work"]) {
  test(`host Pi cooling ${reviewTarget} target still validates review capabilities before auth`, { timeout: 30000 }, () => host({
    eligible: true, review: true, reviewTarget, capabilities: { contextWindow: 1024 }, capabilityCheck: true, cool: [`${reviewTarget}-codex`],
  }));
  for (const [capability, capabilities] of Object.entries({
    contextWindow: { contextWindow: 1024 },
    maxTokens: { maxTokens: 16 },
    input: { input: ["text"] },
    thinking: { thinkingLevelMap: { high: null } },
  })) test(`host Pi ${reviewTarget} review target with reduced ${capability} fails before auth`, { timeout: 30000 }, () => host({
    eligible: true, review: true, reviewTarget, capabilities, capabilityCheck: true,
  }));
  for (const [capability, capabilities] of Object.entries({
    stronger: { contextWindow: 2000000, maxTokens: 200000 },
    defaultLimits: { inputLimits: { images: { resize: { maxWidth: 2000 } } } },
  })) test(`host Pi ${reviewTarget} review target with ${capability} capabilities remains usable`, { timeout: 30000 }, () => host({
    eligible: true, review: true, reviewTarget, capabilities, mode: "success", expected: ["copilot", "work"], answer: "openai-codex:work",
  }));
}

test("policy snapshot persists in a running host and a second host loads the rewritten policy", { timeout: 30000 }, async () => {
  await host({ eligible: true, snapshot: true, mode: "success", expected: ["work"], answer: "openai-codex:work" }, async ({ dir }) => {
    await host({ profile: dir, eligible: true, policy: { version: 1, accountOrder: ["personal"] }, guard: true, expected: ["personal"], answer: "openai-codex:personal" });
  });
});

test("stream commitment, event snapshots, scope changes and malformed providers", { timeout: 30000 }, () => host({ eligible: true, synthetic: true }));

test("host Pi child-shaped processes share cooldown but independently resolve cwd", { timeout: 30000 }, async () => {
  await host({ eligible: true, mode: "quota", expected: ["work", "personal"], answer: "openai-codex:personal" }, async ({ dir }) => {
    await host({ profile: dir, eligible: true, mode: "success", expected: ["personal"], answer: "openai-codex:personal" });
    await host({ profile: dir, alias: "openai-codex:work", guard: true, expected: ["personal"], answer: "openai-codex:personal" });
  });
});

test("host Pi review cooldown is shared across child-shaped invocations", { timeout: 30000 }, async () => {
  await host({ review: true, order: ["personal"], eligible: true, expected: ["copilot", "personal"], answer: "openai-codex:personal" }, async ({ dir }) => {
    await host({ profile: dir, review: true, eligible: true, expected: ["personal"], answer: "openai-codex:personal" });
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
    await host({ eligible: true, agent: true, baseUrl: `http://127.0.0.1:${server.address().port}` }, async ({ rpc, records, dir, cwd }) => {
      assert.equal((await rpc("prompt", { message: "local fixture only" })).success, true);
      const end = Date.now() + 10000;
      while (!records.some(record => record.type === "agent_end")) {
        assert.ok(Date.now() < end, JSON.stringify(records));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const result = records.find(record => record.type === "message_end" && record.message.role === "assistant").message;
      assert.equal(result.provider, "openai-codex:personal");
      assert.equal(result.model, "gpt-5.6-luna");
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
      const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--mode", "json", "--print", "--no-session", "--model", "profile-review/claude-sonnet-5.5", "-e", join(root, "index.ts"), "-e", join(root, "test/host-probe.ts"), "--", "local fixture review"], {
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
      assert.match(messages[0].message.content[0].text, /configured Codex fallback/);
      assert.deepEqual(requests.slice(previous).map(request => request.account), [undefined, "personal"]);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
