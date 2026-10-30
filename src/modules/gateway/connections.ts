import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { getAdapter, SUPPORTED_PROVIDERS } from "@/src/modules/gateway/adapters";
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

type ConnectionRow = ConnectionRecord & { encryptedCredential: string | null; userId: string };

export function listConnections(userId: string): ConnectionRecord[] {
  return getDb().prepare(`SELECT id, provider, label, base_url AS baseUrl, status,
    last_checked_at AS lastCheckedAt, last_error AS lastError
    FROM provider_connections WHERE user_id = ? ORDER BY provider, label`).all(userId) as ConnectionRecord[];
}

export function getConnection(userId: string, id: string): ConnectionRow | undefined {
  return getDb().prepare(`SELECT id, user_id AS userId, provider, label, encrypted_credential AS encryptedCredential,
    base_url AS baseUrl, status, last_checked_at AS lastCheckedAt, last_error AS lastError
    FROM provider_connections WHERE id = ? AND user_id = ?`).get(id, userId) as ConnectionRow | undefined;
}

export function connectionCredentials(row: ConnectionRow): ProviderCredentials {
  return { apiKey: row.encryptedCredential ? decryptSecret(row.encryptedCredential) : undefined, baseUrl: row.baseUrl ?? undefined };
}

export function createConnection(userId: string, input: { provider: string; label: string; apiKey?: string; baseUrl?: string }): string {
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
  const row = getConnection(userId, id);
  if (!row) throw new Error("Connection not found.");
  const checkedAt = new Date().toISOString();
  try {
    const models = await getAdapter(row.provider).listModels(connectionCredentials(row), AbortSignal.timeout(15_000));
    const db = getDb();
    db.transaction(() => {
      db.prepare("UPDATE models SET availability='unavailable', updated_at=? WHERE connection_id=?").run(checkedAt, id);
      const upsert = db.prepare(`INSERT INTO models
        (id, connection_id, provider_model_id, display_name, capabilities_json, availability, metadata_source, metadata_observed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'available', 'provider_api', ?, ?, ?)
        ON CONFLICT(connection_id, provider_model_id) DO UPDATE SET display_name=excluded.display_name,
          capabilities_json=excluded.capabilities_json, availability='available', metadata_observed_at=excluded.metadata_observed_at, updated_at=excluded.updated_at`);
      for (const model of models) upsert.run(randomUUID(), id, model.id, model.displayName, JSON.stringify(model.capabilities), checkedAt, checkedAt, checkedAt);
      db.prepare("UPDATE provider_connections SET status='connected', last_checked_at=?, last_error=NULL, updated_at=? WHERE id=? AND user_id=?").run(checkedAt, checkedAt, id, userId);
    })();
    writeAudit({ userId, action: "provider.connection.validated", resourceType: "provider_connection", resourceId: id, outcome: "success", metadata: { provider: row.provider, modelCount: models.length } });
    return models.length;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Validation failed.";
    const db = getDb();
    db.transaction(() => {
      db.prepare("UPDATE models SET availability='unavailable', updated_at=? WHERE connection_id=?").run(checkedAt, id);
      db.prepare("UPDATE provider_connections SET status='invalid', last_checked_at=?, last_error=?, updated_at=? WHERE id=? AND user_id=?").run(checkedAt, message, checkedAt, id, userId);
    })();
    writeAudit({ userId, action: "provider.connection.validated", resourceType: "provider_connection", resourceId: id, outcome: "failure", metadata: { provider: row.provider, error: message } });
    throw error;
  }
}

export function listModels(userId: string) {
  return getDb().prepare(`SELECT m.id, m.connection_id AS connectionId, c.provider, c.label AS connectionLabel,
    m.provider_model_id AS modelId, m.display_name AS displayName, m.capabilities_json AS capabilitiesJson,
    m.context_window AS contextWindow, m.input_price_micros_per_million AS inputPriceMicrosPerMillion,
    m.output_price_micros_per_million AS outputPriceMicrosPerMillion, m.pricing_currency AS pricingCurrency,
    m.availability, m.metadata_observed_at AS metadataObservedAt
    FROM models m JOIN provider_connections c ON c.id=m.connection_id
    WHERE c.user_id=? ORDER BY c.provider, m.display_name`).all(userId) as Array<Record<string, unknown>>;
}
