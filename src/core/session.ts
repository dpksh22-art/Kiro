import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/src/core/auth";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireApiSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return session;
}
