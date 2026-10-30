import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/src/core/database";
import { createConnection, resolveAvailableModel } from "@/src/modules/gateway/connections";
import { GatewayError } from "@/src/modules/gateway/errors";
import { runResearch } from "@/src/modules/research/service";
import type { GatewayEvent, GenerateRequest, ProviderAdapter, ProviderModel } from "@/src/modules/gateway/types";
import type { ResearchItem, ResearchSourceInput, ResearchSynthesis } from "@/src/modules/research/types";
import { clearOwnerQuiescenceIfSafe, quiesceOwner } from "@/src/modules/lifecycle/owner-runtime";
import { getTestUser } from "@/tests/helpers";

function createResearchModel(userId: string, options: { status?: string; availability?: string; capability?: string; priced?: boolean } = {}) {
  const connectionId = createConnection(userId, { provider: "openai", label: `Research ${randomUUID()}`, apiKey: "sk-test", baseUrl: "https://models.example" });
  const modelId = `research-${randomUUID()}`;
  const registryModelId = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("UPDATE provider_connections SET status=? WHERE id=?").run(options.status ?? "connected", connectionId);
  getDb().prepare(`INSERT INTO models
    (id,connection_id,provider_model_id,display_name,capabilities_json,availability,input_price_micros_per_million,output_price_micros_per_million,pricing_currency,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(registryModelId, connectionId, modelId, "Research model", JSON.stringify({ structured_output: options.capability ?? "supported", text: "supported", streaming: "supported" }), options.availability ?? "available", options.priced === false ? null : 100, options.priced === false ? null : 200, options.priced === false ? null : "USD", now, now);
  return { connectionId, modelId };
}

function item(label: string): ResearchItem {
  return {
    connector: "web", sourceType: "page", title: `${label} evidence`, canonicalUrl: `https://evidence.example/${label}`,
    publishedAt: "2026-01-02T00:00:00.000Z", retrievedAt: "2026-01-03T00:00:00.000Z",
    text: `${label} climate emissions declined twenty percent after renewable generation increased according to the audited annual dataset.`,
  };
}

function connectorWithFailure(failingValue?: string) {
  return vi.fn(async (input: ResearchSourceInput): Promise<ResearchItem[]> => {
    const value = "url" in input ? input.url : "repository" in input ? input.repository : "query" in input ? input.query : String(input.itemId);
    if (value === failingValue) throw new Error("Connector unavailable for this source.");
    return [item(value.replace(/[^a-z0-9]+/gi, "-").toLowerCase())];
  });
}

function packetFrom(request: GenerateRequest) {
  const content = String(request.messages[1]?.content ?? "");
  return JSON.parse(content.slice(content.indexOf("{"))) as { sources: Array<{ sourceId: string; url: string }> };
}

function mockAdapter(factory: (request: GenerateRequest) => ResearchSynthesis | Error) {
  const calls: GenerateRequest[] = [];
  const adapter: ProviderAdapter = {
    provider: "openai",
    async listModels(): Promise<ProviderModel[]> { return []; },
    async *stream(request: GenerateRequest): AsyncGenerator<GatewayEvent> {
      calls.push(request);
      request.onDispatch?.();
      const result = factory(request);
      if (result instanceof Error) throw result;
      yield { type: "response.started", providerRequestId: "research-request-1" };
      yield { type: "structured_output.completed", value: result };
      yield { type: "usage.updated", usage: { inputTokens: 50, outputTokens: 25, billedCostMicros: 9, currency: "USD" } };
      yield { type: "response.completed", providerRequestId: "research-request-1", usage: { inputTokens: 50, outputTokens: 25, billedCostMicros: 9, currency: "USD" } };
    },
  };
  return { calls, adapterFor: vi.fn(() => adapter) };
}

function synthesisFor(request: GenerateRequest, overrides: Partial<ResearchSynthesis> = {}): ResearchSynthesis {
  const packet = packetFrom(request);
  return {
    executiveSummary: "Renewable generation accompanied lower climate emissions.",
    claims: [{ text: "Climate emissions declined twenty percent after renewable generation increased.", sourceIds: [packet.sources[0]!.sourceId, packet.sources[0]!.sourceId], confidence: "high", uncertainty: "The excerpt does not establish causality." }],
    contradictions: [],
    limitations: ["Only the stored excerpts were evaluated."],
    ...overrides,
  };
}

describe("evidence-aware research synthesis", () => {
  it("persists a successful cited synthesis, dedupes citations, verifies support, and settles usage", async () => {
    const userId = getTestUser();
    const target = createResearchModel(userId);
    const connector = connectorWithFailure();
    const provider = mockAdapter((request) => synthesisFor(request));
    const report = await runResearch({ userId, objective: "Compare emissions evidence", sources: [{ connector: "web", url: "alpha" }], target }, { connector, adapterFor: provider.adapterFor });

    expect(report.status).toBe("synthesized");
    expect(report).toMatchObject({ selectedProvider: "openai", selectedModel: target.modelId, providerRequestId: "research-request-1" });
    expect(() => resolveAvailableModel(randomUUID(), target, "structured_output")).toThrow(/owned/i);
    expect((report.synthesis as ResearchSynthesis).claims[0]!.sourceIds).toHaveLength(1);
    expect(report.verification).toMatchObject({ status: "supported", claims: [{ status: "supported" }] });
    expect(report.usage).toMatchObject({ status: "settled", inputTokens: 50, outputTokens: 25, billedCostMicros: 9 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ toolChoice: "none", responseFormat: { type: "json_schema", strict: true } });
    expect(provider.calls[0]!.tools).toBeUndefined();
    expect(String(provider.calls[0]!.messages[1]!.content)).toContain("untrusted_external");
  });

  it("rejects unknown citations, preserves evidence, and retains completed usage", async () => {
    const userId = getTestUser();
    const target = createResearchModel(userId);
    const provider = mockAdapter((request) => synthesisFor(request, { claims: [{ text: "Climate emissions declined twenty percent.", sourceIds: [randomUUID()], confidence: "low", uncertainty: "Unknown source." }] }));
    const report = await runResearch({ userId, objective: "Reject invented citations", sources: [{ connector: "web", url: "unknown-citation" }], target }, { connector: connectorWithFailure(), adapterFor: provider.adapterFor });

    expect(report.status).toBe("failed_synthesis");
    expect(report.synthesis).toBeNull();
    expect(report.synthesisError).toMatch(/not in this report/i);
    expect(report.verification).toEqual({ status: "rejected", reason: "unknown_citation" });
    expect(report.usage).toMatchObject({ status: "settled" });
    expect((report.sources as unknown[]).length).toBe(1);
    expect(String(report.body)).toContain("unknown-citation");
  });

  it("records weak excerpt support without silently accepting it as verified", async () => {
    const userId = getTestUser();
    const target = createResearchModel(userId);
    const provider = mockAdapter((request) => {
      const packet = packetFrom(request);
      return synthesisFor(request, { claims: [{ text: "Quantum batteries powered an interstellar voyage.", sourceIds: [packet.sources[0]!.sourceId], confidence: "high", uncertainty: "None." }] });
    });
    const report = await runResearch({ userId, objective: "Check support", sources: [{ connector: "web", url: "weak" }], target }, { connector: connectorWithFailure(), adapterFor: provider.adapterFor });
    expect(report.status).toBe("synthesized");
    expect(report.verification).toMatchObject({ status: "has_unsupported_claims", claims: [{ status: "unsupported", citations: [{ supported: false }] }] });
  });

  it("preserves evidence and conservatively accounts when the provider fails after dispatch", async () => {
    const userId = getTestUser();
    const target = createResearchModel(userId);
    const provider = mockAdapter(() => new GatewayError("provider_unavailable", "secret upstream detail", 503, true));
    const report = await runResearch({ userId, objective: "Keep evidence on failure", sources: [{ connector: "web", url: "provider-failure" }], target }, { connector: connectorWithFailure(), adapterFor: provider.adapterFor });
    expect(report.status).toBe("failed_synthesis");
    expect(report.synthesisError).toBe("Provider synthesis failed or returned invalid structured output.");
    expect(report.usage).toMatchObject({ status: "settled" });
    expect((report.sources as unknown[]).length).toBe(1);
  });

  it("keeps evidence, makes no model request, and leaves no reservation when budget admission rejects", async () => {
    const userId = getTestUser();
    const target = createResearchModel(userId);
    const policyId = randomUUID();
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO budget_policies (id,user_id,provider,period,hard_limit_micros,behavior,created_at,updated_at)
      VALUES (?,?,?,'task',0,'stop',?,?)`).run(policyId, userId, "openai", now, now);
    const provider = mockAdapter((request) => synthesisFor(request));
    try {
      const report = await runResearch({ userId, objective: "Respect research budget", sources: [{ connector: "web", url: "budget" }], target }, { connector: connectorWithFailure(), adapterFor: provider.adapterFor });
      expect(report.status).toBe("failed_synthesis");
      expect(report.synthesisError).toMatch(/spending limit/i);
      expect(report.usage).toBeNull();
      expect(provider.calls).toHaveLength(0);
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM usage_records WHERE research_report_id=?").get(report.id)).toEqual({ count: 0 });
    } finally {
      getDb().prepare("DELETE FROM budget_policies WHERE id=?").run(policyId);
    }
  });

  it.each([
    ["disconnected connection", { status: "invalid" }],
    ["unavailable model", { availability: "unavailable" }],
    ["unsupported structured output", { capability: "unsupported" }],
  ])("fails synthesis for %s without dispatching to a model", async (_name, modelOptions) => {
    const userId = getTestUser();
    const target = createResearchModel(userId, modelOptions);
    const provider = mockAdapter((request) => synthesisFor(request));
    const report = await runResearch({ userId, objective: "Enforce model state", sources: [{ connector: "web", url: randomUUID() }], target }, { connector: connectorWithFailure(), adapterFor: provider.adapterFor });
    expect(report.status).toBe("failed_synthesis");
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps successful evidence and connector failure details when retrieval is partial", async () => {
    const userId = getTestUser();
    const report = await runResearch({ userId, objective: "Partial source retrieval", sources: [{ connector: "web", url: "good" }, { connector: "web", url: "bad" }] }, { connector: connectorWithFailure("bad") });
    expect(report.status).toBe("evidence_only");
    expect((report.sources as unknown[]).length).toBe(1);
    expect(report.retrievalErrors).toMatchObject([{ source: { connector: "web", url: "bad" }, message: "Connector unavailable for this source." }]);
  });
});


describe("research metadata and packet byte boundaries", () => {
  it("rejects non-HTTP canonical URLs before persistence or provider dispatch", async () => {
    const userId = getTestUser(); const target = createResearchModel(userId); const provider = mockAdapter((request) => synthesisFor(request));
    const connector = vi.fn(async () => [{ ...item("invalid"), canonicalUrl: "javascript:alert(1)" }]);
    await expect(runResearch({ userId, objective: "reject URL", sources: [{ connector: "web", url: "invalid" }], target }, { connector, adapterFor: provider.adapterFor })).rejects.toThrow(/HTTP or HTTPS/i);
    expect(provider.calls).toHaveLength(0);
  });

  it("bounds titles and final UTF-8 packet bytes before reservation and dispatch", async () => {
    const userId = getTestUser(); const target = createResearchModel(userId); const provider = mockAdapter((request) => synthesisFor(request));
    const connector = vi.fn(async () => Array.from({ length: 40 }, (_, index) => ({ ...item(`large-${index}`), title: "界".repeat(10_000), text: "界".repeat(100_000), canonicalUrl: `https://evidence.example/${index}` })));
    const report = await runResearch({ userId, objective: "bounded UTF-8", sources: [{ connector: "web", url: "large" }], target }, { connector, adapterFor: provider.adapterFor });
    const request = provider.calls[0]!;
    const packetText = String(request.messages[1]!.content).slice(String(request.messages[1]!.content).indexOf("{"));
    expect(Buffer.byteLength(packetText, "utf8")).toBeLessThanOrEqual(48_000);
    const packet = JSON.parse(packetText) as { sources: Array<{ title: string }>; omittedSourceCount: number };
    expect(Buffer.byteLength(packet.sources[0]!.title, "utf8")).toBeLessThanOrEqual(512);
    expect(packet.omittedSourceCount).toBeGreaterThan(0);
    expect(report.status).toBe("synthesized");
  });
});


describe("research admission quiescence", () => {
  it("registers and aborts evidence-only connector work before account cleanup", async () => {
    const userId = getTestUser(); let started!: () => void; const connectorStarted = new Promise<void>((resolve) => { started = resolve; }); let aborted = false;
    const connector = vi.fn((_input: ResearchSourceInput, signal?: AbortSignal) => new Promise<ResearchItem[]>((_resolve, reject) => {
      started();
      signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    }));
    const research = runResearch({ userId, objective: "quiesce retrieval", sources: [{ connector: "web", url: "https://example.test" }] }, { connector });
    await connectorStarted;
    quiesceOwner(userId);
    await expect(research).rejects.toThrow(/aborted|no research sources|quiescence/i);
    expect(aborted).toBe(true);
    expect(clearOwnerQuiescenceIfSafe(userId)).toBe(true);
  });
});


describe("research request cancellation", () => {
  it("propagates the caller signal into evidence-only retrieval before persistence", async () => {
    const userId = getTestUser(); const controller = new AbortController(); let started!: () => void; const connectorStarted = new Promise<void>((resolve) => { started = resolve; }); let observedSignal: AbortSignal | undefined;
    const connector = vi.fn((_input: ResearchSourceInput, signal?: AbortSignal) => new Promise<ResearchItem[]>((_resolve, reject) => {
      observedSignal = signal; started();
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const research = runResearch({ userId, objective: "cancel retrieval", sources: [{ connector: "web", url: "https://example.test" }], signal: controller.signal }, { connector });
    await connectorStarted; controller.abort();
    await expect(research).rejects.toThrow(/aborted|no research sources/i);
    expect(observedSignal?.aborted).toBe(true);
    expect(getDb().prepare("SELECT count(*) AS count FROM research_reports WHERE user_id=? AND title='cancel retrieval'").get(userId)).toEqual({ count: 0 });
  });
});


describe("partial research cancellation fence", () => {
  it("does not persist fulfilled sources or reserve synthesis after another source observes cancellation", async () => {
    const userId = getTestUser(); const target = createResearchModel(userId); const controller = new AbortController(); const provider = mockAdapter((request) => synthesisFor(request));
    let hangingStarted!: () => void; const started = new Promise<void>((resolve) => { hangingStarted = resolve; });
    const connector = vi.fn(async (input: ResearchSourceInput, signal?: AbortSignal): Promise<ResearchItem[]> => {
      if ("url" in input && input.url === "done") return [item("partial-cancel")];
      hangingStarted();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    const research = runResearch({ userId, objective: "partial cancellation", sources: [{ connector: "web", url: "done" }, { connector: "web", url: "wait" }], target, signal: controller.signal }, { connector, adapterFor: provider.adapterFor });
    await started; controller.abort();
    await expect(research).rejects.toBeTruthy();
    expect(provider.calls).toHaveLength(0);
    expect(getDb().prepare("SELECT count(*) AS count FROM research_sources WHERE user_id=? AND canonical_url LIKE '%partial-cancel%'").get(userId)).toEqual({ count: 0 });
    expect(getDb().prepare("SELECT count(*) AS count FROM research_reports WHERE user_id=? AND title='partial cancellation'").get(userId)).toEqual({ count: 0 });
    expect(getDb().prepare("SELECT count(*) AS count FROM usage_records WHERE user_id=? AND model_id=?").get(userId, target.modelId)).toEqual({ count: 0 });
  });
});
