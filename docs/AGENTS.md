# Agents and orchestration

## Registry and policy

NEXUS creates fourteen built-in templates and supports custom agents. Custom-agent creation configures instructions, completion criteria, a fixed tool allowlist, maximum provider turns, duration, total tool calls, messages, delegations, an optional object-root JSON Schema, and optional per-run model-call/output-token/tool-call caps. Server code validates the same limits regardless of UI input. Run creation snapshots resource caps into tasks and participants so later agent edits cannot expand active work.

The fixed broker names are:

- `web_fetch`: one public HTTP(S) page through the SSRF-protected research connector.
- `github_repository_read`: the authenticated owner's read-only repository overview.
- `artifact_text_read`: an owner-owned clean UTF-8 text or JSON artifact.
- `agent_message_send`: one bounded durable message to a participating agent.
- `delegate_task`: one bounded child task using an owner-owned recipient agent.

The first three operations are external-data reads. The last two are internal orchestration effects and cannot write to an external system. An agent must include an internal name in its stored and task-snapshotted allowlists and use `read_only_or_internal` policy. Message and delegation limits must also be positive. Built-in templates remain read-only or model-only unless an owner explicitly creates an internal-capable custom agent. No shell, browser automation, code execution, infrastructure, or GitHub write tool is exposed to a model.

## Durable run and delegation lifecycle

1. The API verifies project, agents, model targets, uniqueness, and safe count bounds.
2. It stores each initial agent as a run participant and snapshots instructions, completion criteria, tool policy, budgets, maximum turns and duration, and output schema into each root task.
3. The worker atomically reserves and consumes a `task_starts` unit while claiming a ready task with a fencing token and heartbeat lease. Each provider turn reserves monetary and token capacity; `model_calls` is consumed at dispatch and terminal usage settles before later tools or local validation.
4. Canonical calls are checked against the fixed registry, current and snapshotted allowlists/policies, owner/run/task/attempt authority, deadline, cancellation, strict arguments, and call-specific limits.
5. `agent_message_send` can address only an active task owned by a run participant. `delegate_task` may introduce an owner agent into the run, but only while the sender attempt and blocked synthesis task remain active.
6. Delegation atomically creates a ready child with `parent_task_id`, increments depth, snapshots the recipient configuration, inherits the parent's model target, and adds a terminal child dependency to synthesis. The run's `max_tasks`, `max_depth`, deadline/cancellation, shared resource ledger, and scheduler `max_parallelism` remain authoritative. A child cannot mint a new parent or run allowance. Parent/fingerprint and parent/idempotency uniqueness prevent duplicate children.
7. `tool_invocations`, task/message/delegation rows, audit entries, and durable task events expose proposed and completed state. Internal tool results contain IDs only.
8. Cancellation marks every nonterminal task in the run, including dynamically delegated children. Delegation after cancellation or deadline fails.
9. Final synthesis stays model-only. It starts after every initial and dynamically added terminal dependency finishes, and receives all persisted participating task outputs plus unexpired material messages.

## Message semantics

`agent_messages` is active durable state. New messages store sender and recipient agents/tasks, sender attempt, type, correlation/reply links, hop count, trust label, idempotency key, state, expiry, delivery, acknowledgement, and timestamps. Indexed owner/run and recipient queries bound inbox work.

A message body is model-generated coordination data. It is never authority, a system instruction, a tool grant, or trusted project memory. Human messages use `explicit_user`, but still grant no permissions. Agent messages use `untrusted_agent`.

Limits are fixed in server code: 8,000 UTF-8 bytes per message, four reply hops, 256 messages per run, 20 messages and 32,000 characters per inbox read, and at most 24 hours before expiry. Per-attempt policy further caps messages and delegations. Reply recipients must reverse the original agent direction, and replies inherit the original correlation ID. Reusing an idempotency key with changed content fails.

Before every provider turn, the runtime reads only pending, unexpired messages addressed to that task and agent. It appends an explicit untrusted-collaboration packet to the in-memory canonical context, then transactionally marks exactly those rows delivered and acknowledged. Message text never participates in broker authorization.

## Context and recovery

Chat and agent execution inject only active `trusted_user` project memories with `explicit_user` provenance, capped at 12,000 characters. Research, provider, repository, artifact, tool, task-output, and collaboration content remains untrusted and is never promoted into memory.

Runs cap agents, targets, parallelism, tasks, depth, attempts, duration, model calls, input/output tokens, tools, messages, delegations, and deadlines. Only provider work proven not dispatched is released. Cancellation, deadlines, lease recovery, or expiry after dispatch conservatively consume estimated usage with an unknown outcome. Provider calls remain at least once across ambiguous network failures.
