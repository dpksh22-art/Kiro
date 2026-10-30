import { requireSession } from "@/src/core/session";
import { listModels } from "@/src/modules/gateway/connections";
import { listResearch } from "@/src/modules/research/service";
import type { ResearchSynthesis, ResearchVerification } from "@/src/modules/research/types";
import { ResearchLab } from "@/components/research-lab";

type ReportSource = { id: string; title?: string; canonicalUrl: string; contentHash: string; includedInSynthesis: number };
type RetrievalError = { source?: { connector?: string }; message?: string };
type Usage = { status?: string; inputTokens?: number; outputTokens?: number; estimatedCostMicros?: number; billedCostMicros?: number; currency?: string };

function parsedCapabilities(value: unknown): Record<string, string> {
  try { return JSON.parse(String(value)) as Record<string, string>; } catch { return {}; }
}

export default async function ResearchPage() {
  const session = await requireSession();
  const reports = listResearch(session.user.id);
  const models = listModels(session.user.id).flatMap((model) => {
    const capability = parsedCapabilities(model.capabilitiesJson).structured_output;
    if (model.availability !== "available" || model.connectionStatus !== "connected" || (capability !== "supported" && capability !== "conditional")) return [];
    return [{ connectionId: String(model.connectionId), modelId: String(model.modelId), label: `${String(model.provider)} · ${String(model.displayName)} · ${String(model.connectionLabel)}` }];
  });

  return <main className="content">
    <header className="page-head"><div><p className="eyebrow">Research Lab</p><h1>Evidence before synthesis</h1><p className="subtitle">Retrieve complementary sources first, preserve provenance, then optionally synthesize with a connected model under local schema and citation checks.</p></div></header>
    <div className="grid grid-2">
      <section className="card card-pad"><h2>Collect evidence</h2><p className="subtitle">Web, feeds, Hacker News, and public GitHub work without paid search. Tavily activates when configured.</p><ResearchLab models={models} /></section>
      <section><div className="section-title"><h2>Research reports</h2><span className="hint">{reports.length}</span></div><div className="card list">
        {reports.length ? reports.map((report) => {
          const sources = report.sources as ReportSource[];
          const synthesis = report.synthesis as ResearchSynthesis | null;
          const verification = report.verification as ResearchVerification | { status?: string } | null;
          const retrievalErrors = report.retrievalErrors as RetrievalError[];
          const usage = report.usage as Usage | null;
          const verificationClaims = synthesis && verification && "claims" in verification ? verification.claims : [];
          return <details className="list-row" key={String(report.id)} style={{ display: "block" }}>
            <summary><strong>{String(report.title)}</strong><span className={`status status-${String(report.status)}`}>{String(report.status).replaceAll("_", " ")}</span><span className="list-meta">{new Date(String(report.createdAt)).toLocaleString()}</span></summary>
            {report.synthesisError ? <div className="error" style={{ marginTop: 12 }}>Evidence was preserved. {String(report.synthesisError)}</div> : null}
            {synthesis ? <div className="section">
              <h3>Executive summary</h3><p className="subtitle">{synthesis.executiveSummary}</p>
              <div className="section-title" style={{ marginTop: 18 }}><h3>Claims</h3><span className={`status status-${verification?.status === "supported" ? "success" : "degraded"}`}>{String(verification?.status ?? "unverified").replaceAll("_", " ")}</span></div>
              <div className="task-stack">{synthesis.claims.map((claim, index) => {
                const claimVerification = verificationClaims.find((item) => item.claimIndex === index);
                return <article className="task" key={index}><div className="row-actions"><span className="status">{claim.confidence} confidence</span><span className={`status status-${claimVerification?.status === "supported" ? "success" : "degraded"}`}>{claimVerification?.status ?? "unverified"}</span></div><p style={{ marginTop: 8 }}>{claim.text}</p><p className="hint" style={{ marginTop: 8 }}>Uncertainty: {claim.uncertainty || "None stated"}</p><div className="row-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>{claim.sourceIds.map((sourceId) => { const source = sources.find((item) => item.id === sourceId); return source ? <a className="button button-ghost" key={sourceId} href={source.canonicalUrl} target="_blank" rel="noreferrer">{source.title ?? source.canonicalUrl}</a> : null; })}</div></article>;
              })}</div>
              <div className="grid grid-2 section"><div><h3>Contradictions</h3>{synthesis.contradictions.length ? <ul>{synthesis.contradictions.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="hint">None reported.</p>}</div><div><h3>Limitations</h3>{synthesis.limitations.length ? <ul>{synthesis.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="hint">None reported.</p>}</div></div>
            </div> : null}
            {retrievalErrors.length ? <div className="section"><h3>Connector failures</h3><ul>{retrievalErrors.map((error, index) => <li key={index}>{error.source?.connector ?? "connector"}: {error.message ?? "Retrieval failed."}</li>)}</ul></div> : null}
            <div className="section"><h3>Stored sources</h3><div className="task-stack">{sources.map((source) => <a className="task" href={source.canonicalUrl} target="_blank" rel="noreferrer" key={source.id}><strong>{source.title ?? source.canonicalUrl}</strong><div className="hint mono">{source.id} · SHA-256 {source.contentHash}{source.includedInSynthesis ? " · included in model packet" : " · preserved outside model packet"}</div></a>)}</div></div>
            {usage ? <div className="section"><h3>Usage</h3><p className="hint">{usage.status} · {usage.inputTokens ?? "unknown"} input tokens · {usage.outputTokens ?? "unknown"} output tokens · {usage.currency ?? "currency unknown"} {usage.billedCostMicros ?? usage.estimatedCostMicros ?? "cost unknown"} micros</p></div> : null}
            <details className="section"><summary>Stored evidence packet</summary><div className="task-output">{String(report.body)}</div></details>
          </details>;
        }) : <div className="empty"><strong>No evidence collected</strong><span>Create an evidence-only or model-synthesized research task from authorized public sources.</span></div>}
      </div></section>
    </div>
  </main>;
}
