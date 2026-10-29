"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Agent = { id: string; name: string; role: string; instructions: string; isTemplate: number; allowedTools: string[] };
type Model = { connectionId: string; provider: string; modelId: string; displayName: string };

export function AgentConsole({ agents, models, projectId }: { agents: Agent[]; models: Model[]; projectId: string }) {
  const router = useRouter(); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(""); const data = new FormData(event.currentTarget); const response = await fetch("/api/v1/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: data.get("name"), role: data.get("role"), instructions: data.get("instructions"), completionCriteria: data.get("criteria") }) }); const body = await response.json(); setPending(false); if (!response.ok) return setError(body.error ?? "Unable to create agent."); event.currentTarget.reset(); router.refresh(); }
  async function run(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(""); const data = new FormData(event.currentTarget); const agentIds = data.getAll("agents").map(String); const targetKeys = data.getAll("models").map(String); const targets = targetKeys.map((key) => { const split = key.indexOf("::"); return { connectionId: key.slice(0, split), modelId: key.slice(split + 2) }; }); const response = await fetch("/api/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, goal: data.get("goal"), mode: data.get("mode"), agentIds, targets, maxParallelism: 3 }) }); const body = await response.json(); setPending(false); if (!response.ok) return setError(body.error ?? "Unable to start run."); router.push(`/runs/${body.runId}`); }
  return <>
    {error && <div className="error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}
    <div className="grid grid-2">
      <section className="card card-pad"><h2>Launch an orchestrated team</h2><p className="subtitle">Independent tasks execute concurrently. A final coordinator receives their persisted outputs and preserves disagreements.</p><form className="form" onSubmit={run}>
        <label className="label">Execution mode<select className="select" name="mode"><option value="team">Orchestrated team</option><option value="review">Expert review</option><option value="research">Research analysis</option><option value="engineering">Software engineering</option></select></label>
        <label className="label">Goal<textarea className="textarea" name="goal" required placeholder="Describe the outcome and acceptance criteria…" /></label>
        <fieldset className="label"><legend>Agents (up to eight)</legend><div className="checkbox-list">{agents.map((agent, index) => <label className="check" key={agent.id}><input type="checkbox" name="agents" value={agent.id} defaultChecked={index < 3} /><span><strong>{agent.name}</strong><span className="list-meta">{agent.role}</span></span></label>)}</div></fieldset>
        <fieldset className="label"><legend>Models (one or more)</legend><div className="checkbox-list">{models.map((model, index) => <label className="check" key={`${model.connectionId}-${model.modelId}`}><input type="checkbox" name="models" value={`${model.connectionId}::${model.modelId}`} defaultChecked={index === 0} /><span><strong>{model.displayName}</strong><span className="list-meta">{model.provider}</span></span></label>)}</div></fieldset>
        <button className="button button-primary" disabled={pending || !models.length}>{pending ? "Starting…" : models.length ? "Start durable run" : "Connect a model first"}</button>
      </form></section>
      <section className="card card-pad"><h2>Create a custom agent</h2><p className="subtitle">Custom roles use the same budgets, duration limits, permission policy, and audit lifecycle as built-ins.</p><form className="form" onSubmit={create}>
        <label className="label">Name<input className="input" name="name" required maxLength={100} /></label><label className="label">Role<input className="input" name="role" required maxLength={200} /></label><label className="label">Instructions<textarea className="textarea" name="instructions" required /></label><label className="label">Completion criteria<textarea className="textarea" name="criteria" /></label><button className="button" disabled={pending}>{pending ? "Saving…" : "Create custom agent"}</button>
      </form></section>
    </div>
    <section className="section"><div className="section-title"><h2>Agent registry</h2><span className="hint">{agents.length} available</span></div><div className="grid grid-3">{agents.map((agent) => <article className="card card-pad" key={agent.id}><span className="status">{agent.isTemplate ? "built-in" : "custom"}</span><h3 style={{ marginTop: 12 }}>{agent.name}</h3><p className="list-meta">{agent.role}</p><p className="subtitle">{agent.instructions}</p><p className="hint">Tools: {agent.allowedTools.length ? agent.allowedTools.join(", ") : "model only"}</p></article>)}</div></section>
  </>;
}
