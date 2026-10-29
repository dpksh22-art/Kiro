import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOut } from "@/components/sign-out";

const primary = [
  ["/", "⌂", "Command Center"], ["/chat", "◫", "Unified Chat"], ["/runs", "⌁", "Task Runs"],
  ["/agents", "◎", "Agent Teams"], ["/research", "◇", "Research Lab"], ["/projects", "▦", "Projects"],
];
const system = [
  ["/github", "⌘", "GitHub"], ["/artifacts", "▤", "Files & Artifacts"], ["/gateway", "⇄", "Model Gateway"],
  ["/connections", "⊙", "Provider Connections"], ["/usage", "◔", "Usage & Costs"], ["/settings", "⚙", "Settings & Security"],
];

export function AppShell({ user, children }: { user: { name: string; email: string }; children: React.ReactNode }) {
  const links = (items: string[][]) => <nav className="nav">{items.map(([href, icon, label]) => <Link key={href} href={href!}><span className="nav-icon" aria-hidden>{icon}</span><span>{label}</span></Link>)}</nav>;
  return <div className="app">
    <aside className="sidebar">
      <Link href="/" className="brand"><span className="brand-mark">NX</span><span>NEXUS AI OS</span></Link>
      <p className="nav-section">Workspace</p>{links(primary)}
      <p className="nav-section">System</p>{links(system)}
      <div className="sidebar-footer"><div className="account"><span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span><span className="account-copy"><strong>{user.name}</strong><span>{user.email}</span></span><SignOut /></div></div>
    </aside>
    <div className="main"><header className="topbar"><span className="crumb">Personal workspace / NEXUS</span><ThemeToggle /></header>{children}</div>
  </div>;
}
