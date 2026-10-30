import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";
import { RESOURCE_UNITS } from "@/src/modules/gateway/budgets";

const scopeFields = {
  scope: z.enum(["owner", "project", "provider", "project_provider"]).default("owner"),
  projectId: z.uuid().optional(),
  provider: z.string().trim().min(1).max(50).optional(),
};

const createSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("monetary"), ...scopeFields,
    period: z.enum(["task", "daily", "monthly"]),
    hardLimitDollars: z.number().nonnegative().max(1_000_000),
    behavior: z.enum(["stop", "wait"]).default("stop"),
  }).strict(),
  z.object({
    kind: z.literal("resource"), ...scopeFields,
    unit: z.enum(RESOURCE_UNITS),
    period: z.enum(["task", "run", "daily", "monthly"]),
    hardLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
]).superRefine((value, ctx) => {
  const projectScoped = value.scope === "project" || value.scope === "project_provider";
  const providerScoped = value.scope === "provider" || value.scope === "project_provider";
  if (value.kind === "resource" && value.scope === "project_provider") ctx.addIssue({ code: "custom", path: ["scope"], message: "Resource policies use one normalized scope." });
  if (projectScoped && !value.projectId) ctx.addIssue({ code: "custom", path: ["projectId"], message: "Project scope requires projectId." });
  if (!projectScoped && value.projectId) ctx.addIssue({ code: "custom", path: ["projectId"], message: "projectId is only valid for project scope." });
  if (providerScoped && !value.provider) ctx.addIssue({ code: "custom", path: ["provider"], message: "Provider scope requires provider." });
  if (!providerScoped && value.provider) ctx.addIssue({ code: "custom", path: ["provider"], message: "provider is only valid for provider scope." });
});

async function ownerContext(request: Request) {
  return requireApiSession(request);
}

function assertOwnedScope(userId: string, value: { scope: string; projectId?: string; provider?: string }): Response | undefined {
  if (value.projectId && !getDb().prepare("SELECT 1 FROM projects WHERE id=? AND user_id=?").get(value.projectId, userId)) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }
  if (value.provider && !getDb().prepare("SELECT 1 FROM provider_connections WHERE user_id=? AND provider=?").get(userId, value.provider)) {
    return Response.json({ error: "Owned provider connection not found." }, { status: 404 });
  }
}

export async function GET(request: Request) {
  const session = await ownerContext(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const monetary = getDb().prepare(`SELECT id,'monetary' AS kind,
    CASE WHEN provider IS NOT NULL AND project_id IS NOT NULL THEN 'project_provider' WHEN provider IS NOT NULL THEN 'provider' WHEN project_id IS NOT NULL THEN 'project' ELSE 'owner' END AS scope,
    project_id AS projectId,provider,period,hard_limit_micros AS hardLimitMicros,
    soft_limit_micros AS softLimitMicros,behavior,created_at AS createdAt
    FROM budget_policies WHERE user_id=? ORDER BY created_at DESC`).all(session.user.id);
  const resources = getDb().prepare(`SELECT id,'resource' AS kind,scope_type AS scope,project_id AS projectId,provider,run_id AS runId,
    agent_id AS agentId,unit,period,hard_limit AS hardLimit,created_at AS createdAt
    FROM resource_budget_policies WHERE user_id=? ORDER BY created_at DESC`).all(session.user.id);
  return Response.json({ policies: [...monetary, ...resources] });
}

export async function POST(request: Request) {
  const session = await ownerContext(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const raw = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (raw && typeof raw === "object" && raw.kind === undefined) {
    raw.kind = "monetary";
    raw.scope = raw.projectId && raw.provider ? "project_provider" : raw.projectId ? "project" : raw.provider ? "provider" : "owner";
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid budget", issues: parsed.error.issues }, { status: 400 });
  const scopeError = assertOwnedScope(session.user.id, parsed.data);
  if (scopeError) return scopeError;
  const id = randomUUID();
  const now = new Date().toISOString();
  if (parsed.data.kind === "monetary") {
    getDb().prepare(`INSERT INTO budget_policies
      (id,user_id,project_id,provider,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, session.user.id, parsed.data.projectId ?? null, parsed.data.provider ?? null, parsed.data.period,
        Math.round(parsed.data.hardLimitDollars * 1_000_000), parsed.data.behavior, now, now);
  } else {
    getDb().prepare(`INSERT INTO resource_budget_policies
      (id,user_id,unit,scope_type,project_id,provider,period,hard_limit,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, session.user.id, parsed.data.unit, parsed.data.scope, parsed.data.projectId ?? null,
        parsed.data.provider ?? null, parsed.data.period, parsed.data.hardLimit, now, now);
  }
  return Response.json({ id }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await ownerContext(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ id: z.uuid(), kind: z.enum(["monetary", "resource"]) }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid budget deletion." }, { status: 400 });
  const table = parsed.data.kind === "resource" ? "resource_budget_policies" : "budget_policies";
  const result = getDb().prepare(`DELETE FROM ${table} WHERE id=? AND user_id=?`).run(parsed.data.id, session.user.id);
  if (!result.changes) return Response.json({ error: "Budget not found." }, { status: 404 });
  return Response.json({ deleted: true });
}
