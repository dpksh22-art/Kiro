import { getDb } from "@/src/core/database";
import { getConfig } from "@/src/core/config";
import { LATEST_MIGRATION_ID, migrationManifest } from "@/src/core/schema";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";
import { checkArtifactStorage } from "@/src/modules/artifacts/service";

export async function GET() {
  try {
    const db = getDb();
    const expectedMigrations = migrationManifest().map((migration) => migration.id);
    const appliedMigrations = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map((row) => row.id));
    if (expectedMigrations.some((migration) => !appliedMigrations.has(migration))) throw new Error("Expected migration is missing.");
    db.transaction(() => {
      db.exec("CREATE TEMP TABLE IF NOT EXISTS readiness_probe (value TEXT NOT NULL)");
      db.prepare("INSERT INTO readiness_probe (value) VALUES (?)").run(new Date().toISOString());
      db.exec("DELETE FROM readiness_probe");
    })();
    await checkArtifactStorage();
    const probe = "nexus-readiness-probe";
    if (decryptSecret(encryptSecret(probe)) !== probe) throw new Error("Credential encryption is unavailable.");
    const signingKey = getConfig().NEXUS_BACKUP_SIGNING_KEY;
    if (!signingKey || Buffer.from(signingKey, "base64").length < 32) throw new Error("Backup authentication is unavailable.");
    return Response.json({ status: "ready", schema: LATEST_MIGRATION_ID, database: "writable", artifacts: "writable", encryption: "available", backupAuthentication: "available" });
  } catch {
    return Response.json({ status: "not_ready" }, { status: 503 });
  }
}
