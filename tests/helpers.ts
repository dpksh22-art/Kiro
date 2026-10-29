import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";

export function getTestUser(): string {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM user LIMIT 1").get() as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)").run(id, "Test Owner", "owner@test.local", now, now);
    return id;
  } catch {
    return (db.prepare("SELECT id FROM user LIMIT 1").get() as { id: string }).id;
  }
}
