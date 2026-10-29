# Agents and orchestration

## Registry

NEXUS creates fourteen built-in templates for each user: general assistant, research analyst, software architect, frontend developer, backend developer, security auditor, QA engineer, GitHub maintainer, data analyst, documentation writer, business researcher, product strategist, code reviewer, and infrastructure operator. Users can create custom agents from the UI.

Each stored agent has a role, instructions, allowed-tool declarations, permission policy, budget policy, maximum duration, maximum turns, memory scope, output schema, completion criteria, and audit timestamps. The current runtime executes one bounded model turn per task, so `maxTurns` is an upper bound that is not reached by the first implementation.

## Run lifecycle

1. The API validates project, agents, connections, and models against the session owner.
2. It creates one independent root task per selected agent.
3. It creates a synthesis task with terminal dependencies on every root.
4. The worker claims up to the run's `maxParallelism`.
5. Each attempt has a unique lease token and attempt number.
6. Agents emit structured events such as `AgentStarted`, `AgentProgress`, `ArtifactProduced`, `TaskCompleted`, `TaskFailed`, and `TaskRetryScheduled`.
7. Dependency reconciliation changes synthesis from `blocked` to `ready` only after all roots terminate.
8. The coordinator receives persisted independent outputs and must preserve material disagreement and limitations.
9. The run finishes when every task is terminal.

## Safety limits

- Up to eight selected agents per UI/API run.
- Up to four model targets.
- Run schema limits parallelism to eight, tasks to 32 by default, and depth to four.
- Each task has bounded attempts and a stored execution duration.
- A repeated failure backs off before retry.
- Cancellation propagates to queued and active tasks.
- Expired leases recover after a worker crash; cancelled leases finalize rather than retry.
- Usage is reserved before a model call.
- Model-proposed actions are plain output. The first runtime does not execute shell, browser, GitHub, or infrastructure tool calls.

## Durability and recovery

Task state, attempts, dependencies, outputs, and events live in SQLite. Browser refresh does not affect them. `instrumentation.ts` starts the embedded worker when the Node server starts. The worker scans expired leases and ready work. SQLite permits one writing NEXUS application replica.

## Current collaboration scope

Agents collaborate through persisted dependency outputs and a final synthesis task. The schema also includes durable agent messages with sender, recipient, correlation, reply, hop count, and body, but the first UI does not expose free-form agent messaging. This is intentional: arbitrary recursive delegation remains disabled until message permissions, progress detection, and per-child budgets have broader tests.
