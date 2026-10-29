import { notFound } from "next/navigation";
import { requireSession } from "@/src/core/session";
import { getRun } from "@/src/modules/agents/service";
import { RunMonitor } from "@/components/run-monitor";
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) { const session = await requireSession(); const { id } = await params; const run = getRun(session.user.id, id); if (!run) notFound(); return <main className="content"><header className="page-head"><div><p className="eyebrow">Run detail</p><h1>{String(run.title)}</h1><p className="subtitle">Structured events distinguish proposed model output from completed tool or workflow actions.</p></div></header><RunMonitor initialRun={run as never} /></main>; }
