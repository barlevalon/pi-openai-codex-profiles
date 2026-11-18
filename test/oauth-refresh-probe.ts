import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeContext, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { nativeProviders } from "../native-guards.ts";
import { getAgentDir, ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePolicy } from "../policy.ts";
import { createQuotaLedger } from "../quota.ts";
import { PERSONAL, WORK } from "../routing.ts";
import { routingFixture } from "./routing-fixture.ts";

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => { assert.fail("OAuth regression attempted network access"); };
		try {
			const directory = getAgentDir();
			const root = join(directory, "repositories");
			const cwd = join(root, "checkout");
			mkdirSync(cwd, { recursive: true });
			execFileSync("git", ["-C", cwd, "init", "-q"]);
			const authPath = join(directory, "rotation-auth.json");
			const expired: OAuthCredential = { type: "oauth", access: "fixture-old-access", refresh: "fixture-old-refresh", expires: 1 };
			const rotated: OAuthCredential = { type: "oauth", access: "fixture-new-access", refresh: "fixture-new-refresh", expires: Date.now() + 3600000 };
			writeFileSync(authPath, JSON.stringify({ [WORK]: expired }));
			const stored = () => JSON.parse(readFileSync(authPath, "utf8"))[WORK];
			const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
			const registry = new ModelRegistry(runtime);
			let current: ExtensionContext = { ...ctx, cwd, modelRegistry: registry };
			const started = deferred();
			const release = deferred();
			const refreshTokens: string[] = [];
			let conversions = 0;
			let requests = 0;
			const codex = nativeProviders().codex;
			const copilot = nativeProviders().copilot;
			const native: ReturnType<typeof openaiCodexProvider> = {
				...codex,
				auth: { oauth: {
					name: "Synthetic one-use OAuth",
					async login() { assert.fail("OAuth regression attempted login"); },
					async refresh(credential, signal) {
						refreshTokens.push(credential.refresh);
						assert.equal(refreshTokens.length, 1, "Provider rejected reuse of the already rotated refresh token");
						assert.equal(credential.refresh, expired.refresh);
						started.resolve();
						await release.promise;
						signal.throwIfAborted();
						return rotated;
					},
					async toAuth(credential) {
						conversions++;
						assert.equal(current.cwd, cwd, "Work auth conversion ran outside the eligible root");
						return { apiKey: credential.access };
					},
				} },
				stream() { requests++; assert.fail("Denied work request reached the native provider"); },
				streamSimple() { requests++; assert.fail("Denied work request reached the native provider"); },
			};
			const policy = parsePolicy({ version: 1, copilotProfile: "personal", accountOrder: ["work", "personal"], work: { roots: [root] } });
			const routing = routingFixture(native, copilot, () => current, createQuotaLedger(join(directory, "quota"), assert.fail), assert.fail, policy);
			const work = routing.work;
			const personal = routing.personal;
			registry.registerProvider(work);
			registry.registerProvider(personal);
			const model = work.getModels()[0];
			assert.ok(model);
			const kind = process.env.OAUTH_REFRESH_CASE;
			if (kind === "ineligible-start") {
				current = { ...current, cwd: directory };
				const denied = await registry.getApiKeyAndHeaders(model);
				assert.equal(denied.ok, false);
				if (!denied.ok) assert.match(denied.error, /restricted/);
				assert.deepEqual(refreshTokens, [], "Ineligible refresh must not start");
				assert.equal(conversions, 0);
				assert.deepEqual(stored(), expired);
			} else {
				if (kind === "caller-cancel") {
					const controller = new AbortController();
					const pending = runtime.getAuth(WORK, { signal: controller.signal });
					const rejected = assert.rejects(pending, { name: "AbortError" });
					await started.promise;
					controller.abort();
					await rejected;
					current = { ...current, cwd: directory };
					release.resolve();
					await runtime.settleCredentialWrites();
				} else {
					const pending = personal.streamSimple({ ...model, provider: PERSONAL }, normalizeContext({ messages: [] }), { apiKey: "fixture-source" }).result();
					await started.promise;
					current = { ...current, cwd: directory };
					release.resolve();
					const denied = await pending;
					assert.equal(denied.stopReason, "error");
					assert.match(denied.errorMessage!, /restricted/);
				}
				const persistedAfterDenial = stored();
				assert.equal(conversions, 0, "Scope loss denies work auth conversion after refresh");
				const outsideAuth = await registry.getApiKeyAndHeaders(model);
				assert.equal(outsideAuth.ok, false, "Saved credentials do not permit work auth outside the root");
				if (!outsideAuth.ok) assert.match(outsideAuth.error, /restricted/);
				for (const callback of [work.stream, work.streamSimple]) {
					const denied = await callback(model, normalizeContext({ messages: [] }), { apiKey: rotated.access }).result();
					assert.equal(denied.stopReason, "error");
					assert.match(denied.errorMessage!, /restricted/);
				}
				current = { ...current, cwd };
				const next = await registry.getApiKeyAndHeaders(model);
				pi.appendEntry("oauth-refresh-observations", { kind, persistedAfterDenial, refreshTokens, conversions, requests, next });
				assert.deepEqual(persistedAfterDenial, rotated, "Native file storage must retain the only valid rotated refresh token after denied use");
				assert.deepEqual(refreshTokens, [expired.refresh], "Next eligible auth reuses the persisted token without refreshing again");
				assert.equal(next.ok, true);
				if (next.ok) assert.equal(next.apiKey, rotated.access);
				assert.equal(conversions, 1);
			}
			assert.equal(requests, 0);
			pi.appendEntry("oauth-refresh-result", { passed: kind });
		} catch (error) {
			pi.appendEntry("oauth-refresh-result", { error: String(error), stack: error instanceof Error ? error.stack : "" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}
