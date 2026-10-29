"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/src/core/auth-client";
export function SignOut() {
  const router = useRouter();
  return <button className="button button-ghost" onClick={async () => { await authClient.signOut(); router.push("/login"); router.refresh(); }} aria-label="Sign out">↪</button>;
}
