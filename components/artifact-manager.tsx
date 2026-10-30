"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { ArtifactRecord } from "@/src/modules/artifacts/service";
import type { Project } from "@/src/modules/workspace/service";

export function ArtifactManager({ artifacts, projects, maxBytes }: { artifacts: ArtifactRecord[]; projects: Project[]; maxBytes: number }) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending("upload"); setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) { setPending(""); setError("Choose a non-empty file."); return; }
    if (file.size > maxBytes) { setPending(""); setError(`Files must not exceed ${maxBytes.toLocaleString()} bytes.`); return; }
    const projectId = String(data.get("projectId") ?? "");
    try {
      const response = await fetch("/api/v1/artifacts", { method: "POST", headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Nexus-Filename": encodeURIComponent(file.name),
        ...(projectId ? { "X-Nexus-Project-Id": projectId } : {}),
      }, body: file });
      const body = await response.json();
      if (!response.ok) { setError(body.error ?? "Upload failed."); return; }
      form.reset(); router.refresh();
    } catch { setError("Upload failed before the server responded."); }
    finally { setPending(""); }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete ${name}? Unreferenced stored bytes will also be removed.`)) return;
    setPending(id); setError("");
    try {
      const response = await fetch(`/api/v1/artifacts/${id}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Deletion failed.");
      else router.refresh();
    } catch { setError("Deletion failed before the server responded."); }
    finally { setPending(""); }
  }

  return <div className="grid grid-2">
    <section className="card card-pad"><h2>Upload an artifact</h2><p className="subtitle">Up to 10 MiB. The built-in scanner marks valid UTF-8 text and JSON clean. Executables, scripts, archives, mismatched types, images, and unknown binary formats require a separate scanner and are rejected by default.</p>
      <form className="form" onSubmit={upload}>
        <label className="label">File<input className="input" type="file" name="file" required /></label>
        <label className="label">Project (optional)<select className="select" name="projectId"><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="button button-primary" disabled={pending === "upload"}>{pending === "upload" ? "Scanning and storing…" : "Upload"}</button>
      </form>
    </section>
    <section><div className="section-title"><h2>Stored artifacts</h2><span className="hint">{artifacts.length} records</span></div><div className="card list">
      {artifacts.length ? artifacts.map((artifact) => <div className="list-row" key={artifact.id}><span className="list-main"><span className="list-title">{artifact.name}</span><span className="list-meta">{artifact.mediaType} · {artifact.byteSize.toLocaleString()} bytes · {artifact.contentHash.slice(0, 12)}…</span></span><span className="row-actions"><span className={`status status-${artifact.uploadState}`}>{artifact.uploadState}</span>{artifact.uploadState === "clean" && <a className="button button-ghost" href={`/api/v1/artifacts/${artifact.id}/content`}>Download</a>}<button className="button button-danger" disabled={pending === artifact.id} onClick={() => remove(artifact.id, artifact.name)}>{pending === artifact.id ? "Deleting…" : "Delete"}</button></span></div>) : <div className="empty"><strong>No stored artifacts</strong><span>Upload a safe file to create a content-addressed artifact.</span></div>}
    </div></section>
  </div>;
}
