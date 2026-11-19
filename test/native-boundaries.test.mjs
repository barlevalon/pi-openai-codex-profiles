import { fileURLToPath } from "node:url";
import { probeTest } from "./native-probe.mjs";

const probe = fileURLToPath(new URL("./native-boundaries-probe.ts", import.meta.url));
for (const kind of ["review-ownership", "direct-copilot", "http-receipt-scope", "event-receipt-scope", "hook-before-http-quota", "cleanup-failure", "cleanup-scope", "cleanup-awaited", "completed-item", "mutated-completed-item"]) {
  probeTest(`native boundary ${kind}`, kind, undefined, {}, probe);
}
