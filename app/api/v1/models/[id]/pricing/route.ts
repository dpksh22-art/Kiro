import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ inputDollarsPerMillion: z.number().nonnegative().max(1_000_000), outputDollarsPerMillion: z.number().nonnegative().max(1_000_000), currency: z.literal("USD"), sourceUrl: z.url().refine((url) => url.startsWith("https://"), "HTTPS source required") }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid pricing evidence", issues: parsed.error.issues }, { status: 400 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  const result = getDb().prepare(`UPDATE models SET input_price_micros_per_million=?, output_price_micros_per_million=?,
    pricing_currency=?, metadata_source=?, metadata_observed_at=?, updated_at=? WHERE id=? AND connection_id IN
    (SELECT id FROM provider_connections WHERE user_id=?)`).run(
      Math.round(parsed.data.inputDollarsPerMillion * 1_000_000), Math.round(parsed.data.outputDollarsPerMillion * 1_000_000),
      parsed.data.currency, `user_evidence:${parsed.data.sourceUrl}`, now, now, id, session.user.id,
    );
  if (!result.changes) return Response.json({ error: "Model not found." }, { status: 404 });
  writeAudit({ userId: session.user.id, action: "model.pricing.configured", resourceType: "model", resourceId: id, outcome: "success", metadata: { currency: parsed.data.currency, sourceUrl: parsed.data.sourceUrl } });
  return Response.json({ status: "updated", observedAt: now });
}
