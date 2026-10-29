import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createConnection, listConnections } from "@/src/modules/gateway/connections";
import { SUPPORTED_PROVIDERS } from "@/src/modules/gateway/adapters";

const schema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS as [string, ...string[]]),
  label: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().max(1_000).optional(),
}).superRefine((value, ctx) => {
  if (value.provider !== "ollama" && !value.apiKey) ctx.addIssue({ code: "custom", path: ["apiKey"], message: "An API key is required." });
});

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ connections: listConnections(session.user.id), providers: SUPPORTED_PROVIDERS });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid connection", issues: parsed.error.issues }, { status: 400 });
  try {
    const id = createConnection(session.user.id, parsed.data);
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to save connection." }, { status: 400 });
  }
}
