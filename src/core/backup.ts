import { createDecipheriv, createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { getConfig } from "@/src/core/config";
import { getDatabasePath, getDb } from "@/src/core/database";
import { LATEST_MIGRATION_ID, migrationManifest } from "@/src/core/schema";
import { withArtifactSnapshotLock } from "@/src/modules/artifacts/service";

const BUNDLE_FORMAT = "nexus-backup";
const BUNDLE_VERSION = 2;
const MANIFEST_MAC_CONTEXT = Buffer.from("nexus-backup-manifest-v2\0", "utf8");
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STORAGE_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const COUNT_TABLES = ["user", "provider_connections", "projects", "conversations", "messages", "agents", "task_runs", "tasks", "research_sources", "research_reports", "project_memories", "artifacts", "attachments"] as const;

export class BackupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BackupError"; }
}

const manifestSchema = z.object({
  format: z.literal(BUNDLE_FORMAT), version: z.literal(BUNDLE_VERSION), createdAt: z.iso.datetime(), latestMigration: z.string(),
  migrations: z.array(z.object({ id: z.string(), sha256: z.string().regex(HASH_PATTERN) }).strict()),
  database: z.object({ file: z.literal("database.sqlite"), byteSize: z.number().int().nonnegative(), sha256: z.string().regex(HASH_PATTERN) }).strict(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  artifacts: z.array(z.object({ storagePath: z.string(), byteSize: z.number().int().nonnegative(), sha256: z.string().regex(HASH_PATTERN) }).strict()),
}).strict();
export type BackupManifest = z.infer<typeof manifestSchema>;

export type BackupResult = { ok: true; bundleDir: string; manifest: BackupManifest; manifestSha256: string; manifestHmacSha256: string };
export type VerifyResult = {
  ok: true; bundleDir: string; database: { integrity: "ok"; foreignKeys: "ok"; sha256: string };
  schema: { latestMigration: string; migrations: number }; counts: Record<string, number>;
  artifacts: { files: number; bytes: number; hashes: "ok" };
  credentials: { status: "verified" | "not_exercised" | "skipped"; checked: number };
};

function sha256Bytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function backupSigningKey(): Buffer {
  const encoded = process.env.NEXUS_BACKUP_SIGNING_KEY;
  if (!encoded) throw new BackupError("backup_signing_key_missing", "NEXUS_BACKUP_SIGNING_KEY is required for authenticated backup creation and verification.");
  const key = Buffer.from(encoded, "base64");
  if (key.length < 32) throw new BackupError("backup_signing_key_invalid", "NEXUS_BACKUP_SIGNING_KEY must decode to at least 32 bytes.");
  return key;
}
function manifestHmac(bytes: Uint8Array): Buffer {
  return createHmac("sha256", backupSigningKey()).update(MANIFEST_MAC_CONTEXT).update(bytes).digest();
}
function parseManifestHmac(value: string): Buffer {
  const encoded = value.trim().split(/\s+/)[0] ?? "";
  if (!HASH_PATTERN.test(encoded)) throw new BackupError("manifest_authentication_failed", "Manifest authentication failed.");
  return Buffer.from(encoded, "hex");
}
async function sha256File(path: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash("sha256"); let byteSize = 0;
  for await (const chunk of createReadStream(path)) { const bytes = chunk as Buffer; byteSize += bytes.length; hash.update(bytes); }
  return { sha256: hash.digest("hex"), byteSize };
}

function contains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function assertNoSymlinkComponents(path: string, requireLeaf: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new BackupError("absolute_path_required", "Backup and restore paths must be absolute.");
  const normalized = resolve(path); const root = parse(normalized).root;
  const parts = normalized.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new BackupError("symlink_rejected", `Symbolic links are not allowed in backup paths: ${current}`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new BackupError("invalid_path", `A backup path parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (requireLeaf) throw new BackupError("path_not_found", `Required path does not exist: ${current}`);
        return;
      }
      throw error;
    }
  }
}

function artifactRootPath(): string { return resolve(process.cwd(), getConfig().NEXUS_ARTIFACT_ROOT); }

async function assertDisjointTarget(targetRoot: string): Promise<void> {
  const database = getDatabasePath(); const artifacts = artifactRootPath();
  if (database === ":memory:") throw new BackupError("memory_database", "An in-memory database cannot be backed up to a durable bundle.");
  const target = resolve(targetRoot);
  if (contains(artifacts, target) || contains(target, artifacts) || target === database || contains(target, database)) {
    throw new BackupError("source_overlap", "The backup target must not contain, equal, or sit inside a live data source.");
  }
  await assertNoSymlinkComponents(database, true);
  await assertNoSymlinkComponents(artifacts, false);
  await assertNoSymlinkComponents(target, false);
}

function validateStoragePath(storagePath: string): string {
  const match = STORAGE_PATTERN.exec(storagePath);
  if (!match || match[1] !== match[2]!.slice(0, 2)) throw new BackupError("invalid_artifact_path", `Invalid content-addressed artifact path: ${storagePath}`);
  return match[2]!;
}

async function copyRegularFile(source: string, destination: string): Promise<{ sha256: string; byteSize: number }> {
  await assertNoSymlinkComponents(source, true);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle;
  const hash = createHash("sha256"); let byteSize = 0;
  try {
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile()) throw new BackupError("non_regular_file", `Backup source is not a regular file: ${source}`);
    destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); byteSize += bytesRead;
      let offset = 0; while (offset < bytesRead) offset += (await destinationHandle.write(chunk, offset, bytesRead - offset)).bytesWritten;
    }
    await destinationHandle.sync();
    return { sha256: hash.digest("hex"), byteSize };
  } finally {
    await sourceHandle.close();
    await destinationHandle?.close();
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function rowCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(COUNT_TABLES.filter((table) => tableExists(db, table)).map((table) => {
    const row = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number };
    return [table, row.count];
  }));
}

function appliedMigrations(db: Database.Database): Array<{ id: string; sha256: string }> {
  if (!tableExists(db, "schema_migrations")) throw new BackupError("schema_missing", "The database has no application migration ledger.");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id));
  const known = migrationManifest();
  const unknown = [...applied].filter((id) => !known.some((migration) => migration.id === id));
  if (unknown.length) throw new BackupError("unknown_migration", `Applied migration files are unavailable: ${unknown.join(", ")}`);
  if (!applied.has(LATEST_MIGRATION_ID)) throw new BackupError("schema_outdated", `Database must be migrated through ${LATEST_MIGRATION_ID} before backup.`);
  return known.filter((migration) => applied.has(migration.id));
}

function artifactRows(db: Database.Database): Array<{ storagePath: string; byteSize: number; sha256: string }> {
  const deleting = tableExists(db, "artifacts") ? db.prepare("SELECT count(*) AS count FROM artifacts WHERE upload_state='deleting'").get() as { count: number } : { count: 0 };
  if (deleting.count) throw new BackupError("artifact_mutation_incomplete", "Backup refused while artifact deletion recovery is incomplete.");
  const rows = db.prepare(`SELECT storagePath,MAX(byteSize) AS byteSize,MIN(sha256) AS sha256,COUNT(DISTINCT sha256) AS hashCount,COUNT(DISTINCT byteSize) AS sizeCount FROM (
    SELECT storage_path AS storagePath,byte_size AS byteSize,content_hash AS sha256 FROM artifacts
    UNION ALL SELECT storage_path,byte_size,content_hash FROM attachments
  ) GROUP BY storagePath ORDER BY storagePath`).all() as Array<{ storagePath: string; byteSize: number; sha256: string; hashCount: number; sizeCount: number }>;
  for (const row of rows) if (row.hashCount !== 1 || row.sizeCount !== 1) throw new BackupError("artifact_metadata_conflict", `Conflicting metadata references artifact path ${row.storagePath}.`);
  return rows.map(({ storagePath, byteSize, sha256 }) => ({ storagePath, byteSize, sha256 }));
}

async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); }
}

export async function createBackup(targetRoot: string, now = new Date()): Promise<BackupResult> {
  if (!isAbsolute(targetRoot)) throw new BackupError("absolute_path_required", "Backup target must be an absolute directory.");
  await assertDisjointTarget(targetRoot);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(targetRoot, true);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const bundleName = `nexus-backup-${stamp}-${randomUUID().slice(0, 8)}`;
  const staging = join(targetRoot, `.${bundleName}.tmp`); const final = join(targetRoot, bundleName);
  await mkdir(staging, { mode: 0o700 });
  let published = false;
  try {
    const result = await withArtifactSnapshotLock(async () => {
      const databasePath = join(staging, "database.sqlite");
      await getDb().backup(databasePath);
      await chmod(databasePath, 0o600);
      const backupDb = new Database(databasePath, { readonly: true, fileMustExist: true });
      let migrations: Array<{ id: string; sha256: string }>; let counts: Record<string, number>; let rows: ReturnType<typeof artifactRows>;
      try { migrations = appliedMigrations(backupDb); counts = rowCounts(backupDb); rows = artifactRows(backupDb); } finally { backupDb.close(); }
      const artifacts: BackupManifest["artifacts"] = [];
      for (const row of rows) {
        const expectedHash = validateStoragePath(row.storagePath);
        if (row.sha256 !== expectedHash) throw new BackupError("artifact_metadata_hash", `Artifact metadata hash does not match ${row.storagePath}.`);
        const copied = await copyRegularFile(join(artifactRootPath(), ...row.storagePath.split("/")), join(staging, "artifacts", ...row.storagePath.split("/")));
        if (copied.sha256 !== row.sha256 || copied.byteSize !== row.byteSize) throw new BackupError("artifact_content_mismatch", `Artifact bytes do not match metadata for ${row.storagePath}.`);
        artifacts.push({ storagePath: row.storagePath, byteSize: copied.byteSize, sha256: copied.sha256 });
      }
      const database = await sha256File(databasePath);
      const manifest: BackupManifest = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: now.toISOString(), latestMigration: LATEST_MIGRATION_ID,
        migrations, database: { file: "database.sqlite", ...database }, counts, artifacts };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      await writeSynced(join(staging, "manifest.json"), manifestBytes);
      const manifestSha256 = sha256Bytes(manifestBytes);
      const manifestHmacSha256 = manifestHmac(manifestBytes).toString("hex");
      await writeSynced(join(staging, "manifest.sha256"), Buffer.from(`${manifestSha256}  manifest.json\n`));
      await writeSynced(join(staging, "manifest.hmac-sha256"), Buffer.from(`${manifestHmacSha256}  manifest.json\n`));
      return { manifest, manifestSha256, manifestHmacSha256 };
    });
    try {
      await lstat(final);
      throw new BackupError("overwrite_refused", `Backup bundle already exists: ${final}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, final); published = true;
    return { ok: true, bundleDir: final, ...result };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function listArtifactFiles(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new BackupError("symlink_rejected", "Restore bundle contains an artifact symlink.");
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listArtifactFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new BackupError("non_regular_file", "Restore bundle contains a non-regular artifact entry.");
  }
  return files.sort();
}

function verifyEnvelope(envelope: string, encodedKey: string): void {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new BackupError("credential_key_invalid", "The current master key is invalid.");
  const [version, iv, tag, ciphertext] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new BackupError("credential_envelope_invalid", "A restored credential envelope is invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    decipher.update(Buffer.from(ciphertext, "base64url")); decipher.final();
  } catch { throw new BackupError("credential_decryption_failed", "Stored credentials cannot be decrypted with the current master key."); }
}

export async function verifyBackup(bundleDir: string, options: { verifyCredentials?: boolean } = {}): Promise<VerifyResult> {
  if (!isAbsolute(bundleDir)) throw new BackupError("absolute_path_required", "Restore verification requires an absolute bundle directory.");
  await assertNoSymlinkComponents(bundleDir, true);
  const bundleInfo = await stat(bundleDir); if (!bundleInfo.isDirectory()) throw new BackupError("invalid_bundle", "Restore bundle path is not a directory.");
  const temporary = await mkdtemp(join(tmpdir(), "nexus-restore-verify-"));
  try {
    const manifestPath = join(bundleDir, "manifest.json"); const checksumPath = join(bundleDir, "manifest.sha256"); const hmacPath = join(bundleDir, "manifest.hmac-sha256");
    await assertNoSymlinkComponents(manifestPath, true); await assertNoSymlinkComponents(checksumPath, true); await assertNoSymlinkComponents(hmacPath, true);
    const manifestBytes = await readFile(manifestPath);
    const expectedMac = parseManifestHmac(await readFile(hmacPath, "utf8"));
    const actualMac = manifestHmac(manifestBytes);
    if (expectedMac.length !== actualMac.length || !timingSafeEqual(expectedMac, actualMac)) throw new BackupError("manifest_authentication_failed", "Manifest authentication failed.");
    const checksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/)[0];
    const actualManifestHash = sha256Bytes(manifestBytes);
    if (checksum !== actualManifestHash) throw new BackupError("manifest_tampered", "Manifest checksum verification failed.");
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    if (manifest.latestMigration !== LATEST_MIGRATION_ID) throw new BackupError("schema_outdated", `Bundle is not at ${LATEST_MIGRATION_ID}.`);
    const current = new Map(migrationManifest().map((item) => [item.id, item.sha256]));
    for (const migration of manifest.migrations) if (current.get(migration.id) !== migration.sha256) throw new BackupError("migration_hash_mismatch", `Migration hash mismatch: ${migration.id}`);

    const restoredDatabase = join(temporary, "database.sqlite");
    const databaseCopy = await copyRegularFile(join(bundleDir, manifest.database.file), restoredDatabase);
    if (databaseCopy.sha256 !== manifest.database.sha256 || databaseCopy.byteSize !== manifest.database.byteSize) throw new BackupError("database_tampered", "Database hash or size verification failed.");
    const restoredArtifacts = join(temporary, "artifacts"); await mkdir(restoredArtifacts, { recursive: true, mode: 0o700 });
    const bundleArtifactRoot = join(bundleDir, "artifacts");
    await assertNoSymlinkComponents(bundleArtifactRoot, manifest.artifacts.length > 0);
    const expectedFiles = manifest.artifacts.map((artifact) => artifact.storagePath).sort();
    const bundleFiles = await listArtifactFiles(bundleArtifactRoot);
    if (JSON.stringify(bundleFiles) !== JSON.stringify(expectedFiles)) throw new BackupError("artifact_manifest_mismatch", "Artifact tree does not exactly match the manifest.");
    let artifactBytes = 0;
    for (const artifact of manifest.artifacts) {
      validateStoragePath(artifact.storagePath);
      const copied = await copyRegularFile(join(bundleDir, "artifacts", ...artifact.storagePath.split("/")), join(restoredArtifacts, ...artifact.storagePath.split("/")));
      if (copied.sha256 !== artifact.sha256 || copied.byteSize !== artifact.byteSize) throw new BackupError("artifact_tampered", `Artifact verification failed: ${artifact.storagePath}`);
      artifactBytes += copied.byteSize;
    }

    const db = new Database(restoredDatabase, { readonly: true, fileMustExist: true });
    let counts: Record<string, number>; let credentialChecked = 0; let credentialStatus: VerifyResult["credentials"]["status"] = "skipped";
    try {
      const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new BackupError("database_integrity_failed", "Restored database integrity check failed.");
      const quick = db.pragma("quick_check") as Array<{ quick_check: string }>;
      if (quick.length !== 1 || quick[0]?.quick_check !== "ok") throw new BackupError("database_integrity_failed", "Restored database quick check failed.");
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new BackupError("foreign_key_failed", "Restored database foreign-key check failed.");
      const restoredMigrations = appliedMigrations(db);
      if (JSON.stringify(restoredMigrations) !== JSON.stringify(manifest.migrations)) throw new BackupError("migration_ledger_mismatch", "Restored migration ledger does not match the manifest.");
      counts = rowCounts(db);
      if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) throw new BackupError("row_count_mismatch", "Restored row counts do not match the manifest.");
      if (options.verifyCredentials !== false && process.env.NEXUS_MASTER_KEY) {
        const envelopes: string[] = [];
        if (tableExists(db, "provider_connections")) envelopes.push(...(db.prepare("SELECT encrypted_credential AS value FROM provider_connections WHERE encrypted_credential IS NOT NULL").all() as Array<{ value: string }>).map((row) => row.value));
        if (tableExists(db, "github_connections")) envelopes.push(...(db.prepare("SELECT encrypted_token AS value FROM github_connections WHERE encrypted_token IS NOT NULL").all() as Array<{ value: string }>).map((row) => row.value));
        for (const envelope of envelopes) verifyEnvelope(envelope, process.env.NEXUS_MASTER_KEY);
        credentialChecked = envelopes.length; credentialStatus = envelopes.length ? "verified" : "not_exercised";
      }
    } finally { db.close(); }
    return { ok: true, bundleDir: resolve(bundleDir), database: { integrity: "ok", foreignKeys: "ok", sha256: databaseCopy.sha256 },
      schema: { latestMigration: manifest.latestMigration, migrations: manifest.migrations.length }, counts,
      artifacts: { files: manifest.artifacts.length, bytes: artifactBytes, hashes: "ok" }, credentials: { status: credentialStatus, checked: credentialChecked } };
  } catch (error) {
    if (error instanceof z.ZodError) throw new BackupError("manifest_invalid", "Backup manifest schema validation failed.");
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
