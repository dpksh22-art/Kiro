import { requireSession } from "@/src/core/session";
import { ensureDefaultProject, listProjects } from "@/src/modules/workspace/service";
import { ProjectManager } from "@/components/project-manager";
import { DeleteButton } from "@/components/delete-button";

export default async function ProjectsPage() {
  const session = await requireSession(); ensureDefaultProject(session.user.id); const projects = listProjects(session.user.id);
  return <main className="content"><header className="page-head"><div><p className="eyebrow">Projects</p><h1>Scoped context and work</h1><p className="subtitle">Deleting a project cascades its conversations and trusted memory. Historical runs and artifacts remain owned by you with their project link cleared.</p></div></header><div className="grid grid-2"><section className="card card-pad"><h2>Create project</h2><p className="subtitle">Start a clean context boundary.</p><ProjectManager /></section><section><div className="section-title"><h2>Your projects</h2><span className="hint">{projects.length}</span></div><div className="card list">{projects.map((project) => <div className="list-row" key={project.id}><span><span className="list-title">{project.name}</span><span className="list-meta">{project.description || "No description"} · updated {new Date(project.updatedAt).toLocaleDateString()}</span></span><DeleteButton endpoint={`/api/v1/projects/${project.id}`} label="Delete" confirmText={`Delete ${project.name} and its conversations and memory? Historical runs and artifacts will be retained without the project link.`} /></div>)}</div></section></div></main>;
}
