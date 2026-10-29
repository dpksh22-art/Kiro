import { requireSession } from "@/src/core/session";
import { listConnections } from "@/src/modules/gateway/connections";
import { SUPPORTED_PROVIDERS } from "@/src/modules/gateway/adapters";
import { ConnectionManager } from "@/components/connection-manager";

export default async function ConnectionsPage() {
  const session = await requireSession();
  return <main className="content"><header className="page-head"><div><p className="eyebrow">Provider Connections</p><h1>Connect inference providers</h1><p className="subtitle">Official API credentials and local endpoints only. Consumer subscriptions do not imply API entitlement.</p></div></header><ConnectionManager connections={listConnections(session.user.id)} providers={[...SUPPORTED_PROVIDERS]} /></main>;
}
