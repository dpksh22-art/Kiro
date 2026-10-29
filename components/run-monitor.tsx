"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Task = { id: string; title: string; description: string; status: string; depth: number; agentName?: string | null; attemptCount: number; output?: { content?: string; provider?: string; modelId?: string } | null; errorMessage?: string | null };
type Run = { id: string; title: string; goal: string; mode: string; status: string; createdAt: string; completedAt?: string | null; tasks: Task[]; dependencies: Array<{ taskId: string; dependsOnTaskId: string }> };
export function RunMonitor({ initialRun }: { initialRun: Run }) {
  const router = useRouter(); const [run, setRun] = useState(initialRun); const [error, setError] = useState("");
  useEffect(() => {
    let active = true; let source: EventSource | undefined; let retry: ReturnType<typeof setTimeout>;
    const refresh = async () => { const response = await fetch(`/api/v1/runs/${run.id}`); if (response.ok && active) setRun((await response.json()).run); };
    const connect = () => { if (!active) return; source = new EventSource(`/api/v1/runs/${run.id}/events`); source.onmessage = refresh; const names = ["TaskCreated","RunStarted","AgentStarted","AgentProgress","ArtifactProduced","TaskCompleted","TaskFailed","TaskRetryScheduled","TaskReady","TaskCancelled","RunCancelRequested","RunResumed"]; names.forEach((name) => source!.addEventListener(name, refresh)); source.onerror = () => { source?.close(); if (active && !["succeeded","failed","cancelled"].includes(run.status)) retry = setTimeout(connect, 1500); }; };
    connect(); const interval = setInterval(refresh, 3000); return () => { active = false; source?.close(); clearTimeout(retry); clearInterval(interval); };
  }, [run.id, run.status]);
  async function action(name: "cancel" | "resume") { setError(""); const response = await fetch(`/api/v1/runs/${run.id}/${name}`, { method: "POST" }); const body = await response.json(); if (!response.ok) setError(body.error ?? `Unable to ${name} run.`); else router.refresh(); }
  const terminal = ["succeeded","failed","cancelled"].includes(run.status);
  return <>
    <div className="card card-pad"><div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}><div><span className={`status status-${run.status}`}>{run.status}</span><p className="subtitle">{run.goal}</p><p className="hint">Started {new Date(run.createdAt).toLocaleString()} · {run.mode}</p></div><div>{!terminal && <button className="button button-danger" onClick={() => action("cancel")}>Cancel run</button>}{run.status === "failed" && <button className="button" onClick={() => action("resume")}>Resume eligible tasks</button>}</div></div>{error && <div className="error">{error}</div>}</div>
    <section className="section"><div className="section-title"><h2>Dependency-aware execution</h2><span className="hint">{run.tasks.filter((task) => ["succeeded","failed","cancelled","skipped"].includes(task.status)).length} / {run.tasks.length} terminal</span></div><div className="task-stack">{run.tasks.map((task) => <article className={`task task-depth-${task.depth}`} key={task.id}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><h3>{task.title}</h3><p className="list-meta">{task.agentName ?? "Coordinator"} · attempt {task.attemptCount}</p></div><span className={`status status-${task.status}`}>{task.status}</span></div><p className="subtitle">{task.description}</p>{task.errorMessage && <div className="error">{task.errorMessage}</div>}{task.output?.content && <details><summary className="button button-ghost">Inspect output</summary><div className="task-output">{task.output.content}</div></details>}</article>)}</div></section>
  </>;
}
