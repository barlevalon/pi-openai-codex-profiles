import assert from "node:assert/strict";
import { normalizeContext, type Api, type AssistantMessageEventStream, type ClassifierContext, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Scenario = {
  policy: "missing" | "malformed" | "legacy" | "personal" | "work";
  eligible: boolean;
  credential: "api_key" | "oauth";
};
const chatId = "gpt-5.6-luna";
const transcript = normalizeContext({ messages: [{ role: "user", content: "synthetic scope regression", timestamp: 1700000000000 }] });
const classification: ClassifierContext = {
  state: { fixture: true },
  questions: { allowed: { type: "bool", instructions: "Is fixture true?", criteria: { true: "true", false: "false" } } },
};
const credential: OAuthCredential = { type: "oauth", access: "fixture-copilot-access;proxy-ep=proxy.fixture.invalid", refresh: "fixture-refresh", expires: 4102444800000 };
const sse = () => new Response([
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "fixture-message", role: "assistant", content: [] } },
  { type: "response.content_part.added", item_id: "fixture-message", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, content_index: 0, delta: "scope fixture" },
  { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

export default function (pi: ExtensionAPI) {
  const unexpectedRequests: string[] = [];
  globalThis.fetch = async input => {
    unexpectedRequests.push(String(input));
    throw new Error(`Scope probe blocked unexpected external request ${String(input)}`);
  };
  pi.on("session_start", async (_event, ctx) => {
    const scenario: Scenario = JSON.parse(process.env.PROFILE_SCOPE_SCENARIO!);
    const requests: { operation: string; url: string; authorization: string | null; model: unknown }[] = [];
    const operations: Record<string, unknown> = {};
    const ambientAuthReads: string[] = [];
    let operation = "setup";
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!["fixture.invalid", "api.fixture.invalid"].includes(url.hostname) || url.protocol !== "https:") {
        unexpectedRequests.push(url.href);
        throw new Error(`Scope probe blocked unexpected endpoint ${url.href}`);
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ operation, url: url.href, authorization: new Headers(init?.headers).get("authorization"), model: body?.model });
      if (url.pathname.endsWith("/systemone")) {
        return Response.json({ answers: { allowed: { type: "noul", noul: 0.875 } } });
      }
      assert.ok(url.pathname.endsWith("/responses"), `Unexpected fixture protocol ${url.pathname}`);
      return sse();
    };
    const record = async (name: string, run: () => Promise<unknown>) => {
      operation = name;
      const before = requests.length;
      try { operations[name] = { value: await run(), requests: requests.length - before }; }
      catch (error) { operations[name] = { thrown: error instanceof Error ? error.message : String(error), requests: requests.length - before }; }
    };
    const consume = async (stream: AssistantMessageEventStream) => {
      const events: string[] = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      return { stopReason: result.stopReason, errorMessage: result.errorMessage, content: result.content, usage: result.usage, events };
    };
    try {
      const registry = ctx.modelRegistry;
      const model = registry.find("github-copilot", chatId);
      assert.ok(model, `Missing native chat fixture github-copilot/${chatId}`);
      assert.equal(model.api, "openai-responses", "Fixture must exercise the native Responses protocol");
      const provider = registry.getProvider("github-copilot");
      assert.ok(provider, "Missing registered native provider");
      const classifier = registry.getModelsOfType("classifier", "github-copilot")[0];
      assert.ok(classifier, "SDK must supply a real Copilot classifier");
      assert.ok(provider.classify, "Registered provider must retain native classifier support");
      const coldAvailable = registry.getAvailable().filter(item => item.provider === "github-copilot").map(item => item.id);
      await registry.refresh({ allowNetwork: false });
      const available = registry.getAvailable().filter(item => item.provider === "github-copilot").map(item => item.id);
      const availableChat = (await registry.getAvailableOfType("chat", "github-copilot")).map(item => item.id);
      const availableClassifiers = (await registry.getAvailableOfType("classifier", "github-copilot")).map(item => item.id);
      await record("auth", () => registry.getApiKeyAndHeaders(model));
      const apiKeyAuth = provider.auth.apiKey;
      assert.ok(apiKeyAuth, "Replacement must retain native API-key auth");
      await record("ambient-api-key-auth", () => apiKeyAuth.resolve({
        ctx: { async env(name) { ambientAuthReads.push(name); return "fixture-ambient-key"; }, async fileExists() { return false; } },
        signal: new AbortController().signal,
      }));
      const oauth = provider.auth.oauth;
      assert.ok(oauth, "Replacement must retain native OAuth");
      await record("oauth-to-auth", () => oauth.toAuth(credential));
      const options = { apiKey: "fixture-explicit-key", maxRetries: 0, transport: "sse" as const, fetch: fetchFixture };
      await record("registry-simple", () => consume(registry.streamSimple(model, transcript, { fetch: fetchFixture, maxRetries: 0, transport: "sse" })));
      await record("registry-raw", () => consume(registry.stream(model, transcript, options)));
      await record("native-simple-explicit", () => consume(provider.streamSimple(model, transcript, options)));
      await record("native-raw-explicit", () => consume(provider.stream(model, transcript, options)));
      const forged: Model<Api> = { ...model, provider: "openai-codex:personal" };
      await record("native-forged-provider", () => consume(provider.streamSimple(forged, transcript, options)));
      const stale: Model<Api> = { ...model, id: "stale-copilot-selection" };
      await record("native-stale-selection", () => consume(provider.streamSimple(stale, transcript, options)));
      await record("registry-classifier", () => registry.classify(classifier, classification, { fetch: fetchFixture }));
      await record("native-classifier-explicit", () => provider.classify!(classifier, classification, options));
      pi.appendEntry("profile-scope-result", { scenario, operations, requests, unexpectedRequests, ambientAuthReads, coldAvailable, available, availableChat, availableClassifiers, classifierId: classifier.id });
    } catch (error) {
      pi.appendEntry("profile-scope-result", { scenario, operations, requests, unexpectedRequests, probeError: String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  });
}
