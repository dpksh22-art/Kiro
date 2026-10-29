# ADR 0001: Modular monolith with isolated workers

- Status: accepted
- Date: 2026-10-29

## Context

The repository is empty. NEXUS is a personal AI operating system that needs a secure web UI, server-only credentials, streaming, durable tasks, and several external integrations. A microservice fleet would add deployment and consistency costs before measured scale requires it.

## Decision

Use a TypeScript modular monolith on Next.js 16 and Node.js 22. Route handlers expose versioned HTTP and SSE APIs. Domain modules own gateway, conversation, orchestration, research, GitHub, usage, and audit behavior. Background task execution uses the same codebase with database leases and bounded concurrency. Provider and connector interfaces prevent vendor-specific logic from entering orchestration.

## Consequences

A single deployable is easy to run and test. Module boundaries need review because the runtime does not enforce process isolation. Effectful tools remain behind explicit policy checks. A later worker split does not change stored task contracts.
