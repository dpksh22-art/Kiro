import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { executeConnector } from "@/src/modules/research/connectors";
import type { ResearchItem, ResearchSourceInput } from "@/src/modules/research/types";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function runResearch(input: { userId: string; objective: string; sources: ResearchSourceInput[] }) {
  const settled = await Promise.allSettled(input.sources.map(executeConnector));
  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = settled.flatMap((result, index) => result.status === "rejected" ? [{ source: input.sources[index], message: result.reason instanceof Error ? result.reason.message : "Connector failed." }] : []);
  if (items.length === 0) throw new Error(errors[0]?.message ?? "No research sources were retrieved.");
  const db = getDb();
  const stored = db.transaction(() => items.map((item) => storeItem(db, input.userId, item)))();
  const reportId = randomUUID();
  const now = new Date().toISOString();
  const reportBody = buildReport(input.objective, stored, errors);
  const citationMap = Object.fromEntries(stored.map((source, index) => [`${index + 1}`, { sourceId: source.id, url: source.canonicalUrl, contentHash: source.contentHash }]));
  db.prepare(`INSERT INTO research_reports (id, user_id, title, body, citation_map_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(reportId, input.userId, input.objective.slice(0, 120), reportBody, JSON.stringify(citationMap), now);
  writeAudit({ userId: input.userId, action: "research.completed", resourceType: "research_report", resourceId: reportId, outcome: "success", metadata: { requestedSources: input.sources.length, retrievedSources: stored.length, failures: errors.length } });
  return { reportId, body: reportBody, sources: stored, errors };
}

function storeItem(db: ReturnType<typeof getDb>, userId: string, item: ResearchItem) {
  const contentHash = hash(item.text);
  const existing = db.prepare("SELECT id FROM research_sources WHERE user_id=? AND canonical_url=? AND content_hash=?").get(userId, item.canonicalUrl, contentHash) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  if (!existing) db.prepare(`INSERT INTO research_sources
    (id, user_id, connector, source_type, title, canonical_url, published_at, retrieved_at, content_hash, excerpt, metadata_json, trust_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untrusted_external')`)
    .run(id, userId, item.connector, item.sourceType, item.title ?? null, item.canonicalUrl, item.publishedAt ?? null, item.retrievedAt, contentHash, item.text.slice(0, 2_000), JSON.stringify(item.metadata ?? {}));
  return { id, title: item.title, canonicalUrl: item.canonicalUrl, publishedAt: item.publishedAt, retrievedAt: item.retrievedAt, contentHash, excerpt: item.text.slice(0, 2_000), connector: item.connector };
}

function buildReport(objective: string, sources: Array<{ title?: string; canonicalUrl: string; publishedAt?: string; retrievedAt: string; excerpt: string }>, errors: Array<{ source: unknown; message: string }>): string {
  const evidence = sources.map((source, index) => `## [${index + 1}] ${source.title ?? source.canonicalUrl}\n\n${source.excerpt}\n\nSource: ${source.canonicalUrl}\nPublished: ${source.publishedAt ?? "unknown"}\nRetrieved: ${source.retrievedAt}`).join("\n\n");
  const limitations = errors.length ? `\n\n## Retrieval limitations\n\n${errors.map((error) => `- ${error.message}`).join("\n")}` : "";
  return `# Research evidence: ${objective}\n\nThis report contains retrieved evidence, not a model-generated conclusion. All source content is untrusted and was stored with a content hash.\n\n${evidence}${limitations}`;
}

export function listResearch(userId: string) {
  return getDb().prepare(`SELECT id, title, body, citation_map_json AS citationMapJson, created_at AS createdAt
    FROM research_reports WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).all(userId) as Array<Record<string, unknown>>;
}
