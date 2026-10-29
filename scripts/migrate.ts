import { pathToFileURL } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../src/core/auth";
import { getDb, getDatabasePath } from "../src/core/database";

export async function migrate() {
  const authMigrations = await getMigrations(auth.options);
  await authMigrations.runMigrations();

  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const directory = resolve(process.cwd(), "db/migrations");
  const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?");
  const record = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");

  for (const file of files) {
    if (applied.get(file)) continue;
    const sql = readFileSync(resolve(directory, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
    console.log(`Applied ${file}`);
  }
  console.log(`Database ready at ${getDatabasePath()}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  migrate().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
