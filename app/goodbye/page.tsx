import Link from "next/link";

export default function GoodbyePage() {
  return <main className="auth-page">
    <section className="auth-visual">
      <div className="brand"><span className="brand-mark">NX</span><span>NEXUS AI OS</span></div>
      <div className="auth-copy"><p className="eyebrow">Deletion completed</p><h1>Your local NEXUS account is gone.</h1><p>The owner account, sessions, local credentials, workspace records, and referenced artifact bytes were removed. Any provider or GitHub credential must still be revoked at its issuer.</p></div>
      <p className="hint">Redacted audit and deletion tombstones retain no email or password.</p>
    </section>
    <section className="auth-panel"><div className="auth-box"><h2>Goodbye</h2><p className="subtitle">To create a replacement owner, the deployment operator must configure the bootstrap token again.</p><Link className="button button-primary" href="/login">Return to sign in</Link></div></section>
  </main>;
}
