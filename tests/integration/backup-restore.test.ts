import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BackupError, createBackup, verifyBackup } from "@/src/core/backup";
import { getDb } from "@/src/core/database";
import { uploadArtifact } from "@/src/modules/artifacts/service";
import { createConnection } from "@/src/modules/gateway/connections";
import { createMemory } from "@/src/modules/workspace/memory";
import { createProject } from "@/src/modules/workspace/service";
import { getTestUser } from "@/tests/helpers";

const stream = (text: string) => new Blob([text]).stream();

describe("online backup and isolated restore evidence", () => {
  it("backs up a representative fixture, verifies hashes/counts/decryption, and rejects tampering and a wrong key", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-backup-integration-"));
    const originalKey = process.env.NEXUS_MASTER_KEY;
    try {
      const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString();
      const projectId = createProject(userId, `Backup ${randomUUID()}`);
      createMemory(userId, { projectId, kind: "decision", content: "Backup fixtures retain explicit memory.", retentionPolicy: "permanent" });
      const connectionId = createConnection(userId, { provider: "openai", label: `Backup ${randomUUID()}`, apiKey: "backup-fixture-secret" });
      db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
      const runId = randomUUID();
      db.prepare(`INSERT INTO task_runs (id,user_id,project_id,title,goal,mode,status,created_at,updated_at)
        VALUES (?,?,?,'backup run','prove persistence','team','succeeded',?,?)`).run(runId, userId, projectId, now, now);
      const reportId = randomUUID();
      db.prepare(`INSERT INTO research_reports (id,user_id,run_id,title,body,citation_map_json,status,created_at)
        VALUES (?,?,?,'backup research','stored evidence','{}','evidence_only',?)`).run(reportId, userId, runId, now);
      const artifact = await uploadArtifact({ userId, projectId, filename: "backup-evidence.txt", declaredMediaType: "text/plain", stream: stream("verified backup artifact bytes") });

      const backup = await createBackup(root, new Date("2026-03-01T12:00:00.000Z"));
      expect(backup.bundleDir.startsWith(root)).toBe(true);
      expect(backup.manifest.counts).toMatchObject({ user: 1 });
      expect(backup.manifest.counts.projects).toBeGreaterThan(0);
      expect(backup.manifest.counts.task_runs).toBeGreaterThan(0);
      expect(backup.manifest.counts.research_reports).toBeGreaterThan(0);
      expect(backup.manifest.counts.project_memories).toBeGreaterThan(0);
      expect(backup.manifest.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ sha256: artifact.contentHash })]));
      const manifestText = await readFile(join(backup.bundleDir, "manifest.json"), "utf8");
      expect(manifestText).not.toContain("backup-fixture-secret");
      expect(manifestText).not.toContain("NEXUS_MASTER_KEY");
      expect(manifestText).not.toContain("encrypted_credential");

      const verified = await verifyBackup(backup.bundleDir);
      expect(verified).toMatchObject({ ok: true, database: { integrity: "ok", foreignKeys: "ok" }, artifacts: { hashes: "ok" }, credentials: { status: "verified" } });
      expect(verified.counts).toEqual(backup.manifest.counts);
      expect(verified.credentials.checked).toBeGreaterThan(0);

      const artifactEntry = backup.manifest.artifacts.find((entry) => entry.sha256 === artifact.contentHash)!;
      const bundledArtifact = join(backup.bundleDir, "artifacts", ...artifactEntry.storagePath.split("/"));
      const originalBytes = await readFile(bundledArtifact);
      await writeFile(bundledArtifact, "tampered");
      await expect(verifyBackup(backup.bundleDir)).rejects.toMatchObject<Partial<BackupError>>({ code: "artifact_tampered" });
      await writeFile(bundledArtifact, originalBytes);

      process.env.NEXUS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
      await expect(verifyBackup(backup.bundleDir)).rejects.toMatchObject<Partial<BackupError>>({ code: "credential_decryption_failed" });
      process.env.NEXUS_MASTER_KEY = originalKey;
      await expect(verifyBackup(backup.bundleDir)).resolves.toMatchObject({ ok: true });
    } finally {
      if (originalKey === undefined) delete process.env.NEXUS_MASTER_KEY; else process.env.NEXUS_MASTER_KEY = originalKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses relative, live-source-overlapping, and symlink targets", async () => {
    await expect(createBackup("relative-backups")).rejects.toMatchObject<Partial<BackupError>>({ code: "absolute_path_required" });
    await expect(createBackup(join(process.cwd(), "data", "vitest-artifacts", "backups"))).rejects.toMatchObject<Partial<BackupError>>({ code: "source_overlap" });
    const root = await mkdtemp(join(tmpdir(), "nexus-backup-symlink-"));
    const link = `${root}-link`;
    try {
      await symlink(root, link, "dir");
      await expect(createBackup(link)).rejects.toMatchObject<Partial<BackupError>>({ code: "symlink_rejected" });
    } finally {
      await rm(link, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe("authenticated backup manifest", () => {
  it("rejects missing/wrong signing keys and coordinated database, manifest, and checksum tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-backup-auth-"));
    const originalSigningKey = process.env.NEXUS_BACKUP_SIGNING_KEY;
    try {
      const backup = await createBackup(root);
      delete process.env.NEXUS_BACKUP_SIGNING_KEY;
      await expect(verifyBackup(backup.bundleDir)).rejects.toMatchObject<Partial<BackupError>>({ code: "backup_signing_key_missing" });
      process.env.NEXUS_BACKUP_SIGNING_KEY = Buffer.alloc(32, 9).toString("base64");
      await expect(verifyBackup(backup.bundleDir)).rejects.toMatchObject<Partial<BackupError>>({ code: "manifest_authentication_failed" });
      process.env.NEXUS_BACKUP_SIGNING_KEY = originalSigningKey;

      const databasePath = join(backup.bundleDir, "database.sqlite");
      const tampered = new Database(databasePath);
      tampered.prepare("UPDATE user SET name='coordinated tamper'").run();
      tampered.close();
      const databaseBytes = await readFile(databasePath);
      const manifestPath = join(backup.bundleDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { database: { byteSize: number; sha256: string }; counts: Record<string, number> };
      manifest.database.byteSize = databaseBytes.byteLength;
      manifest.database.sha256 = createHash("sha256").update(databaseBytes).digest("hex");
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(manifestPath, manifestBytes);
      await writeFile(join(backup.bundleDir, "manifest.sha256"), `${createHash("sha256").update(manifestBytes).digest("hex")}  manifest.json\n`);
      await expect(verifyBackup(backup.bundleDir)).rejects.toMatchObject<Partial<BackupError>>({ code: "manifest_authentication_failed" });
    } finally {
      if (originalSigningKey === undefined) delete process.env.NEXUS_BACKUP_SIGNING_KEY; else process.env.NEXUS_BACKUP_SIGNING_KEY = originalSigningKey;
      await rm(root, { recursive: true, force: true });
    }
  });
});
