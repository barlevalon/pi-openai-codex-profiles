import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { COPILOT_ACCOUNT, PERSONAL_ACCOUNT, WORK_ACCOUNT, codexModelId, copilotModelId } from "./targets.ts";
import type { AccountOrder, CodexAccount, CodexModelId, CopilotModelId } from "./targets.ts";

export type WorkScope = Readonly<{ githubOwners: readonly string[]; roots: readonly string[] }>;
export type Profile =
	| Readonly<{ name: "personal"; accounts: readonly (typeof PERSONAL_ACCOUNT | typeof COPILOT_ACCOUNT)[] }>
	| Readonly<{ name: "work"; criteria: WorkScope; accounts: readonly (typeof WORK_ACCOUNT | typeof COPILOT_ACCOUNT)[] }>;
export type ReviewBinding = Readonly<{ primary: CopilotModelId; fallback: CodexModelId }>;
export type Policy = Readonly<{ profiles: readonly Profile[]; codexOrder: readonly CodexAccount[]; review?: ReviewBinding }>;
const PERSONAL_ONLY: Policy = Object.freeze({
	profiles: Object.freeze([Object.freeze({ name: "personal", accounts: Object.freeze([PERSONAL_ACCOUNT]) })]),
	codexOrder: Object.freeze([PERSONAL_ACCOUNT]),
});
const MAX_POLICY_BYTES = 64 * 1024;
export const githubOwner = (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value) && !value.includes("--");

function policyObject(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${field} contains an unknown field`);
	return value as Record<string, unknown>;
}

function stringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item || item !== item.trim() || /[\x00-\x1f\x7f]/.test(item)) throw new Error(`${field} contains an invalid string`);
		result.push(item);
	}
	return result;
}

function accountOrder(value: unknown): AccountOrder {
	const order = stringList(value, "accountOrder");
	if (order.length === 1 && order[0] === "personal") return ["personal"];
	if (order.length === 2 && order[0] === "personal" && order[1] === "work") return ["personal", "work"];
	if (order.length === 2 && order[0] === "work" && order[1] === "personal") return ["work", "personal"];
	throw new Error("accountOrder must contain personal, optionally with work, without duplicates");
}

function workCriteria(value: unknown): WorkScope {
	const work = policyObject(value, ["githubOwners", "roots"], "work");
	const owners = stringList(work.githubOwners === undefined ? [] : work.githubOwners, "work.githubOwners");
	const roots = stringList(work.roots === undefined ? [] : work.roots, "work.roots");
	if (owners.some(owner => !githubOwner(owner))) throw new Error("work.githubOwners contains an invalid GitHub owner");
	if (roots.some(root => !isAbsolute(root) && !root.startsWith("~/"))) throw new Error("work.roots must contain absolute paths or leading ~/ paths");
	return Object.freeze({
		githubOwners: Object.freeze(owners.map(owner => owner.toLowerCase())),
		roots: Object.freeze(roots.map(root => root.startsWith("~/") ? join(homedir(), root.slice(2)) : root)),
	});
}

function reviewBinding(value: unknown): ReviewBinding {
	const review = policyObject(value, ["copilotModel", "codexFallbackModel"], "review");
	if (typeof review.copilotModel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(review.copilotModel)) throw new Error("review.copilotModel must be an exact native model ID");
	if (typeof review.codexFallbackModel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(review.codexFallbackModel)) throw new Error("review.codexFallbackModel must be an exact native model ID");
	return Object.freeze({ primary: copilotModelId(review.copilotModel), fallback: codexModelId(review.codexFallbackModel) });
}

export function parsePolicy(value: unknown): Policy {
	const data = policyObject(value, ["version", "accountOrder", "work", "review", "copilotProfile"], "policy");
	if (data.version !== 1) throw new Error("version must be 1");
	const order = accountOrder(data.accountOrder);
	if (data.copilotProfile !== undefined && data.copilotProfile !== "personal" && data.copilotProfile !== "work") throw new Error("copilotProfile must be personal or work");
	const work = data.work === undefined ? undefined : workCriteria(data.work);
	const workCodex = order.some(account => account === "work");
	const workCopilot = data.copilotProfile === "work";
	if (workCodex || workCopilot) {
		if (!work || work.githubOwners.length + work.roots.length === 0) throw new Error("work requires nonempty githubOwners or roots for every work-owned account");
	}
	const personalAccounts: (typeof PERSONAL_ACCOUNT | typeof COPILOT_ACCOUNT)[] = [PERSONAL_ACCOUNT];
	if (data.copilotProfile === "personal") personalAccounts.push(COPILOT_ACCOUNT);
	const profiles: Profile[] = [Object.freeze({ name: "personal", accounts: Object.freeze(personalAccounts) })];
	if (work && (workCodex || workCopilot)) {
		const accounts: (typeof WORK_ACCOUNT | typeof COPILOT_ACCOUNT)[] = [];
		if (workCodex) accounts.push(WORK_ACCOUNT);
		if (workCopilot) accounts.push(COPILOT_ACCOUNT);
		profiles.push(Object.freeze({ name: "work", criteria: work, accounts: Object.freeze(accounts) }));
	}
	return Object.freeze({
		profiles: Object.freeze(profiles),
		codexOrder: Object.freeze(order.map(account => account === "personal" ? PERSONAL_ACCOUNT : WORK_ACCOUNT)),
		...(data.review === undefined ? {} : { review: reviewBinding(data.review) }),
	});
}

export function loadPolicy(agentDir: string, notice: (message: string) => void): Policy {
	let fd: number | undefined;
	try {
		try { fd = openSync(join(agentDir, "codex-routing-policy.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return PERSONAL_ONLY;
			throw error;
		}
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) throw new Error("Invalid policy file size");
		const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > MAX_POLICY_BYTES) throw new Error("Invalid policy file size");
		const body = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		return parsePolicy(JSON.parse(body));
	} catch {
		notice("Cannot load Codex routing policy. Using personal only with review disabled.");
		return PERSONAL_ONLY;
	} finally { if (fd !== undefined) closeSync(fd); }
}
