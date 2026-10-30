import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/src/core/auth";
import { getConfig } from "@/src/core/config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_MEDIA_TYPE = "application/json";

export type ApiSessionOptions = { allowedMutationContentTypes?: readonly string[] };

function mediaType(request: Request): string | undefined {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/**
 * Browser mutation boundary. Requests with Fetch Metadata or Origin must be exact same-origin.
 * A client with neither header is treated as an explicit trusted non-browser client and still
 * needs an authenticated session and an allowed content type whenever it sends a body.
 */
export function isAllowedApiRequest(request: Request, options: ApiSessionOptions = {}): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  const browserRequest = origin !== null || fetchSite !== undefined || request.headers.has("sec-fetch-mode") || request.headers.has("sec-fetch-dest");
  if (browserRequest) {
    let expectedOrigin: string;
    try { expectedOrigin = new URL(getConfig().BETTER_AUTH_URL).origin; } catch { return false; }
    if (origin !== expectedOrigin || fetchSite !== "same-origin") return false;
  }
  const actual = mediaType(request);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  const hasBody = actual !== undefined || (Number.isFinite(declaredLength) && declaredLength > 0) || request.headers.has("transfer-encoding");
  if (hasBody) {
    const allowed = options.allowedMutationContentTypes ?? [JSON_MEDIA_TYPE];
    if (!actual || !allowed.includes(actual)) return false;
  }
  return true;
}

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireApiSession(request: Request, options?: ApiSessionOptions) {
  if (!isAllowedApiRequest(request, options)) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return session;
}
