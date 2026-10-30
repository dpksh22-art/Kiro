import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { getAdapter, SUPPORTED_PROVIDERS } from "@/src/modules/gateway/adapters";
import { assertOwnerActive, beginOwnerOperation } from "@/src/modules/lifecycle/owner-runtime";
import type { ProviderCredentials } from "@/src/modules/gateway/types";

export type ConnectionRecord = {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  status: string;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export type ConnectionRow = ConnectionRecord & { encryptedCredential: string | null; userId: string; validationGeneration: number };

export type AvailableModelTarget = { connectionId: string; modelId: string };
export type ResolvedAvailableModel = {
  connection: ConnectionRow;
  registryModelId: string;
  providerModelId: string;
  displayName: string;
  capabilities: Record<string, string>;
  inputPriceMicrosPerMillion: number | null;
  outputPriceMicrosPerMillion: number | null;
  pricingCurrency: string | null;
};

export function listConnections(userId: string): ConnectionRecord[] {
  return getDb().prepare(`SELECT id, provider, label, base_url AS baseUrl, status,
    last_checked_at AS lastCheckedAt, last_error AS lastError
    FROM provider_connections WHERE user_id = ? ORDER BY provider, label`).all(userId) as ConnectionRecord[];
}

export function getConnection(userId: string, id: string): ConnectionRow | undefined {
  return getDb().prepare(`SELECT id, user_id AS userId, provider, label, encrypted_credential AS encryptedCredential,
    base_url AS baseUrl, status, last_checked_at AS lastCheckedAt, last_error AS lastError, validation_generation AS validationGeneration
    FROM provider_connections WHERE id = ? AND user_id = ?`).get(id, userId) as ConnectionRow | undefined;
}

export function connectionCredentials(row: ConnectionRow): ProviderCredentials {
  assertOwnerActive(row.userId);
  return { apiKey: row.encryptedCredential ? decryptSecret(row.encryptedCredential) : undefined, baseUrl: row.baseUrl ?? undefined };
}

export function createConnection(userId: string, input: { provider: string; label: string; apiKey?: string; baseUrl?: string }): string {
  assertOwnerActive(userId);
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) throw new Error("Unsupported provider.");
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO provider_connections
    (id, user_id, provider, label, encrypted_credential, base_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`)
    .run(id, userId, input.provider, input.label, input.apiKey ? encryptSecret(input.apiKey) : null, input.baseUrl ?? null, now, now);
  writeAudit({ userId, action: "provider.connection.created", resourceType: "provider_connection", resourceId: id, outcome: "success", metadata: { provider: input.provider, label: input.label } });
  return id;
}

export async function validateConnection(userId: string, id: string): Promise<number> {
  const db = getDb();
  const started = db.transaction(() => {
    const row = getConnection(userId, id);
    if (!row) throw new Error("Connection not found.");
    const generation = row.validationGeneration + 1;
    const changed = db.prepare(`UPDATE provider_connections SET validation_generation=?,status='unknown',last_error=NULL,updated_at=?
      WHERE id=? AND user_id=? AND validation_generation=?`).run(generation, new Date().toISOString(), id, userId, row.validationGeneration);
    if (!changed.changes) throw new Error("Connection validation was superseded before it started.");
    return { ...row, validationGeneration: generation };
  })();
  const checkedAt = new Date().toISOString();
  const operation = beginOwnerOperation(userId, "provider_validation");
  try {
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(15_000)]);
    const models = await getAdapter(started.provider).listModels(connectionCredentials(started), signal);
    const committed = db.transaction(() => {
      const changed = db.prepare(`UPDATE provider_connections SET status='connected',last_checked_at=?,last_error=NULL,updated_at=?
        WHERE id=? AND user_id=? AND validation_generation=? AND status='unknown' AND encrypted_credential IS ?`)
        .run(checkedAt, checkedAt, id, userId, started.validationGeneration, started.encryptedCredential);
      if (!changed.changes) return false;
      db.prepare("UPDATE models SET availability='unavailable', updated_at=? WHERE connection_id=?").run(checkedAt, id);
      const upsert = db.prepare(`INSERT INTO models
        (id, connection_id, provider_model_id, display_name, capabilities_json, availability, metadata_source, metadata_observed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'available', 'provider_api', ?, ?, ?)
        ON CONFLICT(connection_id, provider_model_id) DO UPDATE SET display_name=excluded.display_name,
          capabilities_json=excluded.capabilities_json, availability='available', metadata_observed_at=excluded.metadata_observed_at, updated_at=excluded.updated_at`);
      for (const model of models) upsert.run(randomUUID(), id, model.id, model.displayName, JSON.stringify(model.capabilities), checkedAt, checkedAt, checkedAt);
      return true;
    })();
    if (!committed) throw new Error("Connection validation result was superseded and discarded.");
    writeAudit({ userId, action: "provider.connection.validated", resourceType: "provider_connection", resourceId: id, outcome: "success", metadata: { provider: started.provider, modelCount: models.length, generation: started.validationGeneration } });
    return models.length;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Validation failed.";
    db.transaction(() => {
      const changed = db.prepare(`UPDATE provider_connections SET status='invalid',last_checked_at=?,last_error=?,updated_at=?
        WHERE id=? AND user_id=? AND validation_generation=? AND status='unknown' AND encrypted_credential IS ?`)
        .run(checkedAt, message, checkedAt, id, userId, started.validationGeneration, started.encryptedCredential);
      if (changed.changes) db.prepare("UPDATE models SET availability='unavailable', updated_at=? WHERE connection_id=?").run(checkedAt, id);
    })();
    writeAudit({ userId, action: "provider.connection.validated", resourceType: "provider_connection", resourceId: id, outcome: "failure", metadata: { provider: started.provider, error: message, generation: started.validationGeneration } });
    throw error;
  } finally {
    operation.end();
  }
}

export function listModels(userId: string) {
  return getDb().prepare(`SELECT m.id, m.connection_id AS connectionId, c.provider, c.label AS connectionLabel,
    m.provider_model_id AS modelId, m.display_name AS displayName, m.capabilities_json AS capabilitiesJson,
    m.context_window AS contextWindow, m.input_price_micros_per_million AS inputPriceMicrosPerMillion,
    m.output_price_micros_per_million AS outputPriceMicrosPerMillion, m.pricing_currency AS pricingCurrency,
    m.availability, c.status AS connectionStatus, m.metadata_observed_at AS metadataObservedAt
    FROM models m JOIN provider_connections c ON c.id=m.connection_id
    WHERE c.user_id=? ORDER BY c.provider, m.display_name`).all(userId) as Array<Record<string, unknown>>;
}

export function resolveAvailableModel(userId: string, target: AvailableModelTarget, requiredCapability?: string): ResolvedAvailableModel {
  const row = getDb().prepare(`SELECT m.id AS registryModelId, m.provider_model_id AS providerModelId, m.display_name AS displayName,
    m.capabilities_json AS capabilitiesJson, m.input_price_micros_per_million AS inputPriceMicrosPerMillion,
    m.output_price_micros_per_million AS outputPriceMicrosPerMillion, m.pricing_currency AS pricingCurrency,
    c.id AS connectionId, c.user_id AS userId, c.provider, c.label, c.base_url AS baseUrl,
    c.status, c.last_checked_at AS lastCheckedAt, c.last_error AS lastError, c.encrypted_credential AS encryptedCredential,
    c.validation_generation AS validationGeneration
    FROM models m JOIN provider_connections c ON c.id=m.connection_id
    WHERE c.user_id=? AND c.id=? AND m.provider_model_id=? AND c.status='connected' AND m.availability='available'`)
    .get(userId, target.connectionId, target.modelId) as (Omit<ResolvedAvailableModel, "connection" | "capabilities"> & ConnectionRow & { connectionId: string; capabilitiesJson: string }) | undefined;
  if (!row) throw new Error("Selected model is not connected, available, and owned by this account.");
  const capabilities = JSON.parse(row.capabilitiesJson) as Record<string, string>;
  if (requiredCapability) {
    const state = capabilities[requiredCapability];
    if (state !== "supported" && state !== "conditional") throw new Error(`Selected model has ${state ?? "unknown"} ${requiredCapability} capability.`);
  }
  return {
    connection: {
      id: row.connectionId, userId: row.userId, provider: row.provider, label: row.label, baseUrl: row.baseUrl,
      status: row.status, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError, encryptedCredential: row.encryptedCredential, validationGeneration: row.validationGeneration,
    },
    registryModelId: row.registryModelId,
    providerModelId: row.providerModelId,
    displayName: row.displayName,
    capabilities,
    inputPriceMicrosPerMillion: row.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: row.outputPriceMicrosPerMillion,
    pricingCurrency: row.pricingCurrency,
  };
}
