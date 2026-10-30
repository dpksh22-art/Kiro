import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { getConfig } from "@/src/core/config";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const EXECUTABLE_OR_ARCHIVE_SIGNATURES: Array<{ signature: number[]; label: string }> = [
  { signature: [0x4d, 0x5a], label: "Windows executable" },
  { signature: [0x7f, 0x45, 0x4c, 0x46], label: "ELF executable" },
  { signature: [0x00, 0x61, 0x73, 0x6d], label: "WebAssembly executable" },
  { signature: [0x50, 0x4b, 0x03, 0x04], label: "ZIP archive" },
  { signature: [0x1f, 0x8b], label: "gzip archive" },
  { signature: [0x52, 0x61, 0x72, 0x21], label: "RAR archive" },
  { signature: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: "7z archive" },
];

export class ArtifactError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export type ScanResult = { status: "clean" | "quarantined" | "rejected"; mediaType: string; reason?: string };
export type ArtifactScanner = { name: string; scan(path: string, declaredMediaType?: string): Promise<ScanResult> };

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function detectMediaType(bytes: Uint8Array): { mediaType?: string; rejected?: string } {
  const dangerous = EXECUTABLE_OR_ARCHIVE_SIGNATURES.find(({ signature }) => startsWith(bytes, signature));
  if (dangerous) return { rejected: `${dangerous.label} uploads are not accepted.` };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mediaType: "image/jpeg" };
  if (bytes[0] === 0x23 && bytes[1] === 0x21) return { rejected: "Script uploads are not accepted." };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/\u0000/.test(text) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return {};
    const trimmed = text.trim();
    if (trimmed.startsWith("#!")) return { rejected: "Script uploads are not accepted." };
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { JSON.parse(trimmed); return { mediaType: "application/json" }; } catch { /* plain text */ }
    }
    return { mediaType: "text/plain" };
  } catch {
    return {};
  }
}

export const defaultArtifactScanner: ArtifactScanner = {
  name: "nexus-conservative-v1",
  async scan(path, declaredMediaType) {
    const bytes = await readFile(path);
    const detection = detectMediaType(bytes);
    if (detection.rejected) return { status: "rejected", mediaType: "application/octet-stream", reason: detection.rejected };
    if (!detection.mediaType) return { status: "rejected", mediaType: "application/octet-stream", reason: "The file type is not in the safe upload allowlist." };
    if (!new Set(["text/plain", "application/json"]).has(detection.mediaType)) {
      return { status: "rejected", mediaType: detection.mediaType, reason: "This binary media type requires an external malware scanner." };
    }
    const declared = declaredMediaType?.split(";", 1)[0]?.trim().toLowerCase();
    const compatibleText = detection.mediaType === "text/plain" && declared?.startsWith("text/");
    if (declared && declared !== "application/octet-stream" && declared !== detection.mediaType && !compatibleText) {
      return { status: "rejected", mediaType: detection.mediaType, reason: "The declared content type does not match the file content." };
    }
    return { status: "clean", mediaType: detection.mediaType };
  },
};

export function sanitizeFilename(input: string): string {
  const normalized = input.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").trim();
  return (normalized || "artifact").slice(0, 120);
}

function artifactRoot(): string {
  return resolve(/* turbopackIgnore: true */ process.cwd(), getConfig().NEXUS_ARTIFACT_ROOT);
}

export function resolveArtifactPath(storagePath: string): string {
  const root = artifactRoot();
  const fullPath = resolve(/* turbopackIgnore: true */ root, storagePath);
  if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) throw new ArtifactError("Invalid artifact storage path.", 500);
  return fullPath;
}

let mutationQueue: Promise<void> = Promise.resolve();
function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function withArtifactSnapshotLock<T>(operation: () => Promise<T>): Promise<T> {
  return serializeMutation(operation);
}

async function writeUpload(stream: ReadableStream<Uint8Array>, expectedLength?: number): Promise<{ path: string; byteSize: number; hash: string }> {
  if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > MAX_ARTIFACT_BYTES)) {
    throw new ArtifactError(`Artifacts must not exceed ${MAX_ARTIFACT_BYTES} bytes.`, 413);
  }
  const root = artifactRoot();
  const temporaryDirectory = resolve(root, ".tmp");
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(temporaryDirectory, randomUUID());
  const handle = await open(temporaryPath, "wx", 0o600);
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > MAX_ARTIFACT_BYTES) {
        await reader.cancel("Artifact exceeds size limit.");
        throw new ArtifactError(`Artifacts must not exceed ${MAX_ARTIFACT_BYTES} bytes.`, 413);
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) offset += (await handle.write(value, offset)).bytesWritten;
    }
    if (expectedLength !== undefined && expectedLength !== byteSize) throw new ArtifactError("Content-Length does not match the uploaded bytes.", 400);
    await handle.sync();
    return { path: temporaryPath, byteSize, hash: hash.digest("hex") };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

export type ArtifactRecord = {
  id: string; projectId: string | null; runId: string | null; name: string; mediaType: string;
  byteSize: number; contentHash: string; provenanceJson: string; uploadState: string; scanStatus: string;
  scannerName: string; retentionExpiresAt: string | null; createdAt: string; updatedAt: string | null;
};

type ArtifactStorageRow = ArtifactRecord & { storagePath: string };

export function listArtifacts(userId: string): ArtifactRecord[] {
  return getDb().prepare(`SELECT id,project_id AS projectId,run_id AS runId,name,media_type AS mediaType,byte_size AS byteSize,
    content_hash AS contentHash,provenance_json AS provenanceJson,upload_state AS uploadState,scan_status AS scanStatus,
    scanner_name AS scannerName,retention_expires_at AS retentionExpiresAt,created_at AS createdAt,updated_at AS updatedAt
    FROM artifacts WHERE user_id=? ORDER BY created_at DESC`).all(userId) as ArtifactRecord[];
}

export function getArtifact(userId: string, id: string): ArtifactRecord | null {
  return (getDb().prepare(`SELECT id,project_id AS projectId,run_id AS runId,name,media_type AS mediaType,byte_size AS byteSize,
    content_hash AS contentHash,provenance_json AS provenanceJson,upload_state AS uploadState,scan_status AS scanStatus,
    scanner_name AS scannerName,retention_expires_at AS retentionExpiresAt,created_at AS createdAt,updated_at AS updatedAt
    FROM artifacts WHERE id=? AND user_id=?`).get(id, userId) as ArtifactRecord | undefined) ?? null;
}

function getStorageRow(userId: string, id: string): ArtifactStorageRow | null {
  return (getDb().prepare(`SELECT id,project_id AS projectId,run_id AS runId,name,media_type AS mediaType,byte_size AS byteSize,
    content_hash AS contentHash,storage_path AS storagePath,provenance_json AS provenanceJson,upload_state AS uploadState,
    scan_status AS scanStatus,scanner_name AS scannerName,retention_expires_at AS retentionExpiresAt,
    created_at AS createdAt,updated_at AS updatedAt FROM artifacts WHERE id=? AND user_id=?`).get(id, userId) as ArtifactStorageRow | undefined) ?? null;
}

export async function uploadArtifact(input: { userId: string; stream: ReadableStream<Uint8Array>; filename: string; declaredMediaType?: string; contentLength?: number; projectId?: string; scanner?: ArtifactScanner }): Promise<ArtifactRecord> {
  return serializeMutation(async () => {
    if (input.projectId && !getDb().prepare("SELECT 1 FROM projects WHERE id=? AND user_id=?").get(input.projectId, input.userId)) throw new ArtifactError("Project not found.", 404);
    const name = sanitizeFilename(input.filename);
    const scanner = input.scanner ?? defaultArtifactScanner;
    let staged: Awaited<ReturnType<typeof writeUpload>> | undefined;
    let createdBlobPath: string | undefined;
    try {
      staged = await writeUpload(input.stream, input.contentLength);
      const quota = getDb().prepare("SELECT COALESCE(SUM(byte_size),0) AS used FROM artifacts WHERE user_id=? AND upload_state<>'deleting'").get(input.userId) as { used: number };
      if (quota.used + staged.byteSize > getConfig().NEXUS_ARTIFACT_QUOTA_BYTES) throw new ArtifactError("Artifact storage quota exceeded.", 413);
      const scan = await scanner.scan(staged.path, input.declaredMediaType);
      if (scan.status === "rejected") throw new ArtifactError(scan.reason ?? "Artifact rejected by scanner.", 415);
      const byteSize = staged.byteSize;
      const contentHash = staged.hash;
      const storagePath = `sha256/${contentHash.slice(0, 2)}/${contentHash}`;
      const finalPath = resolveArtifactPath(storagePath);
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      try {
        await access(finalPath);
        await unlink(staged.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(staged.path, finalPath);
        createdBlobPath = finalPath;
      }
      staged = undefined;
      const id = randomUUID();
      const now = new Date().toISOString();
      const db = getDb();
      db.transaction(() => {
        db.prepare(`INSERT INTO artifacts
          (id,user_id,project_id,run_id,name,media_type,byte_size,content_hash,storage_path,provenance_json,created_at,upload_state,scan_status,scanner_name,updated_at)
          VALUES (?,?,?,NULL,?,?,?,?,?,'{"source":"explicit_user_upload"}',?,?,?,?,?)`).run(
            id, input.userId, input.projectId ?? null, name, scan.mediaType, byteSize, contentHash, storagePath, now,
            scan.status, scan.status === "clean" ? "clean" : "pending", scanner.name, now,
          );
        writeAudit({ userId: input.userId, action: "artifact.uploaded", resourceType: "artifact", resourceId: id, outcome: "success", metadata: { projectId: input.projectId, mediaType: scan.mediaType, byteSize, scanStatus: scan.status === "clean" ? "clean" : "pending" } });
      })();
      const record = getArtifact(input.userId, id);
      if (!record) throw new ArtifactError("Artifact metadata was not persisted.", 500);
      return record;
    } catch (error) {
      if (staged) await unlink(staged.path).catch(() => undefined);
      if (createdBlobPath) {
        const relativePath = createdBlobPath.slice(artifactRoot().length + 1).split(sep).join("/");
        const references = getDb().prepare("SELECT 1 FROM artifacts WHERE storage_path=? LIMIT 1").get(relativePath);
        if (!references) await unlink(createdBlobPath).catch(() => undefined);
      }
      const publicError = error instanceof ArtifactError ? error : new ArtifactError("Artifact storage failed.", 500);
      writeAudit({ userId: input.userId, action: "artifact.upload.rejected", resourceType: "artifact", outcome: "failure", metadata: { filename: name, reason: publicError.message } });
      throw publicError;
    }
  });
}

export async function checkArtifactStorage(): Promise<void> {
  const root = artifactRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const probe = resolve(root, `.readiness-${randomUUID()}`);
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  await unlink(probe);
}

export async function artifactDownload(userId: string, id: string): Promise<{ record: ArtifactRecord; stream: ReadableStream<Uint8Array> } | null> {
  const row = getStorageRow(userId, id);
  if (!row) return null;
  if (row.uploadState !== "clean" || row.scanStatus !== "clean") throw new ArtifactError("Artifact is quarantined and unavailable for download.", 423);
  const path = resolveArtifactPath(row.storagePath);
  await access(path).catch(() => { throw new ArtifactError("Artifact content is missing.", 410); });
  writeAudit({ userId, action: "artifact.downloaded", resourceType: "artifact", resourceId: id, outcome: "success" });
  return { record: row, stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array> };
}

export async function deleteArtifact(userId: string, id: string): Promise<boolean> {
  return serializeMutation(async () => {
    const row = getStorageRow(userId, id);
    if (!row) return false;
    getDb().prepare("UPDATE artifacts SET upload_state='deleting',updated_at=? WHERE id=? AND user_id=?").run(new Date().toISOString(), id, userId);
    const references = getDb().prepare(`SELECT
      (SELECT COUNT(*) FROM artifacts WHERE storage_path=? AND id<>? AND upload_state<>'deleting') +
      (SELECT COUNT(*) FROM attachments WHERE storage_path=?) AS count`).get(row.storagePath, id, row.storagePath) as { count: number };
    let contentRemoved = false;
    try {
      if (references.count === 0) {
        await unlink(resolveArtifactPath(row.storagePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        contentRemoved = true;
      }
      getDb().transaction(() => {
        const result = getDb().prepare("DELETE FROM artifacts WHERE id=? AND user_id=?").run(id, userId);
        if (!result.changes) throw new ArtifactError("Artifact deletion lost ownership state.", 409);
        writeAudit({ userId, action: "artifact.deleted", resourceType: "artifact", resourceId: id, outcome: "success", metadata: { contentDeleted: references.count === 0 } });
      })();
      return true;
    } catch (error) {
      if (!contentRemoved) getDb().prepare("UPDATE artifacts SET upload_state=?,updated_at=? WHERE id=? AND user_id=?").run(row.uploadState, new Date().toISOString(), id, userId);
      writeAudit({ userId, action: "artifact.delete.failed", resourceType: "artifact", resourceId: id, outcome: "failure", metadata: { retryableState: contentRemoved ? "deleting" : row.uploadState } });
      throw error;
    }
  });
}


type OwnerContentRow = { storagePath: string; contentHash: string; byteSize: number; source: "artifact" | "attachment" };
type DeletionFileRow = { storagePath: string; contentHash: string; byteSize: number };

export type OwnerArtifactCleanupResult = {
  artifactCount: number;
  attachmentCount: number;
  uniquePathCount: number;
  removedPathCount: number;
  missingPathCount: number;
};

export type OwnerArtifactCleanupOptions = {
  /** Test seam for deterministic filesystem-failure coverage. Production callers omit it. */
  removeFile?: (path: string) => Promise<void>;
};

function validateOwnedContentRow(row: OwnerContentRow | DeletionFileRow): void {
  const match = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(row.storagePath);
  if (!match || match[1] !== row.contentHash.slice(0, 2) || match[2] !== row.contentHash) {
    throw new ArtifactError("Account artifact metadata contains an invalid content-addressed path.", 409);
  }
  resolveArtifactPath(row.storagePath);
}

async function removeContentAddressedFile(storagePath: string, removeFile: (path: string) => Promise<void>): Promise<"removed" | "missing"> {
  const root = artifactRoot();
  const fullPath = resolveArtifactPath(storagePath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let info;
  try {
    info = await lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new ArtifactError("Account artifact path is not a regular file.", 409);
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(fullPath))]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    throw new ArtifactError("Account artifact path escapes the configured storage root.", 409);
  }
  try {
    await removeFile(fullPath);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Removes every content-addressed artifact/attachment blob owned by a user while
 * holding the same process-local lock as upload, ordinary deletion, and backup.
 * The finalize callback runs under that lock only after all bytes are absent.
 */
export async function cleanupOwnerArtifactContent<T>(input: {
  userId: string;
  jobId: string;
  finalize: (result: OwnerArtifactCleanupResult) => T;
  onAlreadyCompleted?: () => T;
  options?: OwnerArtifactCleanupOptions;
}): Promise<T> {
  return serializeMutation(async () => {
    const db = getDb();
    const serializedJob = db.prepare("SELECT state FROM account_deletion_jobs WHERE id=?").get(input.jobId) as { state: string } | undefined;
    if (!serializedJob) throw new ArtifactError("Account deletion job was not found.", 404);
    if (serializedJob.state === "completed") {
      if (!input.onAlreadyCompleted) throw new ArtifactError("Account deletion is already complete.", 409);
      return input.onAlreadyCompleted();
    }
    const now = new Date().toISOString();
    const rows = db.prepare(`
      SELECT storage_path AS storagePath,content_hash AS contentHash,byte_size AS byteSize,'artifact' AS source
      FROM artifacts WHERE user_id=?
      UNION ALL
      SELECT storage_path AS storagePath,content_hash AS contentHash,byte_size AS byteSize,'attachment' AS source
      FROM attachments WHERE user_id=?
    `).all(input.userId, input.userId) as OwnerContentRow[];
    const unique = new Map<string, DeletionFileRow>();
    for (const row of rows) {
      validateOwnedContentRow(row);
      const existing = unique.get(row.storagePath);
      if (existing && (existing.contentHash !== row.contentHash || existing.byteSize !== row.byteSize)) {
        throw new ArtifactError("Account artifact metadata conflicts for a shared content path.", 409);
      }
      unique.set(row.storagePath, { storagePath: row.storagePath, contentHash: row.contentHash, byteSize: row.byteSize });
    }

    db.transaction(() => {
      const job = db.prepare("SELECT 1 FROM account_deletion_jobs WHERE id=?").get(input.jobId);
      if (!job) throw new ArtifactError("Account deletion job was not found.", 404);
      const upsert = db.prepare(`INSERT INTO account_deletion_files (job_id,storage_path,content_hash,byte_size,state,updated_at)
        VALUES (?,?,?,?, 'pending',?)
        ON CONFLICT(job_id,storage_path) DO UPDATE SET content_hash=excluded.content_hash,byte_size=excluded.byte_size,state='pending',updated_at=excluded.updated_at`);
      for (const row of unique.values()) upsert.run(input.jobId, row.storagePath, row.contentHash, row.byteSize, now);
      db.prepare("UPDATE account_deletion_files SET state='pending',updated_at=? WHERE job_id=?").run(now, input.jobId);
      db.prepare("UPDATE artifacts SET upload_state='deleting',updated_at=? WHERE user_id=?").run(now, input.userId);
      db.prepare(`UPDATE account_deletion_jobs SET state='deleting_files',artifact_count=?,attachment_count=?,unique_path_count=(SELECT COUNT(*) FROM account_deletion_files WHERE job_id=?),removed_path_count=0,missing_path_count=0,attempt_count=attempt_count+1,sanitized_error=NULL,updated_at=? WHERE id=?`).run(
        rows.filter((row) => row.source === "artifact").length,
        rows.filter((row) => row.source === "attachment").length,
        input.jobId,
        now,
        input.jobId,
      );
    })();

    let removedPathCount = 0;
    let missingPathCount = 0;
    const files = db.prepare("SELECT storage_path AS storagePath,content_hash AS contentHash,byte_size AS byteSize FROM account_deletion_files WHERE job_id=? ORDER BY storage_path").all(input.jobId) as DeletionFileRow[];
    const removeFile = input.options?.removeFile ?? unlink;
    for (const file of files) {
      validateOwnedContentRow(file);
      const foreignReferences = db.prepare(`SELECT
        (SELECT COUNT(*) FROM artifacts WHERE storage_path=? AND user_id<>?) +
        (SELECT COUNT(*) FROM attachments WHERE storage_path=? AND user_id<>?) AS count`).get(file.storagePath, input.userId, file.storagePath, input.userId) as { count: number };
      if (foreignReferences.count > 0) throw new ArtifactError("Account artifact content is referenced outside the owner account.", 409);
      const state = await removeContentAddressedFile(file.storagePath, removeFile);
      if (state === "removed") removedPathCount += 1;
      else missingPathCount += 1;
      db.transaction(() => {
        const progressAt = new Date().toISOString();
        db.prepare("UPDATE account_deletion_files SET state=?,updated_at=? WHERE job_id=? AND storage_path=?").run(state, progressAt, input.jobId, file.storagePath);
        db.prepare("UPDATE account_deletion_jobs SET removed_path_count=?,missing_path_count=?,updated_at=? WHERE id=?").run(removedPathCount, missingPathCount, progressAt, input.jobId);
      })();
    }

    return input.finalize({
      artifactCount: rows.filter((row) => row.source === "artifact").length,
      attachmentCount: rows.filter((row) => row.source === "attachment").length,
      uniquePathCount: files.length,
      removedPathCount,
      missingPathCount,
    });
  });
}
