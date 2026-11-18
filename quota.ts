import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetOf, type Budget, type BudgetState, type BudgetView, type Target } from "./targets.ts";
import type { DirectQuotaProof } from "./routing.ts";

type StorageKey = "work-codex" | "personal-codex" | "copilot-review";
export type SharedCooldown = Readonly<{ budget: Budget; until: number }>;
export interface QuotaLedger {
	observeDirect(proof: DirectQuotaProof): void;
	snapshot(candidates: readonly Target[], now: number): BudgetView;
}
export const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_BODY = 16 * 1024;

export function quotaUntil(service: Target["service"], payload: unknown, status?: number, retryAfter?: string | null, now = Date.now()): number | undefined {
	if (!payload || typeof payload !== "object") return;
	const data = payload as { type?: string; code?: string; error?: { code?: string; type?: string; resets_at?: number }; response?: { error?: { code?: string; type?: string; resets_at?: number } } };
	const error = data.error ?? data.response?.error ?? (data.type === "error" ? data : undefined);
	if (!error) return;
	const known = service === "codex"
		? error.code === "usage_limit_reached" || error.type === "usage_limit_reached"
		: status === 402 && error.code === "quota_exceeded";
	if (!known) return;
	const reset = "resets_at" in error ? error.resets_at : undefined;
	if (service === "codex" && typeof reset === "number" && Number.isFinite(reset) && reset * 1000 > now && reset * 1000 < 8.64e15) return reset * 1000;
	if (retryAfter) {
		const until = /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
		if (Number.isFinite(until) && until > now && until < 8.64e15) return until;
	}
	return now + RETRY_COOLDOWN_MS;
}

export async function quotaResponse(service: Target["service"], response: Response, signal?: AbortSignal) {
	if (response.ok || (service === "copilot-review" && response.status !== 402)) return;
	const reader = response.clone().body?.getReader();
	if (!reader) return;
	const timeout = AbortSignal.timeout(1000);
	const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let rejectRead: (reason: unknown) => void;
	const cancelled = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
	const abort = () => rejectRead(deadline.reason);
	deadline.addEventListener("abort", abort, { once: true });
	let length = 0;
	const chunks: Uint8Array[] = [];
	try {
		deadline.throwIfAborted();
		while (true) {
			const { done, value } = await Promise.race([reader.read(), cancelled]);
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BODY) return;
			chunks.push(value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		return quotaUntil(service, JSON.parse(new TextDecoder().decode(bytes)), response.status, response.headers.get("retry-after"));
	} catch {
		return;
	} finally {
		deadline.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}

function storageKey(budget: Budget): StorageKey {
	return budget.service === "codex" ? `${budget.account}-codex` : "copilot-review";
}

export function createQuotaLedger(directory: string, warn: (message: string) => void): QuotaLedger {
	return new FileQuotaLedger(directory, warn);
}

class FileQuotaLedger implements QuotaLedger {
	readonly #directory: string;
	readonly #warn: (message: string) => void;
	readonly #local: Record<StorageKey, number> = { "work-codex": 0, "personal-codex": 0, "copilot-review": 0 };
	readonly #shared: Record<StorageKey, number> = { "work-codex": 0, "personal-codex": 0, "copilot-review": 0 };

	constructor(directory: string, warn: (message: string) => void) {
		this.#directory = directory;
		this.#warn = warn;
	}

	snapshot(candidates: readonly Target[], now: number): BudgetView {
		const available = Object.freeze({ kind: "available" } as const);
		const view: { personal: BudgetState; work: BudgetState; review: BudgetState } = { personal: available, work: available, review: available };
		const inspected = new Set<StorageKey>();
		for (const candidate of candidates) {
			const budget = budgetOf(candidate);
			const key = storageKey(budget);
			if (inspected.has(key)) continue;
			inspected.add(key);
			view[budget.service === "codex" ? budget.account : "review"] = this.#read(budget, now);
		}
		return Object.freeze(view);
	}

	#read(budget: Budget, now: number): BudgetState {
		const key = storageKey(budget);
		try {
			let files: string[];
			try { files = readdirSync(this.#directory); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				files = [];
			}
			if (files.length > 4096) throw new Error("Too many quota observations");
			for (const file of files.filter(name => name.startsWith(`${key}.`) && name.endsWith(".json"))) {
				const fd = openSync(join(this.#directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const stat = fstatSync(fd);
					if (!stat.isFile() || stat.size > 256) throw new Error("Invalid quota observation size");
					const body = Buffer.alloc(257);
					const length = readSync(fd, body, 0, body.length, 0);
					if (length > 256) throw new Error("Invalid quota observation size");
					const value: unknown = JSON.parse(body.toString("utf8", 0, length));
					if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("key" in value) || value.key !== key || !("until" in value) || typeof value.until !== "number" || !Number.isFinite(value.until) || value.until <= 0 || value.until >= 8.64e15) throw new Error("Invalid quota observation");
					const observation: SharedCooldown = { budget, until: value.until };
					this.#shared[key] = Math.max(this.#shared[key], observation.until);
				} finally { closeSync(fd); }
			}
			const until = Math.max(this.#local[key], this.#shared[key]);
			return Object.freeze(until > now ? { kind: "cooling", until } : { kind: "available" });
		} catch {
			if (key === "copilot-review" && this.#local[key] > now) return Object.freeze({ kind: "cooling", until: this.#local[key] });
			return Object.freeze({ kind: "unreadable" });
		}
	}

	observeDirect(proof: DirectQuotaProof): void {
		const key = storageKey(budgetOf(proof.target));
		const until = proof.until;
		this.#local[key] = Math.max(this.#local[key], until);
		try {
			mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
			const file = join(this.#directory, `${key}.${randomUUID()}`);
			writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, key, until }), { flag: "wx", mode: 0o600 });
			renameSync(`${file}.tmp`, `${file}.json`);
		} catch {
			this.#warn("Quota cooldown is local to this process. Cannot persist shared quota state.");
		}
	}
}
