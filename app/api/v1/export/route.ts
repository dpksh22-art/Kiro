import { requireApiSession } from "@/src/core/session";
import { createOwnerExport } from "@/src/modules/lifecycle/export";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(createOwnerExport(session.user.id), { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="nexus-export-${date}.json"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}
