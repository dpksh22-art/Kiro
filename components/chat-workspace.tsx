"use client";
import { FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Model = { connectionId: string; provider: string; connectionLabel: string; modelId: string; displayName: string };
type StoredMessage = { id: string; parentMessageId?: string | null; role: string; connectionId?: string | null; modelId?: string | null; status: string; content: string; errorMessage?: string | null };
type Turn = { id: string; prompt: string; answers: Array<{ id: string; label: string; status: string; content: string; error?: string }> };

function initialTurns(messages: StoredMessage[]): Turn[] {
  const users = messages.filter((message) => message.role === "user");
  return users.map((user) => ({ id: user.id, prompt: user.content, answers: messages.filter((message) => message.parentMessageId === user.id).map((answer) => ({ id: answer.id, label: answer.modelId ?? "Model", status: answer.status, content: answer.content, error: answer.errorMessage ?? undefined })) }));
}

export function ChatWorkspace({ projectId, models, conversationId: initialConversationId, messages = [] }: { projectId: string; models: Model[]; conversationId?: string; messages?: StoredMessage[] }) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [selected, setSelected] = useState<string[]>(models[0] ? [`${models[0].connectionId}::${models[0].modelId}`] : []);
  const [turns, setTurns] = useState<Turn[]>(() => initialTurns(messages));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const selectedModels = useMemo(() => selected.map((key) => models.find((model) => `${model.connectionId}::${model.modelId}` === key)).filter(Boolean) as Model[], [selected, models]);

  function toggle(key: string) { setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : current.length < 4 ? [...current, key] : current); }
  function updateAnswer(answerId: string, updater: (answer: Turn["answers"][number]) => Turn["answers"][number]) {
    setTurns((current) => current.map((turn) => ({ ...turn, answers: turn.answers.map((answer) => answer.id === answerId ? updater(answer) : answer) })));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const prompt = String(data.get("prompt") ?? "").trim();
    if (!prompt || selectedModels.length === 0) return;
    setError(""); setPending(true); controller.current = new AbortController();
    const optimisticId = crypto.randomUUID();
    setTurns((current) => [...current, { id: optimisticId, prompt, answers: [] }]);
    form.reset();
    try {
      const response = await fetch("/api/v1/chat", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.current.signal, body: JSON.stringify({ projectId, conversationId, prompt, mode: selectedModels.length > 1 ? "parallel" : "single", targets: selectedModels.map(({ connectionId, modelId }) => ({ connectionId, modelId })) }) });
      if (!response.ok || !response.body) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? "Unable to start chat."); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split("\n\n"); buffer = done ? "" : blocks.pop() ?? "";
        for (const block of blocks) {
          let eventName = "message"; let payload = "";
          for (const line of block.split("\n")) { if (line.startsWith("event:")) eventName = line.slice(6).trim(); if (line.startsWith("data:")) payload += line.slice(5).trim(); }
          if (!payload) continue;
          const item = JSON.parse(payload);
          if (eventName === "chat.created") {
            setConversationId(item.conversationId);
            setTurns((current) => current.map((turn) => turn.id === optimisticId ? { id: item.userMessageId, prompt: turn.prompt, answers: item.answers.map((answer: { answerId: string; provider: string; displayName: string }) => ({ id: answer.answerId, label: `${answer.displayName} · ${answer.provider}`, status: "queued", content: "" })) } : turn));
            router.replace(`/chat?conversation=${item.conversationId}`);
          } else if (eventName === "answer.started") updateAnswer(item.answerId, (answer) => ({ ...answer, status: "streaming" }));
          else if (eventName === "answer.delta") updateAnswer(item.answerId, (answer) => ({ ...answer, content: answer.content + item.text }));
          else if (eventName === "answer.completed") updateAnswer(item.answerId, (answer) => ({ ...answer, status: "completed" }));
          else if (eventName === "answer.failed" || eventName === "answer.cancelled") updateAnswer(item.answerId, (answer) => ({ ...answer, status: eventName === "answer.failed" ? "failed" : "cancelled", error: item.message }));
        }
        if (done) break;
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Chat failed.");
    } finally { setPending(false); controller.current = null; router.refresh(); }
  }

  return <div className="chat-shell">
    <section className="transcript" aria-live="off">
      {turns.length === 0 && <div className="empty"><strong>Your workspace is ready</strong><span>Select one model for a direct answer or up to four for side-by-side comparison.</span></div>}
      {turns.map((turn) => <article key={turn.id}>
        <div className="message message-user">{turn.prompt}</div>
        <div className={turn.answers.length > 1 ? "answer-grid section" : "section"}>{turn.answers.map((answer) => <section className="answer" key={answer.id}><header className="answer-head"><strong>{answer.label}</strong><span className={`status status-${answer.status}`}>{answer.status}</span></header><div className="answer-body">{answer.content || (answer.error ? <span className="error">{answer.error}</span> : <span className="hint">Waiting for output…</span>)}</div></section>)}</div>
      </article>)}
    </section>
    <form className="composer" onSubmit={submit}>
      <textarea className="textarea" name="prompt" aria-label="Message" placeholder={models.length ? "Ask NEXUS…" : "Connect and validate a provider first"} disabled={!models.length || pending} required />
      <div className="composer-controls"><details><summary className="button">{selected.length} model{selected.length === 1 ? "" : "s"}</summary><div className="card card-pad checkbox-list" style={{ position: "absolute", bottom: 62, width: 340 }}>{models.map((model) => { const key = `${model.connectionId}::${model.modelId}`; return <label className="check" key={key}><input type="checkbox" checked={selected.includes(key)} onChange={() => toggle(key)} /><span><strong>{model.displayName}</strong><span className="list-meta">{model.provider} · {model.connectionLabel}</span></span></label>; })}</div></details><span className="hint">{selected.length > 1 ? "Parallel comparison" : "Single model"}</span><span className="spacer" />{error && <span className="error" role="alert">{error}</span>}{pending ? <button type="button" className="button button-danger" onClick={() => controller.current?.abort()}>Stop</button> : <button className="button button-primary" disabled={!selected.length || !models.length}>Send</button>}</div>
    </form>
  </div>;
}
