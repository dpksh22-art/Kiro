# Cost and resource accounting

## Enforcement boundary

NEXUS enforces budgets in trusted server code. Browser values only request policies; SQLite transactions decide admission immediately before model dispatch, broker execution, or task-attempt claim. A `budget_exceeded` error is terminal for an agent attempt and does not trigger a more expensive model or tool fallback.

## Monetary budgets

Monetary policies retain the beta behavior from the original ledger:

- Currency is USD and values are stored as integer millionths of a dollar.
- Policies can cover all owner activity, an owned project, an owned provider, or the existing combined project/provider scope.
- Periods are per task, UTC day, or UTC month.
- An applicable policy blocks a model whose price has not been documented in Model Gateway. Missing price never means zero.
- A reservation uses estimated prompt tokens and the requested maximum output. Settlement stores provider-reported tokens and billed cost when supplied.
- `reserved` monetary rows count toward admission. `settled` rows represent completed calls. `released` rows count toward neither admission nor the dashboard settled-cost total.

The command-center **Month settled cost** metric includes only `settled` rows. It uses provider billed cost when available and the final estimate otherwise. It is an operational ledger, not a provider invoice. Ambiguous network failures and provider-side billing semantics still require reconciliation against provider records.

## Resource budgets

Resource policies use integer units:

- `model_calls`: one provider request consumed when adapter dispatch begins.
- `input_tokens`: the estimated prompt tokens reserved before dispatch, then provider-reported actual input tokens when available.
- `output_tokens`: the requested maximum output tokens reserved before dispatch, then provider-reported actual output tokens when available.
- `tool_calls`: one validated broker operation when broker execution begins.
- `task_starts`: one durable task attempt when the worker claims it.

Scopes are normalized and independently enforced:

- `owner`: all matching owner usage.
- `project`: usage attributed to one owned project.
- `provider`: usage sent to one provider for which the owner has a connection.
- `run`: usage sharing one durable run ID.
- `agent`: usage attributed to one stored agent ID.

The UI and public budget API create owner, owned-project, and owned-provider policies. Run and agent policies are backend-normalized scopes used by runtime controls. Custom agents also support snapshotted per-run caps for model calls, output tokens, and tool calls. Every initial or delegated task for that agent and run shares those caps. Delegation cannot create a new run allowance.

Periods have these exact partition keys:

- `task`: task ID. Interactive chat uses the assistant message ID, and research synthesis uses the report ID as the task-equivalent key.
- `run`: durable run ID. Activity without a run does not match a run-period policy.
- `daily`: the UTC day beginning at `00:00:00.000Z`.
- `monthly`: the UTC calendar month beginning on day one at `00:00:00.000Z`.

All matching policies must admit a reservation. Overlapping policies therefore apply as independent ceilings rather than additive quota.

## Reservation lifecycle

`resource_usage_records` is the non-monetary ledger:

- `reserved`: provisional units that count against admission.
- `consumed`: completed or begun work. Model tokens settle to actual usage when supplied. If actual token usage is absent, the conservative reservation becomes consumed usage.
- `released`: work that did not proceed or could not be established. Released units remain as evidence but do not count against admission.

Model-call units are consumed at the dispatch boundary. A terminal provider response settles monetary and token usage immediately, before later tool execution, citation checks, structured-output validation, or task persistence. Pre-dispatch validation/admission failures may release reservations. Cancellation, timeout, process loss, lease recovery, or an ambiguous network failure after dispatch conservatively consumes reserved tokens and estimated cost with `accounting_outcome='unknown'`; it never makes possibly billed work free. Expiry recovery follows the same dispatched-at fence. Provider invoices remain authoritative for reconciliation.
