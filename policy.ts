import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Account = "personal" | "work";
export type WorkScope = Readonly<{ githubOwners: readonly string[]; roots: readonly string[] }>;
export type ReviewPolicy = Readonly<{ copilotModel: string; codexFallbackModel: string }>;
export type RoutingPolicy = Readonly<{ version: 1; accountOrder: readonly Account[]; work?: WorkScope; review?: ReviewPolicy }>;
const PERSONAL_ONLY: RoutingPolicy = Object.freeze({ version: 1, accountOrder: Object.freeze(["personal"] as const) });
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

export function parsePolicy(value: unknown): RoutingPolicy {
	const data = object(value, ["version", "accountOrder", "work", "review"]);
	const order = strings(data.accountOrder);
	if (data.version !== 1 || !order.includes("personal") || order.length > 2 || new Set(order).size !== order.length || order.some(account => account !== "personal" && account !== "work")) throw new Error("Invalid policy");
	let work: WorkScope | undefined;
	if (data.work !== undefined) {
		const scope = object(data.work, ["githubOwners", "roots"]);
		const owners = strings(scope.githubOwners === undefined ? [] : scope.githubOwners);
		const roots = strings(scope.roots === undefined ? [] : scope.roots);
		if (owners.some(owner => !githubOwner(owner)) || roots.some(root => !isAbsolute(root) && !root.startsWith("~/"))) throw new Error("Invalid policy");
		work = Object.freeze({ githubOwners: Object.freeze(owners.map(owner => owner.toLowerCase())), roots: Object.freeze(roots.map(root => root.startsWith("~/") ? join(homedir(), root.slice(2)) : root)) });
	}
	if (order.includes("work") && (!work || work.githubOwners.length + work.roots.length === 0)) throw new Error("Invalid policy");
	let review: ReviewPolicy | undefined;
	if (data.review !== undefined) {
		const models = object(data.review, ["copilotModel", "codexFallbackModel"]);
		const ids = strings([models.copilotModel, models.codexFallbackModel]);
		if (ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))) throw new Error("Invalid policy");
		review = Object.freeze({ copilotModel: ids[0], codexFallbackModel: ids[1] });
	}
	return Object.freeze({ version: 1, accountOrder: Object.freeze([...order] as Account[]), ...(work ? { work } : {}), ...(review ? { review } : {}) });
}

export function loadPolicy(agentDir: string, notice: (message: string) => void): RoutingPolicy {
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
