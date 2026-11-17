import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repoScope } from "../scope.ts";
import { quotaResponse, quotaStore, quotaUntil, RETRY_COOLDOWN_MS } from "../quota.ts";

function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function repo(path, origin) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture", "--allow-empty");
  if (origin) git(path, "remote", "add", "origin", origin);
  return path;
}

test("scope uses actual nearest Git checkout, exact local origin, canonical root and primary worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-scope-"));
  const root = join(dir, "repos", "sibp");
  mkdirSync(root, { recursive: true });
  try {
    assert.equal(repoScope(undefined, root), "unknown");
    assert.equal(repoScope(root, root), "unknown");
    const inside = repo(join(root, "project"));
    const subdir = join(inside, "src");
    mkdirSync(subdir);
    assert.equal(repoScope(subdir, root), "sibp");
    assert.equal(repoScope(repo(join(dir, "sibp-evil")), root), "other");
    const outside = repo(join(dir, "outside"));
    for (const origin of ["https://github.com/sibp/project.git", "git@github.com:sibp/project.git", "ssh://git@github.com/sibp/project"]) {
      git(outside, "config", "--replace-all", "remote.origin.url", origin);
      assert.equal(repoScope(outside, root), "sibp", origin);
    }
    for (const origin of ["https://github.com/sibp-evil/project", "https://github.com.evil/sibp/project", "https://evil@github.com/sibp/project", "https://github.com/sibp/project/more", "https://github.com/sibp/project?x", "https://github.com/sibp/..", "https://github.com/sibp/.git", "https://github.com/other/project"]) {
      git(outside, "config", "--replace-all", "remote.origin.url", origin);
      assert.equal(repoScope(outside, root), "other", origin);
    }
    git(outside, "config", "--replace-all", "remote.origin.url", "https://github.com/sibp/project");
    git(outside, "config", "--add", "remote.origin.url", "https://github.com/other/project");
    assert.equal(repoScope(outside, root), "other", "ambiguous local origin does not qualify");
    const nested = repo(join(outside, "nested"));
    assert.equal(repoScope(nested, root), "other", "nearest repository owns origin");
    symlinkSync(outside, join(root, "alias"));
    assert.equal(repoScope(join(root, "alias"), root), "other");
    const linked = join(dir, "linked");
    git(inside, "worktree", "add", "-qb", "linked", linked);
    assert.equal(repoScope(linked, root), "sibp");
    const separate = join(root, "separate");
    mkdirSync(separate);
    git(separate, "init", "-q", "--separate-git-dir", join(dir, "git-data"));
    git(separate, "config", "core.worktree", separate);
    git(separate, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture", "--allow-empty");
    const separateLinked = join(dir, "separate-linked");
    git(separate, "worktree", "add", "-qb", "separate", separateLinked);
    assert.equal(repoScope(separateLinked, root), "sibp", "primary checkout supports a configured separate Git directory");
    const otherLinked = join(dir, "other-linked");
    git(outside, "worktree", "add", "-qb", "other", otherLinked);
    assert.equal(repoScope(otherLinked, root), "other");
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = join(inside, ".git");
    try { assert.equal(repoScope(outside, root), "other", "GIT_DIR cannot redirect scope"); }
    finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the container itself is not an eligible checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-container-"));
  try {
    const root = repo(join(dir, "sibp"));
    const child = join(root, "not-a-checkout");
    mkdirSync(child);
    assert.equal(repoScope(root, root), "other");
    assert.equal(repoScope(child, root), "other");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("quota body inspection respects cancellation and its read deadline", { timeout: 3000 }, async t => {
  const keepAlive = setTimeout(() => {}, 2500);
  t.after(() => clearTimeout(keepAlive));
  for (const signal of [AbortSignal.timeout(20), undefined]) {
    const response = new Response(new ReadableStream(), { status: 429 });
    assert.equal(await quotaResponse("work-codex", response, signal), undefined);
    void response.body.cancel();
  }
  const oversized = new Response("x".repeat(17000), { status: 429 });
  assert.equal(await quotaResponse("work-codex", oversized), undefined);
});

test("quota requires structured provider evidence and parses only known reset forms", () => {
  const now = Date.now();
  assert.equal(quotaUntil("work-codex", { error: { code: "usage_limit_reached", resets_at: (now + 60000) / 1000 } }, 429, null, now), now + 60000);
  assert.equal(quotaUntil("work-codex", { response: { error: { type: "usage_limit_reached" } } }, undefined, null, now), now + RETRY_COOLDOWN_MS);
  for (const code of ["rate_limit_exceeded", "usage_not_included", "insufficient_quota", "overloaded"]) {
    for (const status of [401, 403, 429, 503]) assert.equal(quotaUntil("work-codex", { error: { code, message: "quota exhausted" } }, status, "60", now), undefined);
  }
  // https://github.com/earendil-works/pi/issues/3643
  // https://github.com/orgs/community/discussions/197813
  const copilot = { error: { message: "You have no quota", code: "quota_exceeded" } };
  assert.equal(quotaUntil("copilot-review", copilot, 402, "120", now), now + 120000);
  const date = new Date(Math.floor(now / 1000) * 1000 + 60000).toUTCString();
  assert.equal(quotaUntil("copilot-review", copilot, 402, date, now), Date.parse(date));
  for (const status of [401, 403, 429, 503]) assert.equal(quotaUntil("copilot-review", copilot, status, null, now), undefined);
});

test("independent processes merge immutable observations by maximum reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-quota-"));
  try {
    const path = join(dir, "state");
    const untils = [Date.now() + 120000, Date.now() + 300000, Date.now() + 60000];
    const script = `import { quotaStore } from ${JSON.stringify(new URL("../quota.ts", import.meta.url).href)}; quotaStore(process.argv[1], console.error).observe('work-codex', Number(process.argv[2]));`;
    const children = untils.map(until => spawn(process.execPath, ["--input-type=module", "-e", script, path, String(until)]));
    assert.deepEqual(await Promise.all(children.map(child => once(child, "exit"))), [[0, null], [0, null], [0, null]]);
    assert.equal(quotaStore(path, assert.fail).until("work-codex"), Math.max(...untils));
    assert.equal(statSync(path).mode & 0o777, 0o700);
    for (const file of readdirSync(path)) {
      assert.equal(statSync(join(path, file)).mode & 0o777, 0o600);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(path, file), "utf8"))).sort(), ["key", "until", "version"]);
    }
    writeFileSync(join(path, "work-codex.bad.json"), "{}");
    assert.equal(quotaStore(path, assert.fail).until("work-codex"), Infinity);
    assert.equal(quotaStore(path, assert.fail).until("copilot-review"), 0);
    writeFileSync(join(path, "copilot-review.bad.json"), "{}");
    assert.throws(() => quotaStore(path, assert.fail).until("copilot-review"), /Cannot read/);
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    const warnings = [];
    const local = quotaStore(blocked, message => warnings.push(message));
    local.observe("copilot-review", Math.max(...untils));
    assert.equal(warnings.length, 1);
    assert.equal(local.until("copilot-review"), Math.max(...untils), "failed persistence retains local quota evidence");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
