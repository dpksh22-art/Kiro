import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb } from "@/src/core/database";
import { createProject } from "@/src/modules/workspace/service";
import { ArtifactError, artifactDownload, deleteArtifact, getArtifact, MAX_ARTIFACT_BYTES, resolveArtifactPath, sanitizeFilename, uploadArtifact } from "@/src/modules/artifacts/service";
import { createMemory, deleteMemory, listMemories, updateMemory } from "@/src/modules/workspace/memory";
import { createOwnerExport } from "@/src/modules/lifecycle/export";
import { deleteConversation, deleteProject, disconnectGitHub, disconnectProvider } from "@/src/modules/lifecycle/service";
import { encryptSecret } from "@/src/core/crypto";
import { resetConfigForTests } from "@/src/core/config";
import { getTestUser } from "../helpers";

const stream = (value: Uint8Array | string) => new Blob([typeof value === "string" ? value : value as BlobPart]).stream();

async function readStream(value: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(value).arrayBuffer());
}

function insertProvider(userId: string, encryptedCredential: string): string {
  const id = randomUUID(); const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO provider_connections (id,user_id,provider,label,encrypted_credential,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'connected',?,?)`).run(id, userId, "openai", `lifecycle-${id}`, encryptedCredential, now, now);
  return id;
}

function insertGitHub(userId: string, encryptedToken: string): string {
  const id = randomUUID(); const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO github_connections (id,user_id,connection_type,encrypted_token,status,created_at,updated_at)
    VALUES (?,?, 'token',?,'connected',?,?)`).run(id, userId, encryptedToken, now, now);
  return id;
}

describe("artifact, memory, and data lifecycle", () => {
  it("adds project memory and the attachment artifact foreign key", () => {
    const db = getDb();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memories'").get();
    const foreignKeys = db.pragma("foreign_key_list(attachments)") as Array<{ table: string; from: string; on_delete: string }>;
    expect(table).toBeTruthy();
    expect(foreignKeys).toContainEqual(expect.objectContaining({ table: "artifacts", from: "artifact_id", on_delete: "SET NULL" }));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("streams a safe artifact to its SHA-256 path and downloads identical bytes", async () => {
    const userId = getTestUser();
    const projectId = createProject(userId, `Artifact ${randomUUID()}`);
    const bytes = "safe artifact content\n";
    const artifact = await uploadArtifact({ userId, projectId, filename: "../../unsafe name.txt", declaredMediaType: "text/plain", contentLength: Buffer.byteLength(bytes), stream: stream(bytes) });
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    expect(artifact.name).toBe("_.._unsafe name.txt");
    expect(artifact.contentHash).toBe(expectedHash);
    expect(artifact.byteSize).toBe(Buffer.byteLength(bytes));
    expect(artifact.uploadState).toBe("clean");
    const stored = getDb().prepare("SELECT storage_path AS storagePath FROM artifacts WHERE id=?").get(artifact.id) as { storagePath: string };
    expect(stored.storagePath).toBe(`sha256/${expectedHash.slice(0, 2)}/${expectedHash}`);
    expect(existsSync(resolveArtifactPath(stored.storagePath))).toBe(true);
    const download = await artifactDownload(userId, artifact.id);
    expect(download?.record.mediaType).toBe("text/plain");
    expect((await readStream(download!.stream)).toString()).toBe(bytes);
    expect(getArtifact("not-the-owner", artifact.id)).toBeNull();
    expect(await artifactDownload("not-the-owner", artifact.id)).toBeNull();
    expect(await deleteArtifact("not-the-owner", artifact.id)).toBe(false);
  });

  it("rejects oversized streams, executable/archive magic, MIME mismatches, and unsafe paths", async () => {
    const userId = getTestUser();
    await expect(uploadArtifact({ userId, filename: "large.txt", declaredMediaType: "text/plain", contentLength: MAX_ARTIFACT_BYTES + 1, stream: stream("small") })).rejects.toMatchObject({ status: 413 });
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { for (let index = 0; index < 11; index += 1) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close(); },
    });
    await expect(uploadArtifact({ userId, filename: "large.txt", declaredMediaType: "text/plain", stream: oversized })).rejects.toMatchObject({ status: 413 });
    await expect(uploadArtifact({ userId, filename: "archive.txt", declaredMediaType: "text/plain", stream: stream(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])) })).rejects.toMatchObject({ status: 415 });
    await expect(uploadArtifact({ userId, filename: "program.exe", declaredMediaType: "application/octet-stream", stream: stream(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])) })).rejects.toMatchObject({ status: 415 });
    await expect(uploadArtifact({ userId, filename: "claim.png", declaredMediaType: "image/png", stream: stream("plain text") })).rejects.toMatchObject({ status: 415 });
    expect(() => resolveArtifactPath("../../etc/passwd")).toThrow(ArtifactError);
    expect(sanitizeFilename("../\\evil\u0000.txt")).not.toMatch(/[\\/\u0000]/);
  });

  it("supports quarantine and enforces the configured owner quota", async () => {
    const userId = getTestUser();
    const quarantined = await uploadArtifact({
      userId, filename: "held.txt", declaredMediaType: "text/plain", stream: stream("held for review"),
      scanner: { name: "test-quarantine", async scan() { return { status: "quarantined", mediaType: "text/plain" }; } },
    });
    expect(quarantined.uploadState).toBe("quarantined");
    await expect(artifactDownload(userId, quarantined.id)).rejects.toMatchObject({ status: 423 });
    await deleteArtifact(userId, quarantined.id);

    const previousQuota = process.env.NEXUS_ARTIFACT_QUOTA_BYTES;
    process.env.NEXUS_ARTIFACT_QUOTA_BYTES = String(MAX_ARTIFACT_BYTES);
    resetConfigForTests();
    const id = randomUUID(); const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO artifacts (id,user_id,name,media_type,byte_size,content_hash,storage_path,created_at,upload_state,scan_status,scanner_name,updated_at)
      VALUES (?,?,?,'text/plain',?,'quota-placeholder','sha256/quota/placeholder',?,'clean','clean','test',?)`).run(id, userId, "quota reservation", MAX_ARTIFACT_BYTES, now, now);
    try {
      await expect(uploadArtifact({ userId, filename: "over.txt", declaredMediaType: "text/plain", stream: stream("x") })).rejects.toMatchObject({ status: 413 });
    } finally {
      getDb().prepare("DELETE FROM artifacts WHERE id=?").run(id);
      if (previousQuota === undefined) delete process.env.NEXUS_ARTIFACT_QUOTA_BYTES;
      else process.env.NEXUS_ARTIFACT_QUOTA_BYTES = previousQuota;
      resetConfigForTests();
    }
  });

  it("keeps shared content until its last metadata reference is deleted", async () => {
    const userId = getTestUser();
    const first = await uploadArtifact({ userId, filename: "first.txt", declaredMediaType: "text/plain", stream: stream("deduplicated content") });
    const second = await uploadArtifact({ userId, filename: "second.txt", declaredMediaType: "text/plain", stream: stream("deduplicated content") });
    const row = getDb().prepare("SELECT storage_path AS storagePath FROM artifacts WHERE id=?").get(first.id) as { storagePath: string };
    const path = resolveArtifactPath(row.storagePath);
    expect(await deleteArtifact(userId, first.id)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(await deleteArtifact(userId, second.id)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("stores only explicit trusted instructions and decisions with ownership", () => {
    const userId = getTestUser();
    const projectId = createProject(userId, `Memory ${randomUUID()}`);
    const id = createMemory(userId, { projectId, kind: "instruction", content: "Always show sources.", retentionPolicy: "30_days" });
    expect(listMemories(userId, projectId)).toContainEqual(expect.objectContaining({ id, trustLevel: "trusted_user", provenance: "explicit_user", kind: "instruction" }));
    expect(listMemories("not-the-owner", projectId)).toEqual([]);
    expect(updateMemory("not-the-owner", id, { kind: "decision", content: "No", retentionPolicy: "permanent" })).toBe(false);
    expect(updateMemory(userId, id, { kind: "decision", content: "Use SQLite for this deployment.", retentionPolicy: "permanent" })).toBe(true);
    expect(listMemories(userId, projectId)[0]).toEqual(expect.objectContaining({ kind: "decision", content: "Use SQLite for this deployment." }));
    expect(() => getDb().prepare(`INSERT INTO project_memories (id,user_id,project_id,kind,content,trust_level,provenance,retention_policy,created_at,updated_at)
      VALUES (?,?,?,?,?,'untrusted_external','retrieved_web','permanent',?,?)`).run(randomUUID(), userId, projectId, "instruction", "external claim", new Date().toISOString(), new Date().toISOString())).toThrow();
    const expiredId = randomUUID(); const expiredAt = new Date(Date.now() - 1000).toISOString();
    getDb().prepare(`INSERT INTO project_memories (id,user_id,project_id,kind,content,retention_policy,expires_at,created_at,updated_at)
      VALUES (?,?,?,'decision','expired','30_days',?,?,?)`).run(expiredId, userId, projectId, expiredAt, expiredAt, expiredAt);
    listMemories(userId, projectId);
    expect(getDb().prepare("SELECT 1 FROM project_memories WHERE id=?").get(expiredId)).toBeUndefined();
    expect(deleteMemory("not-the-owner", id)).toBe(false);
    expect(deleteMemory(userId, id)).toBe(true);
  });

  it("disconnects owned integrations by deleting ciphertext and disabling provider models", () => {
    const userId = getTestUser();
    const providerId = insertProvider(userId, encryptSecret("provider-secret-value"));
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,availability,created_at,updated_at)
      VALUES (?,?,?,?, 'available',?,?)`).run(randomUUID(), providerId, "model", "Model", now, now);
    const githubId = insertGitHub(userId, encryptSecret("github-secret-value"));
    expect(disconnectProvider("not-the-owner", providerId)).toBeNull();
    expect(disconnectGitHub("not-the-owner", githubId)).toBeNull();
    expect(disconnectProvider(userId, providerId)).toEqual(expect.objectContaining({ credentialDeleted: true, revokedRemotely: false }));
    expect(disconnectGitHub(userId, githubId)).toEqual(expect.objectContaining({ credentialDeleted: true, revokedRemotely: false }));
    expect(getDb().prepare("SELECT encrypted_credential AS secret,status FROM provider_connections WHERE id=?").get(providerId)).toEqual({ secret: null, status: "disconnected" });
    expect(getDb().prepare("SELECT availability FROM models WHERE connection_id=?").get(providerId)).toEqual({ availability: "unavailable" });
    expect(getDb().prepare("SELECT encrypted_token AS secret,status FROM github_connections WHERE id=?").get(githubId)).toEqual({ secret: null, status: "disconnected" });
  });

  it("streams an owner export without encrypted credentials or storage paths", async () => {
    const userId = getTestUser();
    const providerCiphertext = encryptSecret("export-provider-secret");
    const githubCiphertext = encryptSecret("export-github-secret");
    insertProvider(userId, providerCiphertext);
    insertGitHub(userId, githubCiphertext);
    const exported = await new Response(createOwnerExport(userId)).text();
    expect(exported).not.toContain(providerCiphertext);
    expect(exported).not.toContain(githubCiphertext);
    expect(exported).not.toContain("encrypted_credential");
    expect(exported).not.toContain("encrypted_token");
    expect(exported).not.toContain("storagePath");
    const parsed = JSON.parse(exported);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.data).toEqual(expect.objectContaining({ projects: expect.any(Array), conversations: expect.any(Array), messages: expect.any(Array), agents: expect.any(Array), runs: expect.any(Array), events: expect.any(Array), researchSources: expect.any(Array), memory: expect.any(Array), artifacts: expect.any(Array) }));
  });

  it("deletes owned conversations and projects with cascading memory and audit", () => {
    const userId = getTestUser();
    const projectId = createProject(userId, `Delete ${randomUUID()}`);
    const memoryId = createMemory(userId, { projectId, kind: "decision", content: "Temporary decision", retentionPolicy: "permanent" });
    const conversationId = randomUUID(); const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO conversations (id,project_id,user_id,title,mode,created_at,updated_at) VALUES (?,?,?,'Delete me','single',?,?)`).run(conversationId, projectId, userId, now, now);
    expect(deleteConversation("not-the-owner", conversationId)).toBe(false);
    expect(deleteConversation(userId, conversationId)).toBe(true);
    expect(deleteProject("not-the-owner", projectId)).toBe(false);
    expect(deleteProject(userId, projectId)).toBe(true);
    expect(getDb().prepare("SELECT 1 FROM project_memories WHERE id=?").get(memoryId)).toBeUndefined();
    const actions = getDb().prepare("SELECT action FROM audit_events WHERE resource_id IN (?,?)").all(conversationId, projectId) as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(["conversation.deleted", "project.deleted"]));
  });
});
