import { describe, expect, it } from "vitest";
import { getDb } from "@/src/core/database";

describe("database migrations", () => {
  it("creates auth and application tables with foreign keys enabled", () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    for (const expected of ["user", "session", "provider_connections", "models", "task_runs", "tasks", "task_events", "research_sources", "audit_events"]) expect(names.has(expected)).toBe(true);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
