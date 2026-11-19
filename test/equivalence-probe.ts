import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Scenario = {
  review?: boolean; reviewId?: string; reviewError?: boolean; thinking?: ThinkingLevel; direct?: string;
  guards?: boolean; raw?: boolean; registryRaw?: boolean; override?: boolean; absentId?: boolean; stale?: boolean;
  mode?: string; quotaAccounts?: string[]; retries?: number;
};
const codexId = "gpt-5.6-luna";
const reviewId = "claude-sonnet-5.5";
const transcript = normalizeContext({ messages: [{ role: "user", content: "independent offline fixture", timestamp: 1700000000000 }] });
const quota = { type: "error", error: { code: "usage_limit_reached", resets_at: 2100000000 } };
const textEvents = (text: string) => [
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "fixture-message", role: "assistant", content: [] } },
  { type: "response.content_part.added", item_id: "fixture-message", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, content_index: 0, delta: text },
];
const completed = { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } };
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const httpError = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "60" } });

// pi-ai's event stream conditionally stamps elapsed durationMs when the message timestamp
// does not predate stream creation. Its presence and value both depend on clock timing.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const assistant = "role" in value && value.role === "assistant";
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(assistant && key === "durationMs"))
    .map(([key, item]) => [key, assistant && key === "timestamp" ? "<native-message-timestamp>" : normalize(item)]));
}

export default function (pi: ExtensionAPI) {
  const scenario: Scenario = JSON.parse(process.env.CODEX_EQUIVALENCE!);
  let externalFetches = 0;
  globalThis.fetch = async () => {
    externalFetches++;
    throw new Error("Equivalence probe blocked external fetch");
  };
  pi.on("session_start", async (_event, ctx) => {
    const trace: Record<string, unknown> = {};
    const requests: { url: string; account: string; headers: Record<string, string>; body: unknown }[] = [];
    const payloads: unknown[] = [];
    const responses: unknown[] = [];
    const rawEvents: unknown[] = [];
    const events: unknown[] = [];
    const notices: string[] = [];
    const notify = ctx.ui.notify.bind(ctx.ui);
    ctx.ui.notify = (message, type) => { notices.push(message); notify(message, type); };
    const registry = ctx.modelRegistry;
    const find = (provider: string, id: string): Model<Api> => {
      const model = registry.find(provider, id);
      assert.ok(model && model.type === "chat", `Missing fixture chat model ${provider}/${id}`);
      return model;
    };
    try {
      assert.ok(ctx.model, "Native selected model");
      trace.selected = { provider: ctx.model.provider, id: ctx.model.id, thinking: pi.getThinkingLevel() };
      const controller = new AbortController();
      const options: SimpleStreamOptions = {
        transport: "sse", sessionId: "equivalence-session", maxRetries: scenario.retries ?? 0,
        signal: controller.signal, reasoning: scenario.thinking ?? "high",
        headers: { "source-only": "source-secret-fixture" },
        env: { EQUIVALENCE_SOURCE_ONLY: "source-env-fixture" },
        onPayload(payload, model) {
          payloads.push(structuredClone({ provider: model.provider, id: model.id, payload }));
          if (scenario.mode === "payload-hook") throw new Error("fixture payload hook failed");
        },
        onResponse(response, model) {
          responses.push(structuredClone({ provider: model.provider, id: model.id, response }));
          if (scenario.mode === "response-hook") throw new Error("fixture response hook failed");
        },
        onProviderStreamEvent(event, model) {
          rawEvents.push(structuredClone({ provider: model.provider, id: model.id, event }));
          if (event && typeof event === "object" && "type" in event && event.type === "error") {
            if (scenario.mode === "abort") controller.abort();
            if (scenario.mode === "event-hook") throw new Error("fixture event hook failed");
          }
        },
        fetch: async (input, init) => {
          const url = String(input);
          assert.ok(url.startsWith("https://fixture.invalid/") || url.startsWith("https://source.invalid/"), `Unexpected fixture endpoint ${url}`);
          const headers = Object.fromEntries(new Headers(init?.headers));
          const account = headers["chatgpt-account-id"] ?? "copilot";
          requests.push({ url, account, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
          if (account === "copilot") {
            if (scenario.mode !== "copilot-success") return httpError(402, { error: { code: "quota_exceeded", message: "You have no quota" } });
            if (scenario.reviewId === codexId) return sse([...textEvents("copilot fixture"), completed]);
            return new Response([
              { type: "message_start", message: { id: "fixture-message", type: "message", role: "assistant", model: reviewId, content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "copilot fixture" } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
              { type: "message_stop" },
            ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
          }
          if (scenario.reviewError && account === "personal") return httpError(500, { error: { message: "fixture fallback failure" } });
          if (scenario.quotaAccounts?.includes(account)) return sse([quota]);
          if (scenario.mode === "empty") return sse([{ ...completed, response: { ...completed.response, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }]);
          if (account === "work" && scenario.mode) {
            switch (scenario.mode) {
              case "http-quota": case "response-hook": return httpError(429, quota);
              case "rate": return httpError(429, { error: { code: "rate_limit_exceeded", message: "quota exhausted" } });
              case "unauthorized": return httpError(401, { error: { code: "invalid_api_key" } });
              case "partial": return sse([...textEvents("partial fixture"), quota]);
              case "usage": return sse([{ type: "response.failed", response: { error: quota.error, usage: { input_tokens: 3 } } }]);
              case "quota": case "abort": case "event-hook": return sse([quota]);
            }
          }
          return sse([...textEvents("codex fixture"), completed]);
        },
      };
      if (scenario.guards) {
        const model = find("openai-codex:work", codexId);
        const auth = await registry.getApiKeyAndHeaders(model);
        const provider = registry.getProvider(model.provider);
        assert.ok(provider);
        const denied = await provider.streamSimple(model, transcript, { ...options, apiKey: "fixture-denied" }).result();
        trace.guards = { auth, result: denied };
        assert.equal(auth.ok, false);
        assert.equal(denied.stopReason, "error");
        assert.equal(requests.length, 0, "Denied work never reaches transport");
      }
      let model: Model<Api> = scenario.direct ? find(scenario.direct, scenario.direct === "github-copilot" ? reviewId : codexId) : ctx.model;
      if (scenario.stale) model = { ...model, id: "unconfigured-review-id" };
      if (scenario.override) model = { ...model, baseUrl: "https://source.invalid/personal", headers: { ...model.headers, "model-only": "source-model-fixture" } };
      if (scenario.absentId) {
        assert.equal(registry.find(model.provider, "gpt-direct-fixture"), undefined);
        model = { ...model, id: "gpt-direct-fixture" };
      }
      const provider = registry.getProvider(model.provider);
      if (scenario.direct || scenario.stale || scenario.raw) {
        assert.ok(provider);
        if (!scenario.review) {
          const original = find(model.provider, codexId);
          const auth = await registry.getApiKeyAndHeaders(original);
          assert.ok(auth.ok, "Synthetic native auth");
          options.apiKey = scenario.override
            ? `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "personal" }, fixture: "source-only" })).toString("base64url")}.fixture`
            : auth.apiKey;
          options.headers = { ...auth.headers, ...options.headers };
          options.env = { ...auth.env, ...options.env };
        }
      }
      trace.source = { provider: model.provider, id: model.id, baseUrl: model.baseUrl };
      let result: AssistantMessage | undefined;
      try {
        const stream = scenario.registryRaw
          ? registry.stream(model, transcript, { ...options, reasoningEffort: scenario.thinking ?? "high" })
          : scenario.raw
            ? provider!.stream(model, transcript, { ...options, reasoningEffort: scenario.thinking ?? "high" })
          : scenario.direct || scenario.stale
            ? provider!.streamSimple(model, transcript, options)
            : registry.streamSimple(model, transcript, options);
        for await (const event of stream) events.push(structuredClone(event));
        result = await stream.result();
      } catch (error) {
        trace.thrown = error instanceof Error ? error.message : String(error);
      }
      trace.result = result;
    } catch (error) {
      trace.probeError = error instanceof Error ? error.message : String(error);
    }
    pi.appendEntry("codex-equivalence-result", normalize({ ...trace, requests, payloads, responses, rawEvents, events, notices, externalFetches }));
  });
}
