import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { listResearch, runResearch } from "@/src/modules/research/service";

const sourceSchema = z.discriminatedUnion("connector", [
  z.object({ connector: z.literal("web"), url: z.url() }),
  z.object({ connector: z.literal("rss"), url: z.url() }),
  z.object({ connector: z.literal("hackernews"), itemId: z.number().int().positive() }),
  z.object({ connector: z.literal("github"), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }),
  z.object({ connector: z.literal("tavily"), query: z.string().trim().min(2).max(500) }),
]);

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ reports: listResearch(session.user.id).map((report) => ({ ...report, citations: JSON.parse(String(report.citationMapJson)), citationMapJson: undefined })) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ objective: z.string().trim().min(2).max(2_000), sources: z.array(sourceSchema).min(1).max(20) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid research request", issues: parsed.error.issues }, { status: 400 });
  try {
    return Response.json(await runResearch({ userId: session.user.id, ...parsed.data }), { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Research failed." }, { status: 502 });
  }
}
