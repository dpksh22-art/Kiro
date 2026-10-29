import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getConfig } from "@/src/core/config";

const globalDatabase = globalThis as typeof globalThis & {
  nexusDatabase?: Database.Database;
};

export function getDatabasePath(): string {
  const configured = getConfig().NEXUS_DATABASE_PATH;
  return configured === ":memory:" ? configured : resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

export function getDb(): Database.Database {
  if (!globalDatabase.nexusDatabase) {
    const path = getDatabasePath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    globalDatabase.nexusDatabase = db;
  }
  return globalDatabase.nexusDatabase;
}

export function closeDbForTests(): void {
  globalDatabase.nexusDatabase?.close();
  globalDatabase.nexusDatabase = undefined;
}
