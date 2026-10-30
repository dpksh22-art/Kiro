import { requireSession } from "@/src/core/session";
import { listArtifacts, MAX_ARTIFACT_BYTES } from "@/src/modules/artifacts/service";
import { listProjects } from "@/src/modules/workspace/service";
import { ArtifactManager } from "@/components/artifact-manager";

export default async function ArtifactsPage() {
  const session = await requireSession();
  return <main className="content"><header className="page-head"><div><p className="eyebrow">Files & Artifacts</p><h1>Private content-addressed storage</h1><p className="subtitle">Uploads are streamed to local storage, identified by SHA-256, checked against quota, and downloadable only after the conservative scanner marks them clean.</p></div></header><ArtifactManager artifacts={listArtifacts(session.user.id)} projects={listProjects(session.user.id)} maxBytes={MAX_ARTIFACT_BYTES} /></main>;
}
