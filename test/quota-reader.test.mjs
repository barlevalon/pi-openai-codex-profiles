import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQuotaLedger } from "../quota.ts";
import { decodeQuotaPayload, decodeQuotaResponse, RETRY_COOLDOWN_MS } from "../quota-protocol.ts";
import { WORK_ACCOUNT, PERSONAL_ACCOUNT, COPILOT_ACCOUNT, codexModelId } from "../targets.ts";

const now = 1700000000000;
const work = { account: WORK_ACCOUNT, modelId: codexModelId("fixture") };
const payload = JSON.stringify({ error: { code: "usage_limit_reached", resets_at: (now + 60000) / 1000 } });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "quota-reader-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "work-codex.fixture.json") };
}

test("short quota reads cannot accept a valid prefix with trailing corruption", t => {
  const { directory, file } = fixture(t);
  const prefix = JSON.stringify({ version: 1, key: "work-codex", until: now + 60000 });
  writeFileSync(file, prefix + " invalid trailing content");
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) =>
    read(fd, buffer, offset, Math.min(length, Buffer.byteLength(prefix)), position));
  syncBuiltinESMExports();
  try {
    assert.deepEqual(createQuotaLedger(directory, assert.fail).snapshot([work], now).get("work-codex"), { kind: "unreadable" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("short quota reads complete valid records and stop at the growth sentinel", t => {
  const { directory, file } = fixture(t);
  const body = JSON.stringify({ version: 1, key: "work-codex", until: now + 60000 });
  const read = fs.readSync;
  const stat = fs.fstatSync;
  let bytesRead = 0;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    const count = read(fd, buffer, offset, Math.min(length, 7), position);
    bytesRead += count;
    return count;
  });
  t.mock.method(fs, "fstatSync", fd => Object.assign(stat(fd), { size: 0 }));
  syncBuiltinESMExports();
  try {
    for (const content of [body, body.padEnd(256)]) {
      writeFileSync(file, content);
      assert.deepEqual(createQuotaLedger(directory, assert.fail).snapshot([work], now).get("work-codex"), { kind: "cooling", until: now + 60000 });
    }
    bytesRead = 0;
    writeFileSync(file, body.padEnd(300));
    assert.deepEqual(createQuotaLedger(directory, assert.fail).snapshot([work], now).get("work-codex"), { kind: "unreadable" });
    assert.equal(bytesRead, 257, "growth after fstat reads only the cap plus one byte");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("stored quotas retain numeric fractions and nonfatal UTF-8 decoding", t => {
  const { directory, file } = fixture(t);
  const until = now + 60000.5;
  const body = JSON.stringify({ version: 1, key: "work-codex", until });
  const snapshot = () => createQuotaLedger(directory, assert.fail).snapshot([work], now).get("work-codex");
  writeFileSync(file, Buffer.concat([Buffer.from(body.slice(0, -1) + ',"note":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  assert.deepEqual(snapshot(), { kind: "cooling", until });
  writeFileSync(file, "\ufeff" + body);
  assert.deepEqual(snapshot(), { kind: "unreadable" }, "stored UTF-8 BOM is not stripped");
  writeFileSync(file, body.padEnd(257));
  assert.deepEqual(snapshot(), { kind: "unreadable" });
});

function responseFromChunks(bytes, chunkSize) {
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      controller.close();
    },
  }), { status: 429 });
}

test("quota body inspection bounds bytes, decodes UTF-8 and preserves the original", async () => {
  const utf8 = JSON.stringify({ error: { code: "usage_limit_reached", note: "€🍠" } });
  for (const [name, bytes, chunkSize, expected] of [
    ["normal", Buffer.from(payload), 4096, now + 60000],
    ["exact cap", Buffer.from(payload.padEnd(16384)), 4096, now + 60000],
    ["oversize", Buffer.from(payload.padEnd(16385)), 4096, undefined],
    ["split UTF-8 and BOM", Buffer.from("\ufeff" + utf8), 1, now + RETRY_COOLDOWN_MS],
    ["nonfatal UTF-8", Buffer.concat([Buffer.from('{"error":{"code":"usage_limit_reached","note":"'), Buffer.from([0xff]), Buffer.from('"}}')]), 8, now + RETRY_COOLDOWN_MS],
    ["malformed", Buffer.from(payload + " junk"), 16, undefined],
    ["empty", Buffer.alloc(0), 1, undefined],
  ]) {
    const response = responseFromChunks(bytes, chunkSize);
    assert.equal((await decodeQuotaResponse(WORK_ACCOUNT, response, undefined, now))?.until, expected, name);
    assert.equal(response.bodyUsed, false, name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, `${name} retains original bytes`);
  }
  assert.equal(await decodeQuotaResponse(WORK_ACCOUNT, new Response(null, { status: 429 }), undefined, now), undefined);
  const failed = new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture read failure")); } }), { status: 429 });
  assert.equal(await decodeQuotaResponse(WORK_ACCOUNT, failed, undefined, now), undefined);
  await assert.rejects(failed.arrayBuffer(), /fixture read failure/);
});

test("quota body inspection obeys cancellation and the inspection deadline", { timeout: 3000 }, async t => {
  const keepAlive = setTimeout(() => {}, 2500);
  t.after(() => clearTimeout(keepAlive));
  const preAborted = new Response(payload, { status: 429 });
  assert.equal(await decodeQuotaResponse(WORK_ACCOUNT, preAborted, AbortSignal.abort(), now), undefined);
  assert.equal(await preAborted.text(), payload);
  for (const signal of [AbortSignal.timeout(20), undefined]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 });
    assert.equal(await decodeQuotaResponse(WORK_ACCOUNT, response, signal, now), undefined);
    assert.equal(response.bodyUsed, false);
    assert.equal(response.body.locked, false);
    await response.body.cancel();
    assert.equal(cancelled, true, "both clone branches release the source after cancellation");
  }
});

test("quota reset validation uses native Date validity without rounding numbers", t => {
  const { directory, file } = fixture(t);
  const last = new Date("+275760-09-13T00:00:00.000Z").getTime();
  const until = resets_at => decodeQuotaPayload(WORK_ACCOUNT, { error: { code: "usage_limit_reached", resets_at } }, 429, "2.5", now)?.until;
  assert.equal(until((now + 60000.5) / 1000), now + 60000.5, "reset takes precedence over Retry-After");
  assert.equal(until(last / 1000), last, "the final native Date millisecond is valid");
  for (const value of [NaN, Infinity, (last + 1) / 1000, now / 1000, String((now + 60000) / 1000)]) {
    assert.equal(until(value), now + 2500, "invalid or nonnumeric resets fall back to Retry-After");
  }
  for (const value of [last, now + 60000.5, last + 1, String(last)]) {
    writeFileSync(file, JSON.stringify({ version: 1, key: "work-codex", until: value }));
    assert.deepEqual(createQuotaLedger(directory, assert.fail).snapshot([work], now).get("work-codex"),
      typeof value === "number" && value <= last ? { kind: "cooling", until: value } : { kind: "unreadable" });
  }
});

test("Retry-After accepts full decimal seconds or a date, not numeric prefixes", () => {
  const error = { error: { code: "usage_limit_reached" } };
  const until = retry => decodeQuotaPayload(PERSONAL_ACCOUNT, error, 429, retry, now)?.until;
  assert.equal(until("0.0005"), now + 0.5);
  assert.equal(until("002.50"), now + 2500);
  for (const retry of ["2.5seconds", "1e3", "Infinity"]) assert.equal(until(retry), now + RETRY_COOLDOWN_MS);
  const date = new Date(now + 60000).toUTCString();
  assert.equal(until(date), now + 60000);
  assert.equal(decodeQuotaPayload(COPILOT_ACCOUNT, { error: { code: "quota_exceeded", resets_at: (now + 60000) / 1000 } }, 402, "2.5", now)?.until, now + 2500);
});
