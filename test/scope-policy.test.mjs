import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repoScope } from "../scope.ts";
import { quotaStore, quotaUntil } from "../quota.ts";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "scope-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
function repo(path) { mkdirSync(path, { recursive: true }); git(path, "init", "-q"); return path; }

test("scope has no default selectors and matches exact owners case-insensitively", t => {
  const directory = fixture(t);
  const checkout = repo(join(directory, "checkout"));
  const scope = { githubOwners: ["example-org"], roots: [] };
  git(checkout, "remote", "add", "origin", "git@github.com:Example-Org/fixture.git");
  assert.equal(repoScope(checkout), "other");
  assert.equal(repoScope(checkout, scope), "eligible");
  for (const owner of ["example-org-extra", "example--org", "-example-org"]) {
    git(checkout, "remote", "set-url", "origin", `git@github.com:${owner}/fixture.git`);
    assert.equal(repoScope(checkout, scope), "other");
  }
  git(checkout, "remote", "remove", "origin");
  const include = join(directory, "included-config");
  writeFileSync(include, '[remote "origin"]\nurl = git@github.com:example-org/fixture.git\n');
  git(checkout, "config", "include.path", include);
  assert.equal(repoScope(checkout, scope), "other", "included origin cannot authorize work");
});

test("roots are explicit, independent and canonicalized again for every guard", t => {
  const directory = fixture(t);
  const first = join(directory, "first");
  const second = join(directory, "second");
  const checkout = repo(join(second, "checkout"));
  const missing = join(directory, "missing");
  assert.equal(repoScope(checkout, { githubOwners: [], roots: [missing] }), "other");
  assert.equal(repoScope(checkout, { githubOwners: [], roots: [first, second] }), "eligible");
  const alias = join(directory, "root-alias");
  symlinkSync(second, alias);
  const scope = { githubOwners: [], roots: [alias] };
  assert.equal(repoScope(checkout, scope), "eligible");
  mkdirSync(first);
  unlinkSync(alias);
  symlinkSync(first, alias);
  assert.equal(repoScope(checkout, scope), "other");
  const later = repo(join(missing, "later"));
  assert.equal(repoScope(later, { githubOwners: [], roots: [missing] }), "eligible");
});

test("personal and work quota classifiers share evidence but not budgets", t => {
  const directory = fixture(t);
  const until = Date.now() + 600000;
  for (const key of ["personal-codex", "work-codex"]) {
    assert.equal(quotaUntil(key, { error: { code: "usage_limit_reached", resets_at: until / 1000 } }), until);
    assert.equal(quotaUntil(key, { response: { error: { type: "usage_limit_reached", resets_at: until / 1000 } } }), until);
    assert.equal(quotaUntil(key, { error: { code: "rate_limit_exceeded" } }, 429), undefined);
  }
  const store = quotaStore(directory, assert.fail);
  store.observe("personal-codex", until);
  assert.equal(store.until("personal-codex"), until);
  assert.equal(store.until("work-codex"), 0);
  assert.equal(store.until("copilot-review"), 0);
  store.observe("work-codex", until + 60000);
  assert.equal(store.until("personal-codex"), until);
  assert.equal(store.until("work-codex"), until + 60000);
  writeFileSync(join(directory, "personal-codex.bad.json"), "{}");
  assert.throws(() => store.until("personal-codex"), /Cannot read personal/);
});

test("corrupt Copilot state requires an actual in-process observation, not cached disk state", t => {
  const directory = fixture(t);
  const until = Date.now() + 600000;
  quotaStore(directory, assert.fail).observe("copilot-review", until);
  const reader = quotaStore(directory, assert.fail);
  assert.equal(reader.until("copilot-review"), until);
  writeFileSync(join(directory, "copilot-review.bad.json"), "{}");
  assert.throws(() => reader.until("copilot-review"), /Cannot read Copilot/);
  reader.observe("copilot-review", until + 60000);
  assert.equal(reader.until("copilot-review"), until + 60000);
});
