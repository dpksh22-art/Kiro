"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Connection = { id: string; provider: string; label: string; status: string; lastCheckedAt: string | null; lastError: string | null };

export function ConnectionManager({ connections, providers }: { connections: Connection[]; providers: string[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setPending("add");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: data.get("provider"), label: data.get("label"), apiKey: data.get("apiKey") || undefined }) });
    const body = await response.json(); setPending("");
    if (!response.ok) { setError(body.error ?? "Unable to save connection."); return; }
    event.currentTarget.reset(); router.refresh();
  }
  async function validate(id: string) {
    setPending(id); setError("");
    const response = await fetch(`/api/v1/connections/${id}/validate`, { method: "POST" });
    const body = await response.json(); setPending("");
    if (!response.ok) setError(body.error ?? "Validation failed.");
    router.refresh();
  }
  return <div className="grid grid-2">
    <section className="card card-pad"><h2>Add provider connection</h2><p className="subtitle">Keys are encrypted with AES-256-GCM before persistence. They are never returned by the API.</p>
      <form className="form" onSubmit={add}>
        <label className="label">Provider<select className="select" name="provider">{providers.map((provider) => <option key={provider}>{provider}</option>)}</select></label>
        <label className="label">Connection label<input className="input" name="label" placeholder="Work account" maxLength={80} required /></label>
        <label className="label">API key<input className="input" name="apiKey" type="password" autoComplete="off" placeholder="Not required for local Ollama" /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="button button-primary" disabled={pending === "add"}>{pending === "add" ? "Encrypting…" : "Save connection"}</button>
      </form>
    </section>
    <section><div className="section-title"><h2>Connections</h2><span className="hint">{connections.length} configured</span></div><div className="card list">{connections.length ? connections.map((connection) => <div className="list-row" key={connection.id}><span className="list-main"><span className="list-title">{connection.label}</span><span className="list-meta">{connection.provider} · {connection.lastError ?? (connection.lastCheckedAt ? `checked ${new Date(connection.lastCheckedAt).toLocaleString()}` : "not validated")}</span></span><span><span className={`status status-${connection.status}`}>{connection.status}</span> <button className="button button-ghost" disabled={pending === connection.id} onClick={() => validate(connection.id)}>{pending === connection.id ? "Checking…" : "Validate"}</button></span></div>) : <div className="empty"><strong>No connections</strong><span>Add a provider to discover its currently available models.</span></div>}</div></section>
  </div>;
}
