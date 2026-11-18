import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const args = process.argv.slice(2);
assert.equal(args.length, 4, "Usage: node test/equivalence.mjs --baseline <path> --candidate <path>");
const flags = new Map([[args[0], args[1]], [args[2], args[3]]]);
assert.ok(flags.has("--baseline") && flags.has("--candidate"), "Both checkout paths are required");
const baseline = resolve(flags.get("--baseline"));
const candidate = resolve(flags.get("--candidate"));
const probe = join(dirname(fileURLToPath(import.meta.url)), "equivalence-probe.ts");
const codexId = "gpt-5.6-luna";
const reviewId = "claude-sonnet-5.5";
const personal = "openai-codex:personal";
const work = "openai-codex:work";
const scenarios = [
  { name: "personal default without policy", policy: "missing", accounts: ["personal"] },
  { name: "malformed policy safe default", policy: "malformed", eligible: true, accounts: ["personal"] },
  { name: "personal priority in work scope", eligible: true, order: ["personal", "work"], accounts: ["personal"] },
  { name: "work priority through personal selection", eligible: true, accounts: ["work"] },
  { name: "work selection outside scope and direct guards", alias: work, guards: true, accounts: ["personal"] },
  { name: "work selection inside scope", alias: work, eligible: true, accounts: ["work"] },
  { name: "minimum reasoning normalization", eligible: true, thinking: "minimal", accounts: ["work"] },
  { name: "maximum reasoning", eligible: true, thinking: "max", accounts: ["work"] },
  { name: "empty success never advances", eligible: true, mode: "empty", accounts: ["work"] },
  { name: "structured SSE quota fallback", eligible: true, mode: "quota", accounts: ["work", "personal"] },
  { name: "structured HTTP quota fallback", eligible: true, mode: "http-quota", accounts: ["work", "personal"] },
  { name: "own quota cancellation permits fallback", eligible: true, mode: "quota", retries: 2, accounts: ["work", "personal"] },
  { name: "personal quota fallback to work", eligible: true, order: ["personal", "work"], quotaAccounts: ["personal"], accounts: ["personal", "work"] },
  { name: "last target quota is error not caller abort", quotaAccounts: ["personal"], retries: 2, accounts: ["personal"], stop: "error" },
  { name: "known work cooldown", eligible: true, cool: ["work-codex"], accounts: ["personal"] },
  { name: "known personal cooldown", eligible: true, order: ["personal", "work"], cool: ["personal-codex"], accounts: ["work"] },
  { name: "all targets cooling", eligible: true, cool: ["work-codex", "personal-codex"], accounts: [], stop: "error" },
  { name: "generic rate error never falls back", eligible: true, mode: "rate", accounts: ["work"], stop: "error" },
  { name: "authentication error never falls back", eligible: true, mode: "unauthorized", accounts: ["work"], stop: "error" },
  { name: "partial text commits quota failure", eligible: true, mode: "partial", retries: 2, accounts: ["work"], stop: "error" },
  { name: "raw usage commits quota failure", eligible: true, mode: "usage", accounts: ["work"], stop: "error" },
  { name: "caller abort wins quota", eligible: true, mode: "abort", accounts: ["work"], stop: "aborted" },
  { name: "response hook failure prevents replay", eligible: true, mode: "response-hook", accounts: ["work"], stop: "error" },
  { name: "event hook failure prevents replay", eligible: true, mode: "event-hook", accounts: ["work"], stop: "error" },
  { name: "payload hook failure never sends", eligible: true, mode: "payload-hook", accounts: [], stop: "error" },
  { name: "review exact primary success", review: true, mode: "copilot-success", accounts: ["copilot"] },
  { name: "review exact fallback with factual notice", review: true, accounts: ["copilot", "personal"], notice: true },
  { name: "review failed fallback makes no contribution claim", review: true, reviewError: true, accounts: ["copilot", "personal"], stop: "error" },
  { name: "review scope ordered fallback", review: true, eligible: true, mode: "quota", accounts: ["copilot", "work", "personal"], notice: true },
  { name: "review native same-family primary", review: true, reviewId: codexId, mode: "copilot-success", accounts: ["copilot"] },
  { name: "review runtime capability mismatch", review: true, mismatch: true, accounts: [], stop: "error" },
  { name: "cooling review target still validates capabilities", review: true, mismatch: true, cool: ["copilot-review"], accounts: [], stop: "error" },
  { name: "review rejects stale exact selection", review: true, stale: true, accounts: [], stop: "error" },
  { name: "review raw stream rejected", review: true, raw: true, accounts: [], thrown: "streamSimple" },
  { name: "review registry raw stream rejected", review: true, raw: true, registryRaw: true, accounts: [], stop: "error" },
  { name: "ordinary Copilot remains native", direct: "github-copilot", accounts: ["copilot"], stop: "error" },
  { name: "original builtin Codex remains native", direct: "openai-codex", accounts: ["builtin"] },
  { name: "reused direct source preserves overrides", direct: personal, override: true, accounts: ["personal"] },
  { name: "switched source drops credentials and headers", direct: personal, override: true, eligible: true, accounts: ["work"] },
  { name: "reused direct source absent from native registry", direct: personal, override: true, absentId: true, accounts: ["personal"] },
  { name: "native raw Codex callback", direct: personal, raw: true, accounts: ["personal"] },
];
const token = (account, source = false) => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, ...(source ? { fixture: "source-only" } : {}) })).toString("base64url")}.fixture`;

async function run(checkout, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "codex-equivalence-"));
  const cwd = join(dir, "checkout");
  mkdirSync(cwd);
  const git = (...command) => assert.equal(spawnSync("git", ["-C", cwd, ...command], { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } }).status, 0);
  git("init", "-q");
  git("remote", "add", "origin", `git@github.com:${scenario.eligible ? "example-org" : "personal"}/fixture.git`);
  const fixture = (name, value) => writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  if (scenario.policy !== "missing") fixture("codex-routing-policy.json", scenario.policy === "malformed" ? "{" : {
    version: 1, copilotProfile: "personal", accountOrder: scenario.order ?? ["work", "personal"], work: { githubOwners: ["example-org"] },
    review: { copilotModel: scenario.reviewId ?? reviewId, codexFallbackModel: codexId },
  });
  fixture("auth.json", Object.fromEntries([
    ...["personal", "work", "builtin"].map(account => [account === "builtin" ? "openai-codex" : `openai-codex:${account}`, { type: "oauth", access: token(account), refresh: `fixture-${account}`, expires: 2100000000000 }]),
    ["github-copilot", { type: "api_key", key: "fixture-copilot-key" }],
  ]));
  fixture("settings.json", { retry: { enabled: false }, compaction: { enabled: false } });
  fixture("models.json", { providers: Object.fromEntries([
    ...["personal", "work", "builtin"].map(account => [account === "builtin" ? "openai-codex" : `openai-codex:${account}`, { baseUrl: `https://fixture.invalid/${account}`, headers: { "account-config": account } }]),
    ["github-copilot", { baseUrl: "https://fixture.invalid/copilot", headers: { "account-config": "copilot" }, ...(scenario.mismatch ? { modelOverrides: { [scenario.reviewId ?? reviewId]: { inputLimits: { images: { resize: { maxWidth: 1234 } } } } } } : {}) }],
  ]) });
  if (scenario.cool) {
    mkdirSync(join(dir, "codex-routing"));
    for (const key of scenario.cool) fixture(`codex-routing/${key}.fixture.json`, { version: 1, key, until: 2100000000000 });
  }
  const beforeAuth = readFileSync(join(dir, "auth.json"), "utf8");
  const selected = scenario.review ? `profile-review/${scenario.reviewId ?? reviewId}` : `${scenario.alias ?? personal}/${codexId}`;
  const child = spawn("pi", ["--offline", "--no-mcp", "--no-context-files", "--no-approve", "--no-extensions", "--mode", "rpc", "--no-session", "--thinking", scenario.thinking ?? "high", "--model", selected, "-e", join(checkout, "index.ts"), "-e", probe], {
    cwd, env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, GIT_CONFIG_NOSYSTEM: "1", CODEX_EQUIVALENCE: JSON.stringify(scenario) }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const record = await new Promise((resolveRecord, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout in ${scenario.name}\n${stdout}\n${stderr}`)), 20000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolveRecord(value); };
      child.once("error", error => finish(error));
      child.once("exit", code => finish(new Error(`Pi exited ${code}\n${stdout}\n${stderr}`)));
      let buffer = "";
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.id === "equivalence") {
            const entries = record.data?.entries;
            const result = entries?.find(entry => entry.customType === "codex-equivalence-result");
            if (!record.success || !result) finish(new Error(`Probe failed\n${line}\n${stderr}`));
            else finish(null, result.data);
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: "equivalence", type: "get_entries" }) + "\n");
    });
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), beforeAuth, "Probe modified synthetic credentials");
    assert.equal(record.probeError, undefined, JSON.stringify(record, null, 2));
    assert.equal(record.externalFetches, 0, "External fetch attempted");
    return { ...record, diagnostics: stderr.trim() };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise(resolveExit => child.exitCode !== null || child.signalCode !== null ? resolveExit() : child.once("exit", resolveExit));
    rmSync(dir, { recursive: true, force: true });
  }
}

function contract(scenario, trace) {
  assert.deepEqual(trace.selected, { provider: scenario.review ? "profile-review" : "codex-policy", id: scenario.review ? scenario.reviewId ?? reviewId : codexId, thinking: scenario.thinking ?? "high" });
  assert.deepEqual(trace.requests.map(request => request.account), scenario.accounts, scenario.name);
  for (const entry of trace.payloads.filter(entry => entry.provider.startsWith("openai-codex"))) {
    const thinking = scenario.thinking === "minimal" ? "low" : scenario.thinking ?? "high";
    assert.equal(entry.payload.reasoning.effort, thinking, "Actual payload reasoning");
    assert.equal(entry.id, scenario.absentId ? "gpt-direct-fixture" : codexId, "Exact physical Codex ID");
    assert.equal(entry.payload.model, entry.id);
  }
  if (scenario.thrown) assert.ok(typeof trace.thrown === "string" && trace.thrown.includes(scenario.thrown), scenario.name);
  else {
    assert.equal(trace.result.stopReason, scenario.stop ?? "stop", `${scenario.name}\n${JSON.stringify(trace, null, 2)}`);
    assert.equal(trace.events.filter(event => ["done", "error"].includes(event.type)).length, 1, "Exactly one terminal event");
    if (scenario.mode === "partial") assert.ok(trace.result.content.some(part => part.text === "partial fixture"));
    assert.equal(trace.notices.some(notice => notice.includes("configured Codex fallback")), Boolean(scenario.notice), "Factual fallback notice only when used");
    if (!scenario.stop) {
      const expectedEvents = scenario.mode === "empty"
        ? ["start", "done"]
        : ["start", "text_start", "text_delta", ...(scenario.review && scenario.mode === "copilot-success" && scenario.reviewId !== codexId ? ["text_end"] : []), "done"];
      assert.deepEqual(trace.events.map(event => event.type), expectedEvents);
      assert.equal(trace.result.usage.input, scenario.mode === "empty" ? 0 : 2);
      assert.equal(trace.result.usage.output, scenario.mode === "empty" ? 0 : 3);
      if (scenario.mode === "empty") assert.deepEqual(trace.result.content, []);
      assert.equal(trace.result.model, scenario.absentId ? "gpt-direct-fixture" : scenario.accounts.at(-1) === "copilot" ? scenario.reviewId ?? reviewId : codexId);
    }
  }
  for (const request of trace.requests) {
    if (request.account === "copilot") continue;
    assert.equal(request.headers["account-config"], request.account, "Destination configuration header");
    const reused = scenario.direct === "openai-codex" || scenario.direct === personal && request.account === "personal";
    assert.equal(request.headers.authorization, `Bearer ${token(request.account, reused && scenario.override)}`, "Destination credential");
    assert.equal(request.headers["source-only"], reused ? "source-secret-fixture" : undefined, "Source header isolation");
    assert.equal(request.headers["model-only"], reused && scenario.override ? "source-model-fixture" : undefined, "Source model header isolation");
    assert.ok(request.url.startsWith(reused && scenario.override ? "https://source.invalid/" : `https://fixture.invalid/${request.account}/`), "Semantic request destination");
  }
}

let failed = 0;
let exact = 0;
for (const scenario of scenarios) {
  try {
    const left = await run(baseline, scenario);
    contract(scenario, left);
    const right = await run(candidate, scenario);
    console.log(JSON.stringify({ case: scenario.name, baseline: left, candidate: right }));
    contract(scenario, right);
    if (isDeepStrictEqual(left, right)) {
      exact++;
      console.log(`PASS ${scenario.name}`);
    } else {
      failed++;
      console.error(`DIFFERING TRACE ${scenario.name}\nBASELINE\n${JSON.stringify(left, null, 2)}\nCANDIDATE\n${JSON.stringify(right, null, 2)}`);
    }
  } catch (error) {
    failed++;
    console.error(`FAIL ${scenario.name}\n${error.stack}`);
  }
}
console.log(`${scenarios.length - failed}/${scenarios.length} characterization cases passed, ${exact} exact traces`);
process.exitCode = failed ? 1 : 0;
