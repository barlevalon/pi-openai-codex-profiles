import { probeTest } from "./native-probe.mjs";

for (const [kind, name] of [
  ["plans", "eligible targets preserve account order, exact IDs, scope and budget failures"],
  ["authority", "normalized profile membership preserves frozen snapshots and removes legacy lifecycle APIs"],
  ["auth-scope", "requests snapshot repository membership and stop if the working directory changes"],
  ["direct-source", "raw and simple callbacks reuse valid direct sources without synthetic catalog membership"],
]) probeTest(name, kind);
