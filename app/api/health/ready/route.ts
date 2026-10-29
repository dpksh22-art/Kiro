import { getDb } from "@/src/core/database";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";

export function GET() {
  try {
    const db = getDb();
    const migration = db.prepare("SELECT 1 FROM schema_migrations WHERE id='0002_security_and_usage.sql'").get();
    if (!migration) throw new Error("Expected migration is missing.");
    db.transaction(() => {
      db.exec("CREATE TEMP TABLE IF NOT EXISTS readiness_probe (value TEXT NOT NULL)");
      db.prepare("INSERT INTO readiness_probe (value) VALUES (?)").run(new Date().toISOString());
      db.exec("DELETE FROM readiness_probe");
    })();
    const probe = "nexus-readiness-probe";
    if (decryptSecret(encryptSecret(probe)) !== probe) throw new Error("Credential encryption is unavailable.");
    return Response.json({ status: "ready", schema: "0002_security_and_usage.sql", storage: "writable", encryption: "available" });
  } catch {
    return Response.json({ status: "not_ready" }, { status: 503 });
  }
}
