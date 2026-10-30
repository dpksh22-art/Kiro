"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Repo = { full_name: string; description?: string; private: boolean; default_branch: string; html_url: string };
type Overview = { repository?: { default_branch?: string }; branches?: unknown[]; issues?: unknown[]; pulls?: unknown[] };
type FileResult = { requestedRef: string; resolvedCommitSha: string; path: string; sha: string; size: number; content: string };
type Preview = {
  ref: string;
  resolvedCommitSha: string;
  path: string;
  before: { sha: string; content: string; size: number } | null;
  after: { content: string; size: number; contentHash: string };
  proposalHash: string;
  changed: boolean;
};
type ProposedChange = { preview: Preview; message: string };

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({ error: "The server returned an invalid response." }));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "GitHub request failed.");
  return body;
}

export function GitHubConsole({ connected, login }: { connected: boolean; login?: string }) {
  const issueOperation = useRef("");
  const branchOperation = useRef("");
  const changeOperation = useRef("");
  const pullOperation = useRef("");
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<FileResult | null>(null);
  const [proposal, setProposal] = useState<ProposedChange | null>(null);
  const [outcome, setOutcome] = useState("");

  const defaultBranch = overview?.repository?.default_branch ?? "main";

  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError("");
    try { return await operation(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "GitHub request failed."); }
    finally { setPending(false); }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await run(async () => responseJson(await fetch("/api/v1/github/connection", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: data.get("token") }),
    })));
    if (result) { form.reset(); router.refresh(); }
  }

  async function loadRepos() {
    const body = await run(async () => responseJson(await fetch("/api/v1/github/repositories")));
    if (body) setRepos(body.repositories as Repo[]);
  }

  async function inspect(repo: string) {
    setSelected(repo);
    setFile(null);
    setProposal(null);
    const body = await run(async () => responseJson(await fetch(`/api/v1/github/repository?repo=${encodeURIComponent(repo)}`)));
    if (body) setOverview(body as Overview);
  }

  async function createIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!issueOperation.current) issueOperation.current = crypto.randomUUID();
    const body = await run(async () => responseJson(await fetch("/api/v1/github/issues", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: selected, title: data.get("title"), body: data.get("body"), idempotencyKey: issueOperation.current, confirm: data.get("confirm") === "on" }),
    })));
    if (body) { issueOperation.current = ""; form.reset(); setOutcome(`GitHub API: issue #${String(body.number)} created or reconciled.`); await inspect(selected); }
  }

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!branchOperation.current) branchOperation.current = crypto.randomUUID();
    const body = await run(async () => responseJson(await fetch("/api/v1/github/branches", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: selected, base: data.get("base"), branch: data.get("branch"), idempotencyKey: branchOperation.current, confirm: data.get("confirm") === "on" }),
    })));
    if (body) { branchOperation.current = ""; setOutcome(`GitHub API: branch ${String(body.branch)} ${String(body.outcome)} at ${String(body.sha)}.`); await inspect(selected); }
  }

  async function inspectFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const ref = String(data.get("ref"));
    const path = String(data.get("path"));
    const body = await run(async () => responseJson(await fetch(`/api/v1/github/files?repo=${encodeURIComponent(selected)}&ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`)));
    if (body) setFile(body as unknown as FileResult);
  }

  async function previewChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const request = { repo: selected, ref: String(data.get("branch")), path: String(data.get("path")), content: String(data.get("content")) };
    const body = await run(async () => responseJson(await fetch("/api/v1/github/changes/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    })));
    if (body) {
      changeOperation.current = "";
      setProposal({ preview: body as unknown as Preview, message: String(data.get("message")) });
      setOutcome("Preview generated from an immutable commit snapshot. No GitHub write was made.");
    }
  }

  async function applyChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!proposal) return;
    const data = new FormData(event.currentTarget);
    if (!changeOperation.current) changeOperation.current = crypto.randomUUID();
    const body = await run(async () => responseJson(await fetch("/api/v1/github/changes/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: selected, branch: proposal.preview.ref, path: proposal.preview.path, content: proposal.preview.after.content, expectedSha: proposal.preview.before?.sha ?? null, message: proposal.message, idempotencyKey: changeOperation.current, confirm: data.get("confirm") === "on" }),
    })));
    if (body) {
      changeOperation.current = "";
      setOutcome(`GitHub API: file change ${String(body.outcome)} in commit ${String(body.commitSha)}. No merge was requested.`);
      setProposal(null);
    }
  }

  async function createDraftPull(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!pullOperation.current) pullOperation.current = crypto.randomUUID();
    const body = await run(async () => responseJson(await fetch("/api/v1/github/pulls", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: selected, title: data.get("title"), body: data.get("body"), head: data.get("head"), base: data.get("base"), idempotencyKey: pullOperation.current, confirm: data.get("confirm") === "on" }),
    })));
    if (body) { pullOperation.current = ""; form.reset(); setOutcome(`GitHub API: draft PR #${String(body.number)} ${String(body.outcome)}. It was not merged.`); await inspect(selected); }
  }

  return <div className="grid grid-2">
    <section className="card card-pad">
      <h2>{connected ? `Connected as ${login}` : "Connect GitHub"}</h2>
      <p className="subtitle">Use a short-lived GitHub App installation token where possible. Tokens are encrypted and never returned.</p>
      {!connected ? <form className="form" onSubmit={connect}>
        <label className="label">Token<input className="input" type="password" name="token" required autoComplete="off" /></label>
        <button className="button button-primary" disabled={pending}>Validate and connect</button>
      </form> : <button className="button button-primary" disabled={pending} onClick={loadRepos}>{pending ? "Working…" : "List authorized repositories"}</button>}
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {outcome && <div className="notice" style={{ marginTop: 12 }}>{outcome}</div>}
      <div className="list" style={{ marginTop: 14 }}>{repos.map((repo) => <button key={repo.full_name} className="list-row button-ghost" onClick={() => inspect(repo.full_name)}>
        <span className="list-main"><span className="list-title">{repo.full_name}</span><span className="list-meta">{repo.private ? "Private" : "Public"} · {repo.default_branch}</span></span><span>→</span>
      </button>)}</div>
    </section>

    <section className="card card-pad">
      <h2>Repository workspace</h2>
      {!overview ? <div className="empty"><strong>No repository selected</strong><span>Load and select an authorized repository.</span></div> : <div key={selected}>
        <p className="subtitle">{selected}. Writes call official GitHub APIs only after exact confirmation. NEXUS never merges automatically.</p>
        <div className="grid grid-3">
          <div className="metric"><p className="metric-label">Branches</p><p className="metric-value">{overview.branches?.length ?? 0}</p></div>
          <div className="metric"><p className="metric-label">Open issues</p><p className="metric-value">{overview.issues?.length ?? 0}</p></div>
          <div className="metric"><p className="metric-label">Open PRs</p><p className="metric-value">{overview.pulls?.length ?? 0}</p></div>
        </div>

        <form className="form" onSubmit={createBranch}>
          <h3>Create branch</h3>
          <label className="label">Base ref<input className="input" name="base" defaultValue={defaultBranch} required /></label>
          <label className="label">New branch<input className="input" name="branch" placeholder="nexus/exact-change" required /></label>
          <label className="check"><input type="checkbox" name="confirm" required /><span>I authorize creation of this exact non-default branch.</span></label>
          <button className="button" disabled={pending}>Create branch</button>
        </form>

        <form className="form" onSubmit={inspectFile}>
          <h3>Inspect text file</h3>
          <label className="label">Explicit ref or SHA<input className="input" name="ref" defaultValue={defaultBranch} required /></label>
          <label className="label">Path<input className="input" name="path" placeholder="README.md" required /></label>
          <button className="button" disabled={pending}>Read immutable snapshot</button>
        </form>
        {file && <div className="form"><p className="list-meta">Resolved commit {file.resolvedCommitSha} · file SHA {file.sha} · {file.size} bytes</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{file.content}</pre></div>}

        <form className="form" onSubmit={previewChange}>
          <h3>Propose one exact text-file change</h3>
          <label className="label">Change branch<input className="input" name="branch" placeholder="nexus/exact-change" required /></label>
          <label className="label">Path<input className="input" name="path" placeholder="README.md" required /></label>
          <label className="label">Complete new UTF-8 content<textarea className="textarea" name="content" /></label>
          <label className="label">Commit message<input className="input" name="message" required maxLength={256} /></label>
          <button className="button" disabled={pending}>Generate exact preview</button>
        </form>
        {proposal && <div className="form">
          <h3>Exact before and after</h3>
          <p className="list-meta">Proposal hash {proposal.preview.proposalHash} · snapshot {proposal.preview.resolvedCommitSha}</p>
          <label className="label">Before<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{proposal.preview.before?.content ?? "(new file)"}</pre></label>
          <label className="label">After<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{proposal.preview.after.content}</pre></label>
          <form className="form" onSubmit={applyChange}>
            <label className="check"><input type="checkbox" name="confirm" required /><span>I authorize this exact content, path, branch, and commit. Reject if the file SHA changed.</span></label>
            <button className="button button-primary" disabled={pending || !proposal.preview.changed}>Apply exact file change</button>
          </form>
        </div>}

        <form className="form" onSubmit={createDraftPull}>
          <h3>Open draft pull request</h3>
          <label className="label">Head branch<input className="input" name="head" required /></label>
          <label className="label">Base branch<input className="input" name="base" defaultValue={defaultBranch} required /></label>
          <label className="label">Title<input className="input" name="title" required /></label>
          <label className="label">Body<textarea className="textarea" name="body" /></label>
          <label className="check"><input type="checkbox" name="confirm" required /><span>I authorize this exact draft PR. NEXUS will not merge it.</span></label>
          <button className="button" disabled={pending}>Create draft PR</button>
        </form>

        <form className="form" onSubmit={createIssue}>
          <h3>Create issue</h3>
          <label className="label">Title<input className="input" name="title" required /></label>
          <label className="label">Body<textarea className="textarea" name="body" /></label>
          <label className="check"><input type="checkbox" name="confirm" required /><span>I authorize this exact external write to {selected}.</span></label>
          <button className="button" disabled={pending}>Create issue</button>
        </form>
      </div>}
    </section>
  </div>;
}
