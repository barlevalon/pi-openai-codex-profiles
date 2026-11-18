import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeProbe } from "./native-probe.mjs";

for (const [kind, name] of [
  ["plans", "eligible targets preserve account order, exact IDs, scope and budget failures"],
  ["authority", "normalized profile membership preserves frozen snapshots and removes legacy lifecycle APIs"],
  ["auth-scope", "work authorization is live across destination auth, native OAuth and canonical-root awaits"],
  ["direct-source", "raw and simple callbacks reuse valid direct sources without synthetic catalog membership"],
]) test(name, { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-domain-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await nativeProbe(kind, directory);
});
