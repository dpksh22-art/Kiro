import Link from "next/link";
import { requireSession } from "@/src/core/session";
import { ensureDefaultProject, getConversation, listConversations } from "@/src/modules/workspace/service";
import { listModels } from "@/src/modules/gateway/connections";
import { ChatWorkspace } from "@/components/chat-workspace";
import { DeleteButton } from "@/components/delete-button";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ conversation?: string }> }) {
  const session = await requireSession(); const projectId = ensureDefaultProject(session.user.id); const { conversation: id } = await searchParams;
  const conversation = id ? getConversation(session.user.id, id) : null;
  const conversations = listConversations(session.user.id, projectId).slice(0, 8);
  const models = listModels(session.user.id).map((item) => ({ connectionId: String(item.connectionId), provider: String(item.provider), connectionLabel: String(item.connectionLabel), modelId: String(item.modelId), displayName: String(item.displayName) }));
  return <main className="content"><header className="page-head"><div><p className="eyebrow">Unified Chat</p><h1>{conversation ? String(conversation.title) : "One prompt, your choice of minds"}</h1><p className="subtitle">Direct inference streams from the selected providers. Each answer keeps its own status, errors, and usage.</p></div>{conversation && <Link href="/chat" className="button">New thread</Link>}</header>
    {conversations.length > 0 && <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 18 }}>{conversations.map((item) => <Link className="button button-ghost" key={String(item.id)} href={`/chat?conversation=${item.id}`}>{String(item.title).slice(0, 26)}</Link>)}</div>}
    {conversation && <div style={{ marginBottom: 18 }}><DeleteButton endpoint={`/api/v1/conversations/${conversation.id}`} label="Delete conversation" confirmText="Delete this conversation and all of its messages?" redirect="/chat" /></div>}
    <ChatWorkspace key={id ?? "new"} projectId={conversation ? String(conversation.projectId) : projectId} models={models} conversationId={conversation ? String(conversation.id) : undefined} messages={conversation?.messages as never[] | undefined} />
  </main>;
}
