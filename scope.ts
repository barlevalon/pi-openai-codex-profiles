import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export type RepoScope = "sibp" | "other" | "unknown";

function beneath(path: string, root: string) {
	const part = relative(root, path);
	return part !== "" && !part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part);
}

function sibpOrigin(url: string) {
	const repo = url.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)sibp\/([A-Za-z0-9_.-]+)$/)?.[1].replace(/\.git$/, "");
	return !!repo && repo !== "." && repo !== "..";
}

export function repoScope(cwd: string | undefined, allowedRoot = join(homedir(), "repos", "sibp")): RepoScope {
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
		if (origins.length === 1 && sibpOrigin(origins[0])) return "sibp";
		let root: string;
		try { root = realpathSync(allowedRoot); } catch { return "other"; }
		if (beneath(checkout, root)) return "sibp";
		const first = git(directory, ["worktree", "list", "--porcelain", "-z"]).split("\0")[0];
		if (!first.startsWith("worktree ")) return "unknown";
		const listed = realpathSync(first.slice(9));
		const query = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
		const [reportedCheckout, reportedCommon] = git(listed, query).trim().split("\n");
		const primary = realpathSync(reportedCheckout);
		if (!beneath(primary, root)) return "other";
		const common = realpathSync(git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
		if (realpathSync(reportedCommon) !== common) return "other";
		const [primaryCheckout, primaryCommon] = primary === listed ? [reportedCheckout, reportedCommon] : git(primary, query).trim().split("\n");
		return realpathSync(primaryCheckout) === primary && realpathSync(primaryCommon) === common ? "sibp" : "other";
	} catch {
		return "unknown";
	}
}
