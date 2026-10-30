"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@/src/modules/workspace/service";
import type { MemoryRecord } from "@/src/modules/workspace/memory";

export function MemoryManager({ projects, memories }: { projects: Project[]; memories: MemoryRecord[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending("save"); setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = { projectId: data.get("projectId"), kind: data.get("kind"), content: data.get("content"), retentionPolicy: data.get("retentionPolicy") };
    const url = editing ? `/api/v1/memory/${editing.id}` : "/api/v1/memory";
    const body = editing ? { kind: payload.kind, content: payload.content, retentionPolicy: payload.retentionPolicy } : payload;
    try {
      const response = await fetch(url, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "Memory could not be saved."); return; }
      setEditing(null); form.reset(); router.refresh();
    } catch { setError("Memory could not be saved before the server responded."); }
    finally { setPending(""); }
  }

  async function remove(memory: MemoryRecord) {
    if (!window.confirm("Delete this trusted memory?")) return;
    setPending(memory.id); setError("");
    try {
      const response = await fetch(`/api/v1/memory/${memory.id}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Memory could not be deleted.");
      else { if (editing?.id === memory.id) setEditing(null); router.refresh(); }
    } catch { setError("Memory could not be deleted before the server responded."); }
    finally { setPending(""); }
  }

  return <section className="section"><div className="section-title"><div><h2>Project memory</h2><p className="subtitle">Only instructions and decisions entered here by you are stored as trusted. Web, GitHub, model, and tool claims remain untrusted and are never promoted automatically.</p></div><span className="hint">{memories.length} active</span></div><div className="grid grid-2">
    <div className="card card-pad"><h3>{editing ? "Edit trusted memory" : "Add trusted memory"}</h3><form className="form" key={editing?.id ?? "new"} onSubmit={save}>
      <label className="label">Project<select className="select" name="projectId" defaultValue={editing?.projectId} disabled={Boolean(editing)} required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="label">Type<select className="select" name="kind" defaultValue={editing?.kind ?? "instruction"}><option value="instruction">Instruction</option><option value="decision">Decision</option></select></label>
      <label className="label">Content<textarea className="textarea" name="content" defaultValue={editing?.content} maxLength={4000} required /></label>
      <label className="label">Retention<select className="select" name="retentionPolicy" defaultValue={editing?.retentionPolicy ?? "permanent"}><option value="permanent">Until deleted</option><option value="30_days">30 days</option><option value="90_days">90 days</option></select></label>
      {error && <div className="error" role="alert">{error}</div>}
      <span className="row-actions"><button className="button button-primary" disabled={!projects.length || pending === "save"}>{pending === "save" ? "Saving…" : editing ? "Update memory" : "Add memory"}</button>{editing && <button className="button" type="button" onClick={() => setEditing(null)}>Cancel</button>}</span>
    </form></div>
    <div className="card list">{memories.length ? memories.map((memory) => <div className="list-row" key={memory.id}><span className="list-main"><span className="list-title">{memory.kind}: {memory.content}</span><span className="list-meta">{memory.projectName} · explicit user · trusted · {memory.retentionPolicy.replace("_", " ")}</span></span><span className="row-actions"><button className="button button-ghost" onClick={() => setEditing(memory)}>Edit</button><button className="button button-danger" disabled={pending === memory.id} onClick={() => remove(memory)}>{pending === memory.id ? "Deleting…" : "Delete"}</button></span></div>) : <div className="empty"><strong>No trusted project memory</strong><span>Nothing from models or external retrieval has been stored as memory.</span></div>}</div>
  </div></section>;
}
