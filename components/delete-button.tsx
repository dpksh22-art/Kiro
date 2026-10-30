"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteButton({ endpoint, label, confirmText, redirect }: { endpoint: string; label: string; confirmText: string; redirect?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (!window.confirm(confirmText)) return;
    setPending(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Deletion failed.");
      else if (redirect) router.push(redirect);
      else router.refresh();
    } catch { setError("Deletion failed before the server responded."); }
    finally { setPending(false); }
  }
  return <span>{error && <span className="error" role="alert">{error}</span>} <button className="button button-danger" disabled={pending} onClick={remove}>{pending ? "Deleting…" : label}</button></span>;
}
