import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import { createAgentRun, listAgents } from "@/src/modules/agents/service";
import { createConnection, validateConnection } from "@/src/modules/gateway/connections";
import { streamChat } from "@/src/modules/workspace/chat";
import { disconnectProvider } from "@/src/modules/lifecycle/service";
import { createProject } from "@/src/modules/workspace/service";

const modelResponse = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id, name: id })) }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("gateway connection validation", () => {
  it("reconciles discovery snapshots, preserves operator pricing, and disables every model on failure", async () => {
    const userId = getTestUser();
    const connectionId = createConnection(userId, { provider: "openai", label: `Snapshot ${crypto.randomUUID()}`, apiKey: "sk-test" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelResponse("model-a", "model-b")));

    await expect(validateConnection(userId, connectionId)).resolves.toBe(2);
    const db = getDb();
    db.prepare(`UPDATE models SET input_price_micros_per_million=11, output_price_micros_per_million=22,
      pricing_currency='USD', metadata_source='user_evidence:https://pricing.example' WHERE connection_id=? AND provider_model_id='model-a'`).run(connectionId);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelResponse("model-a")));
    await expect(validateConnection(userId, connectionId)).resolves.toBe(1);

    const afterSnapshot = db.prepare(`SELECT provider_model_id AS modelId, availability,
      input_price_micros_per_million AS inputPrice, output_price_micros_per_million AS outputPrice,
      pricing_currency AS currency, metadata_source AS metadataSource
      FROM models WHERE connection_id=? ORDER BY provider_model_id`).all(connectionId) as Array<Record<string, unknown>>;
    expect(afterSnapshot).toEqual([
      { modelId: "model-a", availability: "available", inputPrice: 11, outputPrice: 22, currency: "USD", metadataSource: "user_evidence:https://pricing.example" },
      { modelId: "model-b", availability: "unavailable", inputPrice: null, outputPrice: null, currency: null, metadataSource: "provider_api" },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    await expect(validateConnection(userId, connectionId)).rejects.toMatchObject({ code: "authentication_failed" });
    expect(db.prepare("SELECT status FROM provider_connections WHERE id=?").get(connectionId)).toEqual({ status: "invalid" });
    const availability = db.prepare("SELECT DISTINCT availability FROM models WHERE connection_id=?").all(connectionId);
    expect(availability).toEqual([{ availability: "unavailable" }]);
  });

  it("requires a connected connection as well as an available model for chat and run selection", () => {
    const userId = getTestUser();
    const projectId = createProject(userId, `Gateway selection ${crypto.randomUUID()}`);
    const connectionId = createConnection(userId, { provider: "openai", label: `Disconnected ${crypto.randomUUID()}`, apiKey: "sk-test" });
    const modelId = `model-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at)
      VALUES (?,?,?,?,?,'available',?,?)`).run(crypto.randomUUID(), connectionId, modelId, "Disconnected model", '{"text":"supported"}', now, now);
    db.prepare("UPDATE provider_connections SET status='invalid' WHERE id=?").run(connectionId);

    expect(() => streamChat({
      userId,
      projectId,
      prompt: "Hello",
      mode: "single",
      targets: [{ connectionId, modelId }],
    })).toThrow(/not available/i);

    const agentId = String(listAgents(userId)[0]!.id);
    expect(() => createAgentRun({
      userId,
      projectId,
      goal: "Use only a connected model",
      mode: "team",
      agentIds: [agentId],
      targets: [{ connectionId, modelId }],
    })).toThrow(/not available/i);
  });
});


describe("provider validation generation fencing", () => {
  it("does not let a stale validation restore a disconnected credential", async () => {
    const userId = getTestUser();
    const connectionId = createConnection(userId, { provider: "openai", label: `Fence ${crypto.randomUUID()}`, apiKey: "sk-test" });
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const validating = validateConnection(userId, connectionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnectProvider(userId, connectionId)).toMatchObject({ disconnected: true, credentialDeleted: true });
    release(modelResponse("stale-model"));
    await expect(validating).rejects.toThrow(/superseded/i);
    expect(getDb().prepare("SELECT status,encrypted_credential AS credential FROM provider_connections WHERE id=?").get(connectionId)).toEqual({ status: "disconnected", credential: null });
    expect(getDb().prepare("SELECT count(*) AS count FROM models WHERE connection_id=? AND availability='available'").get(connectionId)).toEqual({ count: 0 });
  });

  it("lets the newest overlapping validation snapshot win", async () => {
    const userId = getTestUser();
    const connectionId = createConnection(userId, { provider: "openai", label: `Generation ${crypto.randomUUID()}`, apiKey: "sk-test" });
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); })));
    const first = validateConnection(userId, connectionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = validateConnection(userId, connectionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers[1]!(modelResponse("new-model"));
    await expect(second).resolves.toBe(1);
    resolvers[0]!(modelResponse("old-model"));
    await expect(first).rejects.toThrow(/superseded/i);
    expect(getDb().prepare("SELECT provider_model_id AS id FROM models WHERE connection_id=? AND availability='available'").all(connectionId)).toEqual([{ id: "new-model" }]);
  });
});
