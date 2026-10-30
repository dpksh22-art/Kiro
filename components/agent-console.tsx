"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const SAFE_TOOLS = ["web_fetch", "github_repository_read", "artifact_text_read", "agent_message_send", "delegate_task"] as const;
type Agent = { id: string; name: string; role: string; instructions: string; isTemplate: number; allowedTools: string[]; maxTurns: number; permissionPolicy: { mode?: string; maxToolCalls?: number; maxMessages?: number; maxDelegations?: number }; budget: { perRun?: { modelCalls?: number; outputTokens?: number; toolCalls?: number } }; outputSchema: Record<string, unknown> | null };
type Model = { connectionId: string; provider: string; modelId: string; displayName: string };

export function AgentConsole({ agents, models, projectId }: { agents: Agent[]; models: Model[]; projectId: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    let outputSchema: Record<string, unknown> | null = null;
    try {
      const raw = String(data.get("outputSchema") ?? "").trim();
      outputSchema = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    } catch { setPending(false); setError("Output JSON Schema must be valid JSON."); return; }
    const allowedTools = data.getAll("allowedTools").map(String);
    const internalEnabled = allowedTools.some((tool) => tool === "agent_message_send" || tool === "delegate_task");
    const response = await fetch("/api/v1/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name: data.get("name"), role: data.get("role"), instructions: data.get("instructions"), completionCriteria: data.get("criteria"),
      allowedTools, maxDurationSeconds: Number(data.get("maxDurationSeconds")), maxTurns: Number(data.get("maxTurns")),
      permissionPolicy: { mode: internalEnabled ? "read_only_or_internal" : "read_only", maxToolCalls: Number(data.get("maxToolCalls")),
        maxMessages: internalEnabled ? Number(data.get("maxMessages")) : 0, maxDelegations: internalEnabled ? Number(data.get("maxDelegations")) : 0 },
      budget: { perRun: {
        modelCalls: data.get("budgetModelCalls") ? Number(data.get("budgetModelCalls")) : undefined,
        outputTokens: data.get("budgetOutputTokens") ? Number(data.get("budgetOutputTokens")) : undefined,
        toolCalls: data.get("budgetToolCalls") ? Number(data.get("budgetToolCalls")) : undefined,
      } }, outputSchema,
    }) });
    const body = await response.json(); setPending(false);
    if (!response.ok) return setError(body.error ?? "Unable to create agent.");
    form.reset(); router.refresh();
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const data = new FormData(event.currentTarget);
    const agentIds = data.getAll("agents").map(String);
    const targets = data.getAll("models").map(String).map((key) => { const split = key.indexOf("::"); return { connectionId: key.slice(0, split), modelId: key.slice(split + 2) }; });
    const response = await fetch("/api/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, goal: data.get("goal"), mode: data.get("mode"), agentIds, targets, maxParallelism: 3 }) });
    const body = await response.json(); setPending(false);
    if (!response.ok) return setError(body.error ?? "Unable to start run.");
    router.push(`/runs/${body.runId}`);
  }

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
      <section className="card card-pad"><h2>Create a custom agent</h2><p className="subtitle">External tools are read-only. Internal messaging and delegation must be explicitly enabled and remain server-bounded.</p><form className="form" onSubmit={create}>
        <label className="label">Name<input className="input" name="name" required maxLength={100} /></label>
        <label className="label">Role<input className="input" name="role" required maxLength={200} /></label>
        <label className="label">Instructions<textarea className="textarea" name="instructions" required maxLength={20000} /></label>
        <fieldset className="label"><legend>Allowed read-only or internal tools</legend><div className="checkbox-list">{SAFE_TOOLS.map((tool) => <label className="check" key={tool}><input type="checkbox" name="allowedTools" value={tool} /><span>{tool}</span></label>)}</div></fieldset>
        <label className="label">Maximum provider turns (1–12)<input className="input" name="maxTurns" type="number" min={1} max={12} defaultValue={8} required /></label>
        <label className="label">Maximum total tool calls (0–12)<input className="input" name="maxToolCalls" type="number" min={0} max={12} defaultValue={4} required /></label>
        <label className="label">Maximum messages per attempt (0–8)<input className="input" name="maxMessages" type="number" min={0} max={8} defaultValue={4} required /></label>
        <label className="label">Maximum delegations per attempt (0–4)<input className="input" name="maxDelegations" type="number" min={0} max={4} defaultValue={2} required /></label>
        <fieldset className="label"><legend>Per-run resource caps (optional)</legend><p className="hint">These values are snapshotted when a run starts and enforced across every task for this agent in that run.</p><div className="form-row"><label className="label">Model calls<input className="input" name="budgetModelCalls" type="number" min={0} step={1} /></label><label className="label">Output tokens<input className="input" name="budgetOutputTokens" type="number" min={0} step={1} /></label><label className="label">Tool calls<input className="input" name="budgetToolCalls" type="number" min={0} step={1} /></label></div></fieldset>
        <label className="label">Maximum duration in seconds<input className="input" name="maxDurationSeconds" type="number" min={10} max={86400} defaultValue={600} required /></label>
        <label className="label">Output JSON Schema (optional)<textarea className="textarea" name="outputSchema" placeholder={'{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'} /></label>
        <label className="label">Completion criteria<textarea className="textarea" name="criteria" maxLength={2000} /></label>
        <button className="button" disabled={pending}>{pending ? "Saving…" : "Create custom agent"}</button>
      </form></section>
    </div>
    <section className="section"><div className="section-title"><h2>Agent registry</h2><span className="hint">{agents.length} available</span></div><div className="grid grid-3">{agents.map((agent) => <article className="card card-pad" key={agent.id}><span className="status">{agent.isTemplate ? "built-in" : "custom"}</span><h3 style={{ marginTop: 12 }}>{agent.name}</h3><p className="list-meta">{agent.role}</p><p className="subtitle">{agent.instructions}</p><p className="hint">Tools: {agent.allowedTools.length ? agent.allowedTools.join(", ") : "model only"}</p><p className="hint">Turns: {agent.maxTurns}; tool calls: {agent.permissionPolicy.maxToolCalls ?? 4}; messages: {agent.permissionPolicy.maxMessages ?? 0}; delegations: {agent.permissionPolicy.maxDelegations ?? 0}; structured output: {agent.outputSchema ? "yes" : "no"}</p><p className="hint">Per-run resources: {agent.budget.perRun?.modelCalls ?? "unlimited"} model calls; {agent.budget.perRun?.outputTokens ?? "unlimited"} output tokens; {agent.budget.perRun?.toolCalls ?? "unlimited"} tool calls</p></article>)}</div></section>
  </>;
}
