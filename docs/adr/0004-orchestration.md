# ADR 0004: Database-backed orchestration before Temporal

- Status: accepted, with adoption trigger
- Date: 2026-10-29

## Context

NEXUS needs a queryable task DAG, structured collaboration, policy checks, budgets, cancellation, and recovery. Temporal provides stronger distributed workflow guarantees but would still require an application database projection and a separate service.

## Decision

Use transactional task, dependency, attempt, message, event, budget, and idempotency records in SQLite. Workers claim ready tasks using short leases and fencing tokens. All limits are enforced by trusted application code and database constraints. Use explicit terminal states and at-least-once external-effect semantics.

## Consequences

NEXUS owns scheduler correctness and must test crash recovery. Adopt Temporal when workflows become multi-region, span many services for days, or custom timers/recovery dominate development. Persisted contracts are designed to survive that migration.
