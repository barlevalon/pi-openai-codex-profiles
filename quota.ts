import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type QuotaKey = "work-codex" | "personal-codex" | "copilot-review";
export const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_BODY = 16 * 1024;

export function quotaUntil(key: QuotaKey, payload: unknown, status?: number, retryAfter?: string | null, now = Date.now()): number | undefined {
	if (!payload || typeof payload !== "object") return;
	const data = payload as { type?: string; code?: string; error?: { code?: string; type?: string; resets_at?: number }; response?: { error?: { code?: string; type?: string; resets_at?: number } } };
	const error = data.error ?? data.response?.error ?? (data.type === "error" ? data : undefined);
	if (!error) return;
	const known = key !== "copilot-review"
		? error.code === "usage_limit_reached" || error.type === "usage_limit_reached"
		: status === 402 && error.code === "quota_exceeded";
	if (!known) return;
	const reset = "resets_at" in error ? error.resets_at : undefined;
	if (key !== "copilot-review" && typeof reset === "number" && Number.isFinite(reset) && reset * 1000 > now && reset * 1000 < 8.64e15) return reset * 1000;
	if (retryAfter) {
		const until = /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
		if (Number.isFinite(until) && until > now && until < 8.64e15) return until;
	}
	return now + RETRY_COOLDOWN_MS;
}

export async function quotaResponse(key: QuotaKey, response: Response, signal?: AbortSignal) {
	if (response.ok || (key === "copilot-review" && response.status !== 402)) return;
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
		return quotaUntil(key, JSON.parse(new TextDecoder().decode(bytes)), response.status, response.headers.get("retry-after"));
	} catch {
		return;
	} finally {
		deadline.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}

export function quotaStore(directory: string, warn: (message: string) => void) {
	const memory: Record<QuotaKey, number> = { "work-codex": 0, "personal-codex": 0, "copilot-review": 0 };
	let localCopilotUntil = 0;
	return {
		until(key: QuotaKey): number {
			try {
				let files: string[];
				try { files = readdirSync(directory); } catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return memory[key];
					throw error;
				}
				if (files.length > 4096) throw new Error("Too many quota observations");
				for (const file of files.filter(name => name.startsWith(`${key}.`) && name.endsWith(".json"))) {
					const fd = openSync(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
					try {
						const stat = fstatSync(fd);
						if (!stat.isFile() || stat.size > 256) throw new Error("Invalid quota observation size");
						const body = Buffer.alloc(257);
						const length = readSync(fd, body, 0, body.length, 0);
						if (length > 256) throw new Error("Invalid quota observation size");
						const observation = JSON.parse(body.toString("utf8", 0, length));
						if (observation.version !== 1 || observation.key !== key || !Number.isFinite(observation.until) || observation.until <= 0 || observation.until >= 8.64e15) throw new Error("Invalid quota observation");
						memory[key] = Math.max(memory[key], observation.until);
					} finally { closeSync(fd); }
				}
				return memory[key];
			} catch {
				if (key === "work-codex") return Infinity;
				if (key === "copilot-review" && localCopilotUntil > Date.now()) return localCopilotUntil;
				throw new Error(key === "copilot-review" ? "Cannot read Copilot quota state" : "Cannot read personal Codex quota state");
			}
		},
		observe(key: QuotaKey, until: number) {
			memory[key] = Math.max(memory[key], until);
			if (key === "copilot-review") localCopilotUntil = Math.max(localCopilotUntil, until);
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
