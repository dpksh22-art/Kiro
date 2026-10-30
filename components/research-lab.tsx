"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type ResearchModel = { connectionId: string; modelId: string; label: string };
type SourceRow = { connector: "web" | "rss" | "hackernews" | "github" | "tavily"; value: string };
const placeholders: Record<SourceRow["connector"], string> = {
  web: "https://example.com/report",
  rss: "https://example.com/feed.xml",
  hackernews: "Hacker News item ID",
  github: "owner/repository",
  tavily: "Search query",
};

export function ResearchLab({ models }: { models: ResearchModel[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [rows, setRows] = useState<SourceRow[]>([{ connector: "web", value: "" }]);
  const [modelIndex, setModelIndex] = useState(-1);

  function updateRow(index: number, update: Partial<SourceRow>) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...update } : row));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const sources = rows.map((row) => row.connector === "hackernews"
      ? { connector: row.connector, itemId: Number(row.value) }
      : row.connector === "github" ? { connector: row.connector, repository: row.value.trim() }
        : row.connector === "tavily" ? { connector: row.connector, query: row.value.trim() }
          : { connector: row.connector, url: row.value.trim() });
    const selected = models[modelIndex];
    try {
      const response = await fetch("/api/v1/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective: data.get("objective"), sources, ...(selected ? { target: { connectionId: selected.connectionId, modelId: selected.modelId } } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Research failed.");
      else {
        if (body.status === "failed_synthesis") setError(body.synthesisError ?? "Evidence was saved, but synthesis failed.");
        setRows([{ connector: "web", value: "" }]);
        form.reset();
        setModelIndex(-1);
        router.refresh();
      }
    } catch {
      setError("The research request could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return <form className="form" onSubmit={submit}>
    <label className="label">Research objective<textarea className="textarea" name="objective" required placeholder="What evidence should be collected and compared?" /></label>
    <label className="label">Research mode<select className="select" value={modelIndex} onChange={(event) => setModelIndex(Number(event.target.value))}>
      <option value={-1}>Evidence only, no model call</option>
      {models.map((model, index) => <option key={`${model.connectionId}:${model.modelId}`} value={index}>Synthesize with {model.label}</option>)}
    </select></label>
    <div className="form">
      {rows.map((row, index) => <div className="form-row" key={index}>
        <label className="label">Connector<select className="select" value={row.connector} onChange={(event) => updateRow(index, { connector: event.target.value as SourceRow["connector"] })}>
          <option value="web">Direct webpage</option><option value="rss">RSS / Atom</option><option value="hackernews">Hacker News</option><option value="github">GitHub repository</option><option value="tavily">Tavily search</option>
        </select></label>
        <label className="label">Source {index + 1}<span className="row-actions"><input className="input" required value={row.value} onChange={(event) => updateRow(index, { value: event.target.value })} placeholder={placeholders[row.connector]} />{rows.length > 1 && <button className="button button-ghost" type="button" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>}</span></label>
      </div>)}
    </div>
    {rows.length < 10 && <button className="button" type="button" onClick={() => setRows((current) => [...current, { connector: "web", value: "" }])}>Add complementary source</button>}
    <p className="hint">Up to 10 source requests can be combined here. Retrieval remains separate from optional synthesis. Content is bounded, private-network targets are blocked, and every record receives a SHA-256 hash.</p>
    {!models.length && <p className="hint">No connected, available model with structured-output support is currently discovered. Evidence-only research remains available.</p>}
    {error && <div className="error">{error}</div>}
    <button className="button button-primary" disabled={pending}>{pending ? "Collecting evidence…" : "Run research"}</button>
  </form>;
}
