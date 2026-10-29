import { requireApiSession } from "@/src/core/session";
import { listModels } from "@/src/modules/gateway/connections";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ models: listModels(session.user.id).map((model) => ({ ...model, capabilities: JSON.parse(String(model.capabilitiesJson)), capabilitiesJson: undefined })) });
}
