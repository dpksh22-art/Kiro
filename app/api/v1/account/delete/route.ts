import { z } from "zod";
import { auth } from "@/src/core/auth";
import { requireApiSession } from "@/src/core/session";
import { ACCOUNT_DELETION_CONFIRMATION, AccountDeletionError, deleteOwnerAccount } from "@/src/modules/lifecycle/account-deletion";

export const runtime = "nodejs";

const requestSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION),
  idempotencyKey: z.uuid(),
}).strict();

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: `Enter your current password and type ${ACCOUNT_DELETION_CONFIRMATION} exactly.` }, { status: 400 });
  try {
    await auth.api.verifyPassword({ body: { password: parsed.data.password }, headers: request.headers });
  } catch {
    return Response.json({ error: "Current password is incorrect or the session is no longer eligible for this operation." }, { status: 403 });
  }
  try {
    const result = await deleteOwnerAccount({
      userId: session.user.id,
      confirmation: parsed.data.confirmation,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const response = Response.json(result, { status: result.state === "completed" ? 200 : 202, headers: { "Cache-Control": "no-store" } });
    if (result.state === "completed") {
      try {
        const signedOut = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
        for (const cookie of signedOut.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
      } catch {
        // The database session is already gone. Expire both normal and secure cookie names as a final browser cleanup fallback.
        for (const prefix of ["", "__Secure-"]) {
          for (const name of ["better-auth.session_token", "better-auth.session_data"]) {
            response.headers.append("Set-Cookie", `${prefix}${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
          }
        }
      }
    }
    return response;
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      return Response.json({ error: error.message, code: error.code, retryable: error.status === 503 }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "Account deletion failed safely. Your account remains active." }, { status: 500 });
  }
}
