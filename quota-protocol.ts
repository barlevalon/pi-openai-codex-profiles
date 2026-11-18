import type { ProviderAccount } from "./targets.ts";

export const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TIMESTAMP_MS = 8.64e15;

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value as Record<string, unknown>;
}

function errorEnvelope(payload: unknown): Record<string, unknown> | undefined {
	const envelope = record(payload);
	if (!envelope) return;
	if (envelope.error !== undefined) return record(envelope.error);
	const response = record(envelope.response);
	if (response?.error !== undefined) return record(response.error);
	if (envelope.type === "error") return envelope;
}

function futureTimestamp(milliseconds: number, nowMs: number): boolean {
	return Number.isFinite(milliseconds) && milliseconds > nowMs && milliseconds < MAX_TIMESTAMP_MS;
}

function quotaDeadline(account: ProviderAccount, payload: unknown, status: number | undefined, retryAfter: string | null | undefined, nowMs: number): number | undefined {
	const error = errorEnvelope(payload);
	if (!error) return;
	if (account.credential === "github-copilot") {
		if (status !== 402) return;
		if (error.code !== "quota_exceeded") return;
	} else {
		if (error.code !== "usage_limit_reached" && error.type !== "usage_limit_reached") return;
		if (typeof error.resets_at === "number") {
			const resetMs = error.resets_at * 1000;
			if (futureTimestamp(resetMs, nowMs)) return resetMs;
		}
	}
	if (retryAfter) {
		const numericSeconds = /^\d+(?:\.\d+)?$/.test(retryAfter);
		const retryMs = numericSeconds ? nowMs + Number(retryAfter) * 1000 : Date.parse(retryAfter);
		if (futureTimestamp(retryMs, nowMs)) return retryMs;
	}
	return nowMs + RETRY_COOLDOWN_MS;
}

class ProviderObservation {
	readonly #payload: Readonly<{ account: ProviderAccount; until: number }>;
	private constructor(account: ProviderAccount, until: number) {
		this.#payload = Object.freeze({ account, until });
		Object.freeze(this);
	}
	static decode(account: ProviderAccount, payload: unknown, status?: number, retryAfter?: string | null, nowMs = Date.now()): ProviderObservation | undefined {
		const until = quotaDeadline(account, payload, status, retryAfter, nowMs);
		if (until === undefined) return;
		return new ProviderObservation(account, until);
	}
	static read(observation: ProviderObservation) { return observation.#payload; }
	get account() { return this.#payload.account; }
	get until() { return this.#payload.until; }
}
export type DirectObservation = ProviderObservation;

export function readDirectObservation(observation: DirectObservation) {
	return ProviderObservation.read(observation);
}

export function decodeQuotaPayload(account: ProviderAccount, payload: unknown, status?: number, retryAfter?: string | null, nowMs = Date.now()): DirectObservation | undefined {
	return ProviderObservation.decode(account, payload, status, retryAfter, nowMs);
}

async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<unknown> {
	const reader = response.clone().body?.getReader();
	if (!reader) return;
	const timeout = AbortSignal.timeout(1000);
	const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let rejectRead: (reason: unknown) => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
	const abort = () => rejectRead(deadline.reason);
	deadline.addEventListener("abort", abort, { once: true });
	let lengthBytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		deadline.throwIfAborted();
		while (true) {
			const { done, value } = await Promise.race([reader.read(), cancelled]);
			if (done) break;
			lengthBytes += value.byteLength;
			if (lengthBytes > MAX_BODY_BYTES) return;
			chunks.push(value);
		}
		const bytes = new Uint8Array(lengthBytes);
		let offsetBytes = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offsetBytes);
			offsetBytes += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return;
	} finally {
		deadline.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}

export async function decodeQuotaResponse(account: ProviderAccount, response: Response, signal?: AbortSignal, nowMs = Date.now()): Promise<DirectObservation | undefined> {
	if (response.ok) return;
	if (account.credential === "github-copilot" && response.status !== 402) return;
	const payload = await readBoundedBody(response, signal);
	return ProviderObservation.decode(account, payload, response.status, response.headers.get("retry-after"), nowMs);
}
