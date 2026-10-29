"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/src/core/auth-client";

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));
    const password = String(data.get("password"));
    const name = String(data.get("name") || email.split("@")[0]);
    const bootstrapToken = String(data.get("bootstrapToken") || "");
    const result = mode === "sign-in"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name }, { headers: { "x-nexus-bootstrap-token": bootstrapToken } });
    setPending(false);
    if (result.error) { setError(result.error.message ?? "Authentication failed."); return; }
    router.push("/");
    router.refresh();
  }

  return <div className="auth-box">
    <p className="eyebrow">Secure workspace</p>
    <h2>{mode === "sign-in" ? "Welcome back" : "Create the owner account"}</h2>
    <p className="subtitle">Provider credentials stay encrypted on the server and are never sent back to the browser.</p>
    <div className="tabs" role="tablist" aria-label="Authentication mode">
      <button type="button" role="tab" aria-selected={mode === "sign-in"} onClick={() => setMode("sign-in")}>Sign in</button>
      <button type="button" role="tab" aria-selected={mode === "sign-up"} onClick={() => setMode("sign-up")}>Sign up</button>
    </div>
    <form className="form" onSubmit={submit}>
      {mode === "sign-up" && <><label className="label">Name<input className="input" name="name" required maxLength={80} autoComplete="name" /></label><label className="label">Owner bootstrap token<input className="input" name="bootstrapToken" type="password" required autoComplete="off" /></label></>}
      <label className="label">Email<input className="input" name="email" type="email" required autoComplete="email" /></label>
      <label className="label">Password<input className="input" name="password" type="password" minLength={12} maxLength={128} required autoComplete={mode === "sign-in" ? "current-password" : "new-password"} /></label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="button button-primary" disabled={pending}>{pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}</button>
      {mode === "sign-up" && <p className="hint">Use the one-time <code>NEXUS_BOOTSTRAP_TOKEN</code>. The database permits exactly one owner account.</p>}
    </form>
  </div>;
}
