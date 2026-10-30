"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Task = { id: string; parentTaskId?: string | null; assignedAgentId?: string | null; title: string; description: string; taskType: string; status: string; depth: number; agentName?: string | null; attemptCount: number; output?: { content?: string; provider?: string; modelId?: string } | null; errorMessage?: string | null };
type AgentMessage = { id: string; senderName?: string | null; recipientAgentId: string; recipientName?: string | null; senderTaskId?: string | null; recipientTaskId?: string | null; messageType: string; correlationId: string; replyToId?: string | null; hopCount: number; body: { text?: string }; state: string; trustLabel: string; createdAt: string; expiresAt: string };
type RunEvent = { sequence: number; eventType: string; taskId?: string | null; actorType: string; actorId?: string | null; correlationId?: string | null; createdAt: string; payload: Record<string, unknown> };
type Participant = { id: string; name: string; role: string; source: string };
type Run = { id: string; title: string; goal: string; mode: string; status: string; createdAt: string; completedAt?: string | null; tasks: Task[]; dependencies: Array<{ taskId: string; dependsOnTaskId: string }>; messages: AgentMessage[]; events: RunEvent[]; participants: Participant[] };

export function RunMonitor({ initialRun }: { initialRun: Run }) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let active = true; let source: EventSource | undefined; let retry: ReturnType<typeof setTimeout>;
    const refresh = async () => { const response = await fetch(`/api/v1/runs/${run.id}`); if (response.ok && active) setRun((await response.json()).run); };
    const connect = () => {
      if (!active) return;
      source = new EventSource(`/api/v1/runs/${run.id}/events`);
      source.onmessage = refresh;
      const names = ["TaskCreated","RunStarted","AgentStarted","AgentProgress","ArtifactProduced","TaskCompleted","TaskFailed","TaskRetryScheduled","TaskReady","TaskRecovered","TaskCancelled","TaskDelegated","AgentMessageSent","AgentMessageAcknowledged","RunCancelRequested","RunDeadlineExceeded","RunResumed"];
      names.forEach((name) => source!.addEventListener(name, refresh));
      source.onerror = () => { source?.close(); if (active && !["succeeded","failed","cancelled"].includes(run.status)) retry = setTimeout(connect, 1500); };
    };
    connect();
    const interval = setInterval(refresh, 3000);
    return () => { active = false; source?.close(); clearTimeout(retry); clearInterval(interval); };
  }, [run.id, run.status]);

  async function action(name: "cancel" | "resume") {
    setError("");
    const response = await fetch(`/api/v1/runs/${run.id}/${name}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? `Unable to ${name} run.`); else router.refresh();
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSending(true);
    const form = event.currentTarget; const data = new FormData(form);
    const response = await fetch(`/api/v1/runs/${run.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientAgentId: data.get("recipientAgentId"), body: data.get("body"), idempotencyKey: crypto.randomUUID() }),
    });
    const body = await response.json(); setSending(false);
    if (!response.ok) return setError(body.error ?? "Unable to send message.");
    form.reset();
    const refreshed = await fetch(`/api/v1/runs/${run.id}`);
    if (refreshed.ok) setRun((await refreshed.json()).run);
  }

  const terminal = ["succeeded","failed","cancelled"].includes(run.status);
  const activeRecipients = run.participants.filter((participant) => run.tasks.some((task) => task.assignedAgentId === participant.id && ["blocked","ready","leased","running","waiting","retry_wait"].includes(task.status)));
  return <>
    <div className="card card-pad"><div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}><div><span className={`status status-${run.status}`}>{run.status}</span><p className="subtitle">{run.goal}</p><p className="hint">Started {new Date(run.createdAt).toLocaleString()} · {run.mode}</p></div><div>{!terminal && <button className="button button-danger" onClick={() => action("cancel")}>Cancel run</button>}{run.status === "failed" && <button className="button" onClick={() => action("resume")}>Resume eligible tasks</button>}</div></div>{error && <div className="error" role="alert">{error}</div>}</div>

    {!terminal && <section className="section"><div className="section-title"><h2>Owner collaboration message</h2><span className="hint">Explicit user data, never a permission grant</span></div><form className="card card-pad form" onSubmit={sendMessage}><label className="label">Participating agent<select className="select" name="recipientAgentId" required defaultValue=""><option value="" disabled>Select an active agent</option>{activeRecipients.map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.role}</option>)}</select></label><label className="label">Message<textarea className="textarea" name="body" required maxLength={8000} placeholder="Add bounded coordination context…" /></label><button className="button" disabled={sending || !activeRecipients.length}>{sending ? "Sending…" : "Send durable message"}</button></form></section>}

    <section className="section"><div className="section-title"><h2>Dependency-aware execution</h2><span className="hint">{run.tasks.filter((task) => ["succeeded","failed","cancelled","skipped"].includes(task.status)).length} / {run.tasks.length} terminal</span></div><div className="task-stack">{run.tasks.map((task) => <article className={`task task-depth-${Math.min(task.depth, 4)}`} key={task.id}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><h3>{task.title}</h3><p className="list-meta">{task.agentName ?? "Coordinator"} · attempt {task.attemptCount} · depth {task.depth}{task.parentTaskId ? ` · delegated by ${task.parentTaskId.slice(0, 8)}` : ""}</p><p className="hint">Task {task.id} · {task.taskType}</p></div><span className={`status status-${task.status}`}>{task.status}</span></div><p className="subtitle">{task.description}</p>{task.errorMessage && <div className="error">{task.errorMessage}</div>}{task.output?.content && <details><summary className="button button-ghost">Inspect output</summary><div className="task-output">{task.output.content}</div></details>}</article>)}</div></section>

    <section className="section"><div className="section-title"><h2>Durable collaboration</h2><span className="hint">{run.messages.length} messages</span></div>{run.messages.length ? <div className="task-stack">{run.messages.map((message) => <article className="card card-pad" key={message.id}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{message.senderName ?? "Human owner"} → {message.recipientName ?? message.recipientAgentId}</strong><p className="list-meta">{message.messageType} · {message.trustLabel} · correlation {message.correlationId}{message.replyToId ? ` · reply to ${message.replyToId}` : ""} · hop {message.hopCount}</p></div><span className={`status status-${message.state}`}>{message.state}</span></div><p className="subtitle">{message.body.text}</p><p className="hint">{new Date(message.createdAt).toLocaleString()} · message {message.id}</p></article>)}</div> : <div className="empty">No collaboration messages have been persisted.</div>}</section>

    <section className="section"><div className="section-title"><h2>Run events</h2><span className="hint">Latest {run.events.length}</span></div><div className="task-stack">{run.events.slice().reverse().map((event) => <article className="card card-pad" key={event.sequence}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{event.eventType}</strong><span className="hint">#{event.sequence}</span></div><p className="list-meta">{event.actorType}{event.actorId ? ` ${event.actorId}` : ""}{event.taskId ? ` · task ${event.taskId}` : ""}{event.correlationId ? ` · correlation ${event.correlationId}` : ""}</p><p className="hint">{new Date(event.createdAt).toLocaleString()}</p></article>)}</div></section>
  </>;
}
