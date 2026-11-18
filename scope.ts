import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { githubOwner, type WorkScope } from "./policy.ts";

export type RepoScope = "eligible" | "other" | "unknown";
type Git = (directory: string, args: string[]) => string;

function beneath(path: string, root: string): boolean {
	const part = relative(root, path);
	if (part === "" || part === "..") return false;
	if (part.startsWith(`..${sep}`) || isAbsolute(part)) return false;
	return true;
}

const GITHUB_REMOTE_PREFIXES = ["https://github.com/", "ssh://git@github.com/", "git@github.com:"];

function githubRepositoryOwner(url: string): string | undefined {
	const prefix = GITHUB_REMOTE_PREFIXES.find(candidate => url.startsWith(candidate));
	if (!prefix) return;
	const [owner, repository, extra] = url.slice(prefix.length).split("/");
	if (!owner || !repository || extra !== undefined) return;
	if (owner !== owner.trim() || !githubOwner(owner)) return;
	if (/[^A-Za-z0-9_.-]/.test(repository)) return;
	const name = repository.replace(/\.git$/, "");
	if (!name || name === "." || name === "..") return;
	return owner.toLowerCase();
}

function localOrigins(directory: string, git: Git): string[] {
	try { return git(directory, ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"]).trim().split("\n"); }
	catch (error) {
		if ((error as { status?: number }).status === 1) return [];
		throw error;
	}
}

function checkoutIdentity(directory: string, git: Git) {
	const output = git(directory, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
	const [checkout, common] = output.trim().split("\n");
	if (!checkout || !common) throw new Error("Incomplete Git checkout identity");
	return { checkout: realpathSync(checkout), common: realpathSync(common) };
}

function primaryWorktreeScope(directory: string, roots: readonly string[], git: Git): RepoScope {
	const first = git(directory, ["worktree", "list", "--porcelain", "-z"]).split("\0")[0];
	if (!first.startsWith("worktree ")) return "unknown";
	const listed = realpathSync(first.slice(9));
	const primary = checkoutIdentity(listed, git);
	if (!roots.some(root => beneath(primary.checkout, root))) return "other";
	const common = realpathSync(git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
	if (primary.common !== common) return "other";
	const verified = primary.checkout === listed ? primary : checkoutIdentity(primary.checkout, git);
	if (verified.checkout !== primary.checkout || verified.common !== common) return "other";
	return "eligible";
}

export function repoScope(cwd: string | undefined, work?: WorkScope): RepoScope {
	if (!cwd) return "unknown";
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const git: Git = (directory, args) => execFileSync("git", ["-C", directory, ...args], {
		env, encoding: "utf8", timeout: 2000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"],
	});
	try {
		const directory = realpathSync(cwd);
		if (git(directory, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return "unknown";
		const checkout = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]).trim());
		const origins = localOrigins(directory, git);
		if (origins.length === 1) {
			const owner = githubRepositoryOwner(origins[0]);
			if (owner && work?.githubOwners.some(candidate => candidate.toLowerCase() === owner)) return "eligible";
		}
		const roots: string[] = [];
		for (const root of work?.roots ?? []) {
			try { roots.push(realpathSync(root)); } catch { continue; }
		}
		if (roots.some(root => beneath(checkout, root))) return "eligible";
		if (!roots.length) return "other";
		return primaryWorktreeScope(directory, roots, git);
	} catch {
		return "unknown";
	}
}
