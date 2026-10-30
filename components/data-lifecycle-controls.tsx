"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type ProviderConnection = { id: string; provider: string; label: string; status: string };
type GitHubConnection = { id: string; login?: unknown; status?: unknown };

export function DataLifecycleControls({ providers, github }: { providers: ProviderConnection[]; github: GitHubConnection[] }) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  async function disconnect(kind: "provider" | "github", id: string) {
    if (!window.confirm("Delete the stored encrypted credential and disconnect this integration? This does not revoke the credential at its issuer.")) return;
    setPending(id); setError("");
    const url = kind === "provider" ? `/api/v1/connections/${id}/disconnect` : `/api/v1/github/connections/${id}/disconnect`;
    try {
      const response = await fetch(url, { method: "POST" });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Disconnect failed.");
      else router.refresh();
    } catch { setError("Disconnect failed before the server responded."); }
    finally { setPending(""); }
  }
  const connectedProviders = providers.filter((item) => item.status !== "disconnected");
  const connectedGitHub = github.filter((item) => item.status === "connected");
  return <section className="card card-pad"><h2>Data lifecycle</h2><p className="subtitle">Export your stored workspace data or remove local integration credentials. Exports omit encrypted credentials and artifact filesystem paths.</p>
    <p><a className="button button-primary" href="/api/v1/export">Download JSON export</a></p>
    {error && <div className="error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    <div className="list" style={{ marginTop: 12 }}>{connectedProviders.map((connection) => <div className="list-row" key={connection.id}><span className="list-main"><span className="list-title">{connection.label}</span><span className="list-meta">{connection.provider} provider credential</span></span><button className="button button-danger" disabled={pending === connection.id} onClick={() => disconnect("provider", connection.id)}>Disconnect</button></div>)}{connectedGitHub.map((connection) => <div className="list-row" key={connection.id}><span className="list-main"><span className="list-title">GitHub {String(connection.login ?? "connection")}</span><span className="list-meta">Stored GitHub token</span></span><button className="button button-danger" disabled={pending === connection.id} onClick={() => disconnect("github", connection.id)}>Disconnect</button></div>)}{!connectedProviders.length && !connectedGitHub.length && <div className="empty"><strong>No stored integration credentials</strong><span>There is nothing to disconnect.</span></div>}</div>
  </section>;
}
