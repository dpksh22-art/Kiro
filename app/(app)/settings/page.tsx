import { requireSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";
import { listProjects } from "@/src/modules/workspace/service";
import { listMemories } from "@/src/modules/workspace/memory";
import { listConnections } from "@/src/modules/gateway/connections";
import { githubStatus } from "@/src/modules/github/service";
import { MemoryManager } from "@/components/memory-manager";
import { DataLifecycleControls } from "@/components/data-lifecycle-controls";
import { AccountDeletionForm } from "@/components/account-deletion-form";

export default async function SettingsPage() {
  const session = await requireSession();
  const audits = getDb().prepare(`SELECT action,resource_type AS resourceType,resource_id AS resourceId,outcome,created_at AS createdAt FROM audit_events WHERE user_id=? ORDER BY sequence DESC LIMIT 50`).all(session.user.id) as Array<Record<string, unknown>>;
  return <main className="content"><header className="page-head"><div><p className="eyebrow">Settings, Memory & Security</p><h1>Data controls and trust boundaries</h1><p className="subtitle">Secrets remain server-side. External and model content remains untrusted. Only memory you explicitly create here is trusted.</p></div></header>
    <div className="grid grid-2"><section className="card card-pad"><h2>Security posture</h2><div className="list"><div className="list-row"><span>Provider credentials</span><span className="status status-connected">AES-256-GCM</span></div><div className="list-row"><span>Artifact upload</span><span className="status status-clean">Conservative scan</span></div><div className="list-row"><span>Memory promotion</span><span className="status status-clean">Explicit only</span></div><div className="list-row"><span>Horizontal deployment</span><span className="status status-waiting">Single writer</span></div></div></section><DataLifecycleControls providers={listConnections(session.user.id)} github={githubStatus(session.user.id).map((item) => ({ id: String(item.id), login: item.login, status: item.status }))} /></div>
    <MemoryManager projects={listProjects(session.user.id)} memories={listMemories(session.user.id)} />
    <AccountDeletionForm />
    <section className="section"><div className="section-title"><h2>Recent audit events</h2><span className="hint">Last 50</span></div><div className="card list">{audits.length ? audits.map((audit, index) => <div className="list-row" key={index}><span className="list-main"><span className="list-title">{String(audit.action)}</span><span className="list-meta">{String(audit.resourceType)} · {new Date(String(audit.createdAt)).toLocaleString()}</span></span><span className={`status status-${audit.outcome}`}>{String(audit.outcome)}</span></div>) : <div className="empty"><strong>No audit events yet</strong><span>Security-relevant actions appear here.</span></div>}</div></section>
  </main>;
}
