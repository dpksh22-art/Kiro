import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ policies: getDb().prepare(`SELECT id, project_id AS projectId, provider, period,
    hard_limit_micros AS hardLimitMicros, soft_limit_micros AS softLimitMicros, behavior, created_at AS createdAt
    FROM budget_policies WHERE user_id=?`).all(session.user.id) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({
    projectId: z.uuid().optional(), provider: z.string().max(50).optional(), period: z.enum(["task", "daily", "monthly"]),
    hardLimitDollars: z.number().nonnegative().max(1_000_000), behavior: z.enum(["stop", "wait"]).default("stop"),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid budget", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.projectId && !getDb().prepare("SELECT 1 FROM projects WHERE id=? AND user_id=?").get(parsed.data.projectId, session.user.id)) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO budget_policies
    (id,user_id,project_id,provider,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, session.user.id, parsed.data.projectId ?? null, parsed.data.provider ?? null, parsed.data.period,
      Math.round(parsed.data.hardLimitDollars * 1_000_000), parsed.data.behavior, now, now);
  return Response.json({ id }, { status: 201 });
}
