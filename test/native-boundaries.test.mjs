import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeProbe } from "./native-probe.mjs";

const probe = fileURLToPath(new URL("./native-boundaries-probe.ts", import.meta.url));
for (const kind of ["review-ownership", "direct-copilot", "http-receipt-scope", "event-receipt-scope", "hook-before-http-quota", "cleanup-failure", "cleanup-scope", "cleanup-awaited", "completed-item", "mutated-completed-item"]) {
  test(`native boundary ${kind}`, { timeout: 30000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "codex-boundary-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await nativeProbe(kind, directory, directory, {}, probe);
  });
}
