import { ModelPricingForm } from "@/components/model-pricing-form";
import { requireSession } from "@/src/core/session";
import { listModels } from "@/src/modules/gateway/connections";

export default async function GatewayPage() {
  const session = await requireSession();
  const models = listModels(session.user.id);
  return <main className="content"><header className="page-head"><div><p className="eyebrow">Model Gateway</p><h1>Live capability registry</h1><p className="subtitle">Entries come from provider discovery. Unsupported or unverified capabilities remain unknown; prices are never inferred.</p></div></header>
    <ModelPricingForm models={models.map((model) => ({ id: String(model.id), label: `${String(model.provider)} · ${String(model.displayName)}` }))} />
    <div className="card table-wrap"><table><thead><tr><th>Provider</th><th>Model</th><th>Connection</th><th>Availability</th><th>Capabilities</th><th>Pricing</th><th>Observed</th></tr></thead><tbody>{models.length ? models.map((model) => <tr key={String(model.id)}><td>{String(model.provider)}</td><td><strong>{String(model.displayName)}</strong><div className="hint mono">{String(model.modelId)}</div></td><td>{String(model.connectionLabel)}</td><td><span className={`status status-${model.availability}`}>{String(model.availability)}</span></td><td>{Object.entries(JSON.parse(String(model.capabilitiesJson))).map(([name, state]) => <div className="hint" key={name}>{name}: {String(state)}</div>)}</td><td>{model.inputPriceMicrosPerMillion == null ? <span className="hint">Unknown</span> : `${model.pricingCurrency} ${model.inputPriceMicrosPerMillion}/M in`}</td><td>{model.metadataObservedAt ? new Date(String(model.metadataObservedAt)).toLocaleString() : "—"}</td></tr>) : <tr><td colSpan={7}><div className="empty"><strong>No models discovered</strong><span>Validate a provider connection to populate this registry.</span></div></td></tr>}</tbody></table></div>
  </main>;
}
