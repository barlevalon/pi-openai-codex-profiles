import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { codexModelId, copilotModelId, type AccountOrder, type CodexModelId, type CopilotModelId } from "./targets.ts";

export type WorkScope = Readonly<{ githubOwners: readonly string[]; roots: readonly string[] }>;

class BoundReview {
	readonly #configuration: Readonly<{ primary: CopilotModelId; fallback: CodexModelId }>;
	private constructor(primary: CopilotModelId, fallback: CodexModelId) {
		this.#configuration = Object.freeze({ primary, fallback });
		Object.freeze(this);
	}
	static configured(primary: CopilotModelId, fallback: CodexModelId) { return new BoundReview(primary, fallback); }
	get primary() { return this.#configuration.primary; }
	get fallback() { return this.#configuration.fallback; }
}
export type ReviewBinding = BoundReview;
export type ReviewAvailability = Readonly<{ kind: "disabled" }> | Readonly<{ kind: "ready"; binding: ReviewBinding }>;

class ParsedPolicy {
	readonly #configuration: Readonly<{ order: AccountOrder; work?: WorkScope; review: ReviewAvailability }>;
	private constructor(order: AccountOrder, work: WorkScope | undefined, review: ReviewAvailability) {
		this.#configuration = Object.freeze({ order: Object.freeze([...order]) as AccountOrder, work, review: Object.freeze({ ...review }) });
		Object.freeze(this);
	}
	static configured(order: AccountOrder, work: WorkScope | undefined, review: ReviewAvailability) { return new ParsedPolicy(order, work, review); }
	get version() { return 1 as const; }
	get accountOrder() { return this.#configuration.order; }
	get work() { return this.#configuration.work; }
	get review() { return this.#configuration.review; }
}
export type Policy = ParsedPolicy;
const PERSONAL_ONLY = ParsedPolicy.configured(["personal"], undefined, { kind: "disabled" });
const MAX_BYTES = 64 * 1024;
export const githubOwner = (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value) && !value.includes("--");

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid policy");
	return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0 && item === item.trim() && !/[\x00-\x1f\x7f]/.test(item))) throw new Error("Invalid policy");
	return value;
}

export function parsePolicy(value: unknown): Policy {
	const data = object(value, ["version", "accountOrder", "work", "review"]);
	const inputOrder = strings(data.accountOrder);
	let order: AccountOrder;
	if (inputOrder.length === 1 && inputOrder[0] === "personal") order = ["personal"];
	else if (inputOrder.length === 2 && inputOrder[0] === "personal" && inputOrder[1] === "work") order = ["personal", "work"];
	else if (inputOrder.length === 2 && inputOrder[0] === "work" && inputOrder[1] === "personal") order = ["work", "personal"];
	else throw new Error("Invalid policy");
	if (data.version !== 1) throw new Error("Invalid policy");
	let work: WorkScope | undefined;
	if (data.work !== undefined) {
		const scope = object(data.work, ["githubOwners", "roots"]);
		const owners = strings(scope.githubOwners === undefined ? [] : scope.githubOwners);
		const roots = strings(scope.roots === undefined ? [] : scope.roots);
		if (owners.some(owner => !githubOwner(owner)) || roots.some(root => !isAbsolute(root) && !root.startsWith("~/"))) throw new Error("Invalid policy");
		work = Object.freeze({ githubOwners: Object.freeze(owners.map(owner => owner.toLowerCase())), roots: Object.freeze(roots.map(root => root.startsWith("~/") ? join(homedir(), root.slice(2)) : root)) });
	}
	if (order.some(account => account === "work") && (!work || work.githubOwners.length + work.roots.length === 0)) throw new Error("Invalid policy");
	let review: ReviewAvailability = { kind: "disabled" };
	if (data.review !== undefined) {
		const models = object(data.review, ["copilotModel", "codexFallbackModel"]);
		const ids = strings([models.copilotModel, models.codexFallbackModel]);
		if (ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))) throw new Error("Invalid policy");
		review = { kind: "ready", binding: BoundReview.configured(copilotModelId(ids[0]), codexModelId(ids[1])) };
	}
	return ParsedPolicy.configured(order, work, review);
}

export function loadPolicy(agentDir: string, notice: (message: string) => void): Policy {
	let fd: number | undefined;
	try {
		try { fd = openSync(join(agentDir, "codex-routing-policy.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return PERSONAL_ONLY; throw error; }
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid policy");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > MAX_BYTES) throw new Error("Invalid policy");
		return parsePolicy(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
	} catch {
		notice("Cannot load Codex routing policy. Using personal only with review disabled.");
		return PERSONAL_ONLY;
	} finally { if (fd !== undefined) closeSync(fd); }
}
