"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const CONFIRMATION = "DELETE MY NEXUS ACCOUNT";
const STORAGE_KEY = "nexus-account-deletion-idempotency-key";

export function AccountDeletionForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== CONFIRMATION) return;
    let idempotencyKey = window.localStorage.getItem(STORAGE_KEY);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      window.localStorage.setItem(STORAGE_KEY, idempotencyKey);
    }
    setPending(true);
    setError("");
    try {
      const postDeletion = async (key: string) => {
        const response = await fetch("/api/v1/account/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password, confirmation, idempotencyKey: key }),
        });
        const body = await response.json().catch(() => ({})) as { error?: string; code?: string; state?: string };
        return { response, body };
      };
      let attempt = await postDeletion(idempotencyKey);
      if (attempt.response.status === 409 && attempt.body.code === "stale_completed_idempotency_key") {
        idempotencyKey = crypto.randomUUID();
        window.localStorage.setItem(STORAGE_KEY, idempotencyKey);
        attempt = await postDeletion(idempotencyKey);
      }
      setPassword("");
      if (!attempt.response.ok) {
        setError(attempt.body.error ?? "Account deletion failed safely. Retry with the same confirmation.");
        return;
      }
      if (attempt.body.state === "completed") {
        window.localStorage.removeItem(STORAGE_KEY);
        router.replace("/goodbye");
        router.refresh();
        return;
      }
      setError("Deletion is not complete. Your account remains active; retry this form.");
    } catch {
      setPassword("");
      setError("Deletion did not receive a server response. Your stable retry key was preserved; retry this form.");
    } finally {
      setPending(false);
    }
  }

  return <section className="section card card-pad" aria-labelledby="delete-account-heading">
    <p className="eyebrow">Danger zone</p>
    <h2 id="delete-account-heading">Delete the NEXUS owner account</h2>
    <p className="subtitle">This permanently removes the local owner, sessions, provider and GitHub ciphertext, workspace data, usage records, and artifact bytes. NEXUS cannot revoke provider keys or GitHub tokens remotely. Revoke them at each issuer before deleting.</p>
    <div className="error" style={{ marginTop: 14 }}><strong>Export first.</strong> Download the JSON export above before continuing. Deletion cannot be undone, and retained audit tombstones contain only redacted operational facts.</div>
    <form className="form" onSubmit={submit} style={{ marginTop: 16 }}>
      <label className="label">Current password<input className="input" type="password" autoComplete="current-password" minLength={12} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="label">Type <code>{CONFIRMATION}</code><input className="input" autoComplete="off" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="button button-danger" disabled={pending || confirmation !== CONFIRMATION}>{pending ? "Deleting local account…" : "Permanently delete account"}</button>
      <p className="hint">A replacement single owner is allowed only after deletion completes. The operator must restore <code>NEXUS_BOOTSTRAP_TOKEN</code> before creating it.</p>
    </form>
  </section>;
}
