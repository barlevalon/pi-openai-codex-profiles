import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { githubOwner, type WorkScope } from "./policy.ts";

export type RepoScope = "eligible" | "other" | "unknown";

function beneath(path: string, root: string) {
	const part = relative(root, path);
	return part !== "" && !part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part);
}

function eligibleOrigin(url: string, owners: readonly string[]) {
	const match = url.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/);
	const repo = match?.[2].replace(/\.git$/, "");
	return !!match && githubOwner(match[1]) && owners.some(owner => owner.toLowerCase() === match[1].toLowerCase()) && !!repo && repo !== "." && repo !== "..";
}

export function repoScope(cwd: string | undefined, work?: WorkScope): RepoScope {
	if (!cwd) return "unknown";
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const git = (directory: string, args: string[]) => execFileSync("git", ["-C", directory, ...args], {
		env, encoding: "utf8", timeout: 2000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"],
	});
	try {
		const directory = realpathSync(cwd);
		if (git(directory, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return "unknown";
		const checkout = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]).trim());
		let origins: string[] = [];
		try {
			origins = git(directory, ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"]).trim().split("\n");
		} catch (error) {
			if ((error as { status?: number }).status !== 1) return "unknown";
		}
		if (origins.length === 1 && eligibleOrigin(origins[0], work?.githubOwners ?? [])) return "eligible";
		const roots = (work?.roots ?? []).flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
		if (roots.some(root => beneath(checkout, root))) return "eligible";
		if (roots.length === 0) return "other";
		const first = git(directory, ["worktree", "list", "--porcelain", "-z"]).split("\0")[0];
		if (!first.startsWith("worktree ")) return "unknown";
		const listed = realpathSync(first.slice(9));
		const query = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
		const [reportedCheckout, reportedCommon] = git(listed, query).trim().split("\n");
		const primary = realpathSync(reportedCheckout);
		if (!roots.some(root => beneath(primary, root))) return "other";
		const common = realpathSync(git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
		if (realpathSync(reportedCommon) !== common) return "other";
		const [primaryCheckout, primaryCommon] = primary === listed ? [reportedCheckout, reportedCommon] : git(primary, query).trim().split("\n");
		return realpathSync(primaryCheckout) === primary && realpathSync(primaryCommon) === common ? "eligible" : "other";
	} catch {
		return "unknown";
	}
}
