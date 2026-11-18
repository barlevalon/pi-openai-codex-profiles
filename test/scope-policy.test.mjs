import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repoScope } from "../scope.ts";
import { createQuotaLedger, quotaUntil } from "../quota.ts";
import { codexModelId, copilotModelId } from "../targets.ts";
import { nativeProbe } from "./native-probe.mjs";

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
  assert.equal(quotaUntil("codex", { error: { code: "usage_limit_reached", resets_at: until / 1000 } }), until);
  assert.equal(quotaUntil("codex", { response: { error: { type: "usage_limit_reached", resets_at: until / 1000 } } }), until);
  assert.equal(quotaUntil("codex", { error: { code: "rate_limit_exceeded" } }, 429), undefined);
  const personal = { service: "codex", account: "personal", model: codexModelId("fixture") };
  const work = { ...personal, account: "work" };
  const review = { service: "copilot-review", model: copilotModelId("fixture") };
  const ledger = createQuotaLedger(directory, assert.fail);
  const snapshot = () => ledger.snapshot([personal, work, review], Date.now());
  writeFileSync(join(directory, "personal-codex.fixture.json"), JSON.stringify({ version: 1, key: "personal-codex", until }));
  assert.deepEqual(snapshot(), { personal: { kind: "cooling", until }, work: { kind: "available" }, review: { kind: "available" } });
  writeFileSync(join(directory, "work-codex.fixture.json"), JSON.stringify({ version: 1, key: "work-codex", until: until + 60000 }));
  assert.deepEqual(snapshot().personal, { kind: "cooling", until });
  assert.deepEqual(snapshot().work, { kind: "cooling", until: until + 60000 });
  writeFileSync(join(directory, "personal-codex.bad.json"), "{}");
  assert.equal(snapshot().personal.kind, "unreadable");
});

test("corrupt Copilot state requires an actual in-process observation, not cached disk state", { timeout: 30000 }, async t => {
  await nativeProbe("quota-corruption", fixture(t));
});
