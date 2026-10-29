# ADR 0002: SQLite WAL for the initial personal deployment

- Status: accepted, with scale trigger
- Date: 2026-10-29

## Context

NEXUS must run in the available environment without an external database account. Its initial target is a single-user or small trusted personal deployment on one application node. Durable task state matters more than horizontal write throughput.

## Decision

Use SQLite in WAL mode, foreign keys, busy timeout, reviewed SQL migrations, short transactions, and database-backed task leases. Persist artifacts on a mounted local volume by content hash. Keep SQL and repository interfaces portable. PostgreSQL is the required migration target before multi-node active-active workers, sustained high write concurrency, or stronger regional recovery objectives.

## Consequences

The complete application can start locally with one persistent volume. SQLite is not presented as a horizontally scalable database. Only one application replica may write the database. Backups must include the database and artifact directory. External effects remain at-least-once and idempotency is mandatory.
