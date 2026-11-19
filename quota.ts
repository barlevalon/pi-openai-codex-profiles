import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readBoundedFile } from "./bounded-file.ts";
import { join } from "node:path";
import type { Budget, BudgetState, ModelTarget } from "./targets.ts";
import { readDirectObservation, type DirectObservation } from "./quota-protocol.ts";

export interface QuotaLedger {
	observeDirect(observation: DirectObservation): void;
	snapshot(candidates: readonly ModelTarget[], nowMs: number): ReadonlyMap<Budget, BudgetState>;
}

const MAX_OBSERVATION_BYTES = 256;
const MAX_OBSERVATION_FILES = 4096;

function storedDeadline(value: unknown, key: Budget): number {
	if (!value || typeof value !== "object") throw new Error("Invalid quota observation");
	if (!("version" in value) || value.version !== 1) throw new Error("Invalid quota observation version");
	if (!("key" in value) || value.key !== key) throw new Error("Invalid quota observation key");
	if (!("until" in value) || typeof value.until !== "number") throw new Error("Invalid quota observation deadline");
	if (value.until <= 0 || Number.isNaN(new Date(value.until).getTime())) throw new Error("Invalid quota observation deadline");
	return value.until;
}

export function createQuotaLedger(directory: string, warn: (message: string) => void): QuotaLedger {
	const local: Record<Budget, number> = { "work-codex": 0, "personal-codex": 0, "copilot-review": 0 };
	const shared: Record<Budget, number> = { "work-codex": 0, "personal-codex": 0, "copilot-review": 0 };

	function read(key: Budget, nowMs: number): BudgetState {
		try {
			let files: string[];
			try { files = readdirSync(directory); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				files = [];
			}
			if (files.length > MAX_OBSERVATION_FILES) throw new Error("Too many quota observations");
			for (const file of files) {
				if (!file.startsWith(`${key}.`) || !file.endsWith(".json")) continue;
				const value: unknown = JSON.parse(readBoundedFile(join(directory, file), MAX_OBSERVATION_BYTES).toString("utf8"));
				shared[key] = Math.max(shared[key], storedDeadline(value, key));
			}
			const until = Math.max(local[key], shared[key]);
			if (until > nowMs) return Object.freeze({ kind: "cooling", until });
			return Object.freeze({ kind: "available" });
		} catch {
			if (key === "copilot-review" && local[key] > nowMs) return Object.freeze({ kind: "cooling", until: local[key] });
			return Object.freeze({ kind: "unreadable" });
		}
	}

	return {
		snapshot(candidates, nowMs) {
			const budgets = new Map<Budget, BudgetState>();
			for (const { account } of candidates) {
				if (!budgets.has(account.budget)) budgets.set(account.budget, read(account.budget, nowMs));
			}
			return budgets;
		},
		observeDirect(observation) {
			const { account, until } = readDirectObservation(observation);
			const key = account.budget;
			local[key] = Math.max(local[key], until);
			try {
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const file = join(directory, `${key}.${randomUUID()}`);
				writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, key, until }), { flag: "wx", mode: 0o600 });
				renameSync(`${file}.tmp`, `${file}.json`);
			} catch {
				warn("Quota cooldown is local to this process. Cannot persist shared quota state.");
			}
		},
	};
}
