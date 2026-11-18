import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPolicy as readPolicy, parsePolicy } from "../policy.ts";

function policyData(policy) {
  const work = policy.profiles.find(profile => profile.name === "work")?.criteria;
  const copilot = policy.profiles.find(profile => profile.accounts.some(account => account.credential === "github-copilot"));
  return {
    version: 1, accountOrder: policy.codexOrder.map(account => account.credential === "openai-codex:work" ? "work" : "personal"),
    ...(work ? { work } : {}),
    ...(copilot ? { copilotProfile: copilot.name } : {}),
    ...(policy.review ? { review: { copilotModel: policy.review.primary, codexFallbackModel: policy.review.fallback } } : {}),
  };
}
const loadPolicy = (directory, notice) => policyData(readPolicy(directory, notice));

const full = () => ({ version: 1, copilotProfile: "work", accountOrder: ["work", "personal"], work: { githubOwners: ["example-org"], roots: ["~/projects/workspaces"] }, review: { copilotModel: "claude-sonnet-5.5", codexFallbackModel: "gpt-5.6-luna" } });
const safe = { version: 1, accountOrder: ["personal"] };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "routing-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "codex-routing-policy.json") };
}

test("missing policy silently disables work and review", t => {
  const { directory } = fixture(t);
  assert.deepEqual(loadPolicy(directory, assert.fail), safe);
});

test("policy validates both priorities, resolves only leading home roots and freezes every collection", () => {
  for (const order of [["personal"], ["personal", "work"], ["work", "personal"]]) {
    const data = { ...full(), accountOrder: order };
    const policy = parsePolicy(data);
    assert.deepEqual(policyData(policy).accountOrder, order);
    const work = policy.profiles.find(profile => profile.name === "work").criteria;
    assert.deepEqual(work.roots, [join(homedir(), "projects/workspaces")]);
    for (const value of [policy, policy.codexOrder, policy.profiles, ...policy.profiles, ...policy.profiles.map(profile => profile.accounts), work, work.roots, work.githubOwners, policy.review]) assert.ok(Object.isFrozen(value));
    data.accountOrder.push("work");
    data.work.githubOwners[0] = "changed";
    assert.deepEqual(work.githubOwners, ["example-org"]);
  }
  assert.deepEqual(parsePolicy({ version: 1, accountOrder: ["work", "personal"], work: { githubOwners: ["Example-Org"] } }).profiles.find(profile => profile.name === "work").criteria, { githubOwners: ["example-org"], roots: [] });
  assert.deepEqual(parsePolicy({ version: 1, accountOrder: ["personal", "work"], work: { roots: ["/synthetic/$HOME/!literal"] } }).profiles.find(profile => profile.name === "work").criteria, { githubOwners: [], roots: ["/synthetic/$HOME/!literal"] });
});

const invalid = [
  null, [], "policy", {}, { accountOrder: ["personal"] }, { ...safe, version: 2 }, { ...safe, version: Infinity },
  { version: 1 }, { ...safe, accountOrder: null }, { ...safe, accountOrder: [] },
  ...[["work"], ["personal", "personal"], ["work", "personal", "work"], ["personal", "other"], [1], [" personal"]].map(accountOrder => ({ ...full(), accountOrder })),
  { ...safe, endpoint: "https://example.invalid" }, { ...safe, credentials: {} },
  ...[null, [], {}, { githubOwners: [] }, { roots: [] }, { githubOwners: null }, { roots: null }, { githubOwners: "example-org" }, { roots: ["relative"] }, { roots: ["~other/root"] }, { roots: ["~/bad\u0000root"] }, { roots: [""] }, { githubOwners: [""] }, { githubOwners: ["-invalid"] }, { githubOwners: ["invalid-"] }, { githubOwners: ["two--hyphens"] }, { githubOwners: ["not/owner"] }, { githubOwners: ["a".repeat(40)] }, { githubOwners: [4] }, { githubOwners: ["example-org"], include: true }].map(work => ({ ...full(), work })),
  ...[null, [], {}, { copilotModel: "claude-sonnet-5.5" }, { codexFallbackModel: "gpt-5.6-luna" }, { copilotModel: "", codexFallbackModel: "gpt-5.6-luna" }, { copilotModel: " model", codexFallbackModel: "gpt-5.6-luna" }, { copilotModel: "model", codexFallbackModel: false }, { copilotModel: "model", codexFallbackModel: "two ids" }, { ...full().review, headers: {} }].map(review => ({ ...full(), review })),
  ...[
    { ...full().review, copilotModel: "github-copilot/claude-sonnet-5.5" },
    { ...full().review, codexFallbackModel: "openai-codex/gpt-5.6-luna" },
    { ...full().review, copilotModel: "profile-review/claude-sonnet-5.5" },
  ].map(review => ({ ...full(), review })),
];
for (const [index, data] of invalid.entries()) test(`invalid policy ${index} discards all work and review settings`, t => {
  const { directory, file } = fixture(t);
  writeFileSync(file, JSON.stringify(data));
  const notices = [];
  assert.deepEqual(loadPolicy(directory, notice => notices.push(notice)), safe);
  assert.deepEqual(notices, ["Cannot load Codex routing policy. Using personal only with review disabled."]);
});

for (const kind of ["malformed", "oversized", "directory", "symlink", "dangling", "fifo", "unreadable", "invalid-utf8"]) test(`policy ${kind} fails closed without leaking values`, t => {
  const { directory, file } = fixture(t);
  if (kind === "directory") mkdirSync(file);
  else if (kind === "symlink" || kind === "dangling") {
    const target = join(directory, "target");
    if (kind === "symlink") writeFileSync(target, JSON.stringify(full()));
    symlinkSync(target, file);
  } else if (kind === "fifo") execFileSync("mkfifo", [file]);
  else {
    writeFileSync(file, kind === "oversized" ? " ".repeat(65537) : kind === "invalid-utf8" ? Buffer.from([0xff]) : kind === "malformed" ? "private-invalid-value" : JSON.stringify(full()));
    if (kind === "unreadable") chmodSync(file, 0);
  }
  const notices = [];
  assert.deepEqual(loadPolicy(directory, notice => notices.push(notice)), safe);
  assert.equal(notices.length, 1);
  assert.equal(notices[0], "Cannot load Codex routing policy. Using personal only with review disabled.");
});

test("policy accepts exactly 64 KiB but rejects a larger file", t => {
  const { directory, file } = fixture(t);
  const body = JSON.stringify(safe);
  writeFileSync(file, body + " ".repeat(65536 - Buffer.byteLength(body)));
  assert.deepEqual(loadPolicy(directory, assert.fail), safe);
  writeFileSync(file, body + " ".repeat(65537 - Buffer.byteLength(body)));
  const notices = [];
  assert.deepEqual(loadPolicy(directory, notice => notices.push(notice)), safe);
  assert.equal(notices.length, 1);
});

test("short policy reads continue to EOF without accepting a valid prefix", t => {
  const { directory, file } = fixture(t);
  const read = fs.readSync;
  const stat = fs.fstatSync;
  let chunkSize = 7;
  let bytesRead = 0;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    const count = read(fd, buffer, offset, Math.min(length, chunkSize), position);
    bytesRead += count;
    return count;
  });
  t.mock.method(fs, "fstatSync", fd => Object.assign(stat(fd), { size: 0 }));
  syncBuiltinESMExports();
  try {
    const body = JSON.stringify(full());
    writeFileSync(file, body);
    assert.deepEqual(loadPolicy(directory, assert.fail), policyData(parsePolicy(full())));
    chunkSize = Buffer.byteLength(body);
    writeFileSync(file, body + " invalid trailing content");
    const notices = [];
    assert.deepEqual(loadPolicy(directory, message => notices.push(message)), safe);
    assert.equal(notices.length, 1);
    bytesRead = 0;
    writeFileSync(file, body.padEnd(65538, " "));
    assert.deepEqual(loadPolicy(directory, message => notices.push(message)), safe);
    assert.equal(notices.length, 2);
    assert.equal(bytesRead, 65537, "growth after fstat cannot read beyond the policy cap plus one byte");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("policy is profile-local and a snapshot until explicitly loaded again", t => {
  const { directory, file } = fixture(t);
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(join(project, "codex-routing-policy.json"), JSON.stringify(full()));
  assert.deepEqual(loadPolicy(directory, assert.fail), safe);
  writeFileSync(file, JSON.stringify(full()));
  const first = loadPolicy(directory, assert.fail);
  writeFileSync(file, JSON.stringify(safe));
  assert.deepEqual(first.accountOrder, ["work", "personal"]);
  assert.deepEqual(loadPolicy(directory, assert.fail), safe);
});
