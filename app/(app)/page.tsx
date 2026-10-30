import Link from "next/link";
import { requireSession } from "@/src/core/session";
import { dashboard, ensureDefaultProject, listProjects } from "@/src/modules/workspace/service";
import { listConnections } from "@/src/modules/gateway/connections";
import { listRuns } from "@/src/modules/agents/service";

export default async function CommandCenter() {
  const session = await requireSession();
  ensureDefaultProject(session.user.id);
  const metrics = dashboard(session.user.id);
  const runs = listRuns(session.user.id).slice(0, 5) as Array<Record<string, unknown>>;
  const projects = listProjects(session.user.id).slice(0, 4);
  const connections = listConnections(session.user.id);
  return <main className="content">
    <header className="page-head"><div><p className="eyebrow">Command Center</p><h1>Good to see you, {session.user.name.split(" ")[0]}.</h1><p className="subtitle">Live state from your workspace, providers, and durable agent runs.</p></div><Link href="/chat" className="button button-primary">New conversation</Link></header>
    <section className="grid grid-4" aria-label="Workspace metrics">
      <div className="card metric"><p className="metric-label">Active runs</p><p className="metric-value">{metrics.activeRuns}</p><p className="metric-note">Queued, running, or waiting</p></div>
      <div className="card metric"><p className="metric-label">Connected providers</p><p className="metric-value">{metrics.providers.connected}<span className="hint"> / {metrics.providers.total}</span></p><p className="metric-note">Validated connections only</p></div>
      <div className="card metric"><p className="metric-label">Month settled cost</p><p className="metric-value">${(metrics.monthCostMicros / 1_000_000).toFixed(2)}</p><p className="metric-note">Provider-reported or final conservative estimate</p></div>
      <div className="card metric"><p className="metric-label">Failed runs</p><p className="metric-value">{metrics.failedRuns}</p><p className="metric-note">Inspectable and resumable where safe</p></div>
    </section>
    <section className="section grid grid-2">
      <div><div className="section-title"><h2>Recent runs</h2><Link href="/runs" className="hint">View all →</Link></div><div className="card list">{runs.length ? runs.map((run) => <Link className="list-row" key={String(run.id)} href={`/runs/${run.id}`}><span className="list-main"><span className="list-title">{String(run.title)}</span><span className="list-meta">{String(run.mode)} · {new Date(String(run.updatedAt)).toLocaleString()}</span></span><span className={`status status-${run.status}`}>{String(run.status)}</span></Link>) : <div className="empty"><strong>No agent runs yet</strong><span>Start one from Agent Teams after connecting a model.</span></div>}</div></div>
      <div><div className="section-title"><h2>Provider health</h2><Link href="/connections" className="hint">Manage →</Link></div><div className="card list">{connections.length ? connections.slice(0, 5).map((connection) => <div className="list-row" key={connection.id}><span className="list-main"><span className="list-title">{connection.label}</span><span className="list-meta">{connection.provider} · checked {connection.lastCheckedAt ? new Date(connection.lastCheckedAt).toLocaleString() : "never"}</span></span><span className={`status status-${connection.status}`}>{connection.status}</span></div>) : <div className="empty"><strong>No providers connected</strong><span>Add an API key or local Ollama endpoint to begin.</span></div>}</div></div>
    </section>
    <section className="section"><div className="section-title"><h2>Projects</h2><Link href="/projects" className="hint">Open projects →</Link></div><div className="grid grid-3">{projects.map((project) => <div className="card card-pad" key={project.id}><h3>{project.name}</h3><p className="subtitle">{project.description || "No description"}</p><p className="hint">Updated {new Date(project.updatedAt).toLocaleDateString()}</p></div>)}</div></section>
  </main>;
}
