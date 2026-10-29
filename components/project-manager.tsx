"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
export function ProjectManager() {
  const router = useRouter(); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(""); const data = new FormData(event.currentTarget); const response = await fetch("/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: data.get("name"), description: data.get("description") }) }); const body = await response.json(); setPending(false); if (!response.ok) return setError(body.error ?? "Unable to create project."); event.currentTarget.reset(); router.refresh(); }
  return <form className="form" onSubmit={submit}><label className="label">Project name<input className="input" name="name" required maxLength={100} /></label><label className="label">Description<textarea className="textarea" name="description" maxLength={500} /></label>{error && <div className="error">{error}</div>}<button className="button button-primary" disabled={pending}>{pending ? "Creating…" : "Create project"}</button></form>;
}
