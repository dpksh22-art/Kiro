import { redirect } from "next/navigation";
import { getSession } from "@/src/core/session";
import { AuthForm } from "@/components/auth-form";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return <main className="auth-page">
    <section className="auth-visual">
      <div className="brand"><span className="brand-mark">NX</span><span>NEXUS AI OS</span></div>
      <div className="auth-copy">
        <p className="eyebrow">One command center</p>
        <h1>Models think.<br />Agents coordinate.<br />You stay in control.</h1>
        <p>A persistent workspace for direct model inference, parallel comparison, evidence-backed research, bounded agent teams, and reviewable GitHub work.</p>
      </div>
      <p className="hint">Local-first · encrypted connections · inspectable execution</p>
    </section>
    <section className="auth-panel"><AuthForm /></section>
  </main>;
}
