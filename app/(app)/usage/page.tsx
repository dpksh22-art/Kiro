import { requireSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";
import { BudgetDeleteButton, BudgetForm } from "@/components/budget-form";

type Policy = { id: string; kind: "monetary" | "resource"; scope: string; projectId: string | null; provider: string | null; period: string; hardLimitMicros?: number; hardLimit?: number; unit?: string };
type ResourceTotal = { unit: string; reserved: number; consumed: number; released: number };

export default async function UsagePage() {
  const session = await requireSession();
  const db = getDb();
  const usage = db.prepare(`SELECT provider,model_id AS modelId,input_tokens AS inputTokens,output_tokens AS outputTokens,
    estimated_cost_micros AS estimatedCost,billed_cost_micros AS billedCost,currency,status,created_at AS createdAt
    FROM usage_records WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).all(session.user.id) as Array<Record<string, unknown>>;
  const monetary = db.prepare(`SELECT id,'monetary' AS kind,
    CASE WHEN provider IS NOT NULL AND project_id IS NOT NULL THEN 'project_provider' WHEN provider IS NOT NULL THEN 'provider' WHEN project_id IS NOT NULL THEN 'project' ELSE 'owner' END AS scope,
    project_id AS projectId,provider,period,hard_limit_micros AS hardLimitMicros
    FROM budget_policies WHERE user_id=? ORDER BY created_at DESC`).all(session.user.id) as Policy[];
  const resources = db.prepare(`SELECT id,'resource' AS kind,scope_type AS scope,project_id AS projectId,provider,period,unit,hard_limit AS hardLimit
    FROM resource_budget_policies WHERE user_id=? ORDER BY created_at DESC`).all(session.user.id) as Policy[];
  const totals = db.prepare(`SELECT unit,
    COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_units ELSE 0 END),0) AS reserved,
    COALESCE(SUM(CASE WHEN status='consumed' THEN COALESCE(consumed_units,reserved_units) ELSE 0 END),0) AS consumed,
    COALESCE(SUM(CASE WHEN status='released' THEN reserved_units ELSE 0 END),0) AS released
    FROM resource_usage_records WHERE user_id=? GROUP BY unit ORDER BY unit`).all(session.user.id) as ResourceTotal[];
  const projects = db.prepare("SELECT id,name FROM projects WHERE user_id=? ORDER BY name").all(session.user.id) as Array<{ id: string; name: string }>;
  const providers = (db.prepare("SELECT DISTINCT provider FROM provider_connections WHERE user_id=? ORDER BY provider").all(session.user.id) as Array<{ provider: string }>).map((row) => row.provider);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const policies = [...monetary, ...resources];

  return <main className="content">
    <header className="page-head"><div><p className="eyebrow">Usage & Costs</p><h1>Measured usage, enforced limits</h1><p className="subtitle">Reserved resource units are provisional admission. Consumed units and settled costs are completed work. Released reservations count toward neither active limits nor spend.</p></div></header>
    <div className="grid grid-2">
      <section className="card card-pad"><h2>Budget policy</h2><p className="subtitle">Owner, owned-project, and owned-provider policies are enforced in trusted backend transactions.</p><BudgetForm projects={projects} providers={providers} />
        <div className="list">{policies.map((policy) => <div className="list-row" key={`${policy.kind}-${policy.id}`}><span className="list-main"><strong>{policy.kind === "resource" ? policy.unit?.replaceAll("_", " ") : "USD cost"}</strong><span className="list-meta">{policy.scope === "project_provider" ? `${projectNames.get(policy.projectId ?? "") ?? "Project"} · ${policy.provider}` : policy.scope === "project" ? projectNames.get(policy.projectId ?? "") ?? "Project" : policy.scope === "provider" ? policy.provider : "All owner activity"} · {policy.period}</span></span><strong>{policy.kind === "monetary" ? `$${(Number(policy.hardLimitMicros) / 1_000_000).toFixed(2)}` : Number(policy.hardLimit).toLocaleString()}</strong><BudgetDeleteButton id={policy.id} kind={policy.kind} /></div>)}</div>
      </section>
      <section className="card card-pad"><h2>Resource ledger</h2><p className="subtitle">Reserved and consumed units remain separate. Released values are historical evidence only.</p>{totals.length ? <div className="list">{totals.map((item) => <div className="list-row" key={item.unit}><span>{item.unit.replaceAll("_", " ")}</span><span className="list-meta">{item.consumed.toLocaleString()} consumed · {item.reserved.toLocaleString()} reserved · {item.released.toLocaleString()} released</span></div>)}</div> : <div className="empty"><strong>No resource usage yet</strong><span>Resource records appear when model calls, tools, or tasks are admitted.</span></div>}</section>
    </div>
    <section className="card table-wrap section"><table><thead><tr><th>Provider / model</th><th>Tokens</th><th>Cost</th><th>Status</th></tr></thead><tbody>{usage.length ? usage.map((item, index) => <tr key={index}><td>{String(item.provider)}<div className="hint mono">{String(item.modelId)}</div></td><td>{item.inputTokens == null ? "?" : String(item.inputTokens)} in / {item.outputTokens == null ? "?" : String(item.outputTokens)} out</td><td>{item.status === "released" ? "Released" : item.billedCost != null ? `$${(Number(item.billedCost) / 1_000_000).toFixed(4)}` : item.estimatedCost != null ? `~$${(Number(item.estimatedCost) / 1_000_000).toFixed(4)}` : "Unknown"}</td><td>{String(item.status)}</td></tr>) : <tr><td colSpan={4}><div className="empty"><strong>No usage yet</strong><span>Usage appears after model-call admission.</span></div></td></tr>}</tbody></table></section>
  </main>;
}
