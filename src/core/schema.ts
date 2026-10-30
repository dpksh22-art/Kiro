import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const LATEST_MIGRATION_ID = "0010_security_reliability_boundaries.sql";

export type MigrationDescriptor = { id: string; sha256: string };

export function migrationDirectory(): string {
  return resolve(process.cwd(), "db/migrations");
}

export function migrationManifest(): MigrationDescriptor[] {
  const directory = migrationDirectory();
  return readdirSync(directory).filter((file) => file.endsWith(".sql")).sort().map((id) => ({
    id,
    sha256: createHash("sha256").update(readFileSync(resolve(directory, id))).digest("hex"),
  }));
}
