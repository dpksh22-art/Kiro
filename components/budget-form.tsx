"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function BudgetForm({ projects, providers }: { projects: Array<{ id: string; name: string }>; providers: string[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [kind, setKind] = useState<"monetary" | "resource">("resource");
  const [scope, setScope] = useState<"owner" | "project" | "provider">("owner");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const body: Record<string, unknown> = { kind, scope, period: data.get("period") };
    if (scope === "project") body.projectId = data.get("projectId");
    if (scope === "provider") body.provider = data.get("provider");
    if (kind === "monetary") {
      body.hardLimitDollars = Number(data.get("limit"));
      body.behavior = "stop";
    } else {
      body.unit = data.get("unit");
      body.hardLimit = Number(data.get("limit"));
    }
    const response = await fetch("/api/v1/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); setPending(false);
    if (!response.ok) return setError(result.error ?? "Unable to save budget.");
    form.reset(); router.refresh();
  }

  return <form className="form" onSubmit={submit}>
    <div className="form-row">
      <label className="label">Budget type<select className="select" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="resource">Resource units</option><option value="monetary">Monetary cost</option></select></label>
      <label className="label">Scope<select className="select" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="owner">All owner activity</option><option value="project">Owned project</option><option value="provider">Owned provider</option></select></label>
    </div>
    {scope === "project" && <label className="label">Project<select className="select" name="projectId" required>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>}
    {scope === "provider" && <label className="label">Provider<select className="select" name="provider" required>{providers.map((provider) => <option value={provider} key={provider}>{provider}</option>)}</select></label>}
    {kind === "resource" && <label className="label">Unit<select className="select" name="unit"><option value="model_calls">Model calls</option><option value="input_tokens">Input tokens</option><option value="output_tokens">Output tokens</option><option value="tool_calls">Tool calls</option><option value="task_starts">Task starts</option></select></label>}
    <div className="form-row">
      <label className="label">Period<select className="select" name="period"><option value="daily">Daily (UTC)</option><option value="monthly">Monthly (UTC)</option><option value="task">Per task</option>{kind === "resource" && <option value="run">Per run</option>}</select></label>
      <label className="label">Hard limit {kind === "monetary" ? "(USD)" : "(units)"}<input className="input" type="number" name="limit" min="0" step={kind === "monetary" ? "0.01" : "1"} required /></label>
    </div>
    <p className="hint">The backend atomically admits reservations before model, tool, or task work. Monetary limits fail closed when verified pricing is unavailable.</p>
    {error && <div className="error">{error}</div>}
    <button className="button" disabled={pending || (scope === "provider" && providers.length === 0) || (scope === "project" && projects.length === 0)}>{pending ? "Saving…" : "Add hard limit"}</button>
  </form>;
}

export function BudgetDeleteButton({ id, kind }: { id: string; kind: "monetary" | "resource" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function remove() {
    setPending(true);
    const response = await fetch("/api/v1/budgets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, kind }) });
    setPending(false);
    if (response.ok) router.refresh();
  }
  return <button className="button button-ghost" type="button" disabled={pending} onClick={remove}>{pending ? "Deleting…" : "Delete"}</button>;
}
