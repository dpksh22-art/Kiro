import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LATEST_MIGRATION_ID } from "../src/core/schema";
import Database from "better-sqlite3";

const root = await mkdtemp(join(tmpdir(), "nexus-production-persistence-"));
const databasePath = join(root, "nexus.db");
const artifactRoot = join(root, "artifacts");
const port = 3411;
const marker = randomUUID();
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
  BETTER_AUTH_SECRET: "production-persistence-smoke-secret-at-least-thirty-two",
  NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_BACKUP_SIGNING_KEY: "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_DATABASE_PATH: databasePath,
  NEXUS_ARTIFACT_ROOT: artifactRoot,
};

let active: ChildProcess | undefined;
let logs = "";

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (active?.exitCode !== null) throw new Error(`Standalone server exited before readiness. ${logs.slice(-2_000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Standalone server did not become ready. ${logs.slice(-2_000)}`);
}

function start(): void {
  logs = "";
  const child = spawn(process.execPath, [resolve(process.cwd(), ".next/standalone/server.js")], { cwd: process.cwd(), env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  active = child;
  child.stdout?.on("data", (value) => { logs = `${logs}${String(value)}`.slice(-8_000); });
  child.stderr?.on("data", (value) => { logs = `${logs}${String(value)}`.slice(-8_000); });
}

async function stop(): Promise<void> {
  const child = active; active = undefined;
  if (!child || child.exitCode !== null || !child.pid) return;
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolveWait) => child.once("exit", () => resolveWait())),
    new Promise<void>((resolveWait) => setTimeout(() => { if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL"); resolveWait(); }, 5_000)),
  ]);
}

try {
  const migration = spawnSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), resolve(process.cwd(), "scripts/migrate.ts")], { cwd: process.cwd(), env: environment, encoding: "utf8" });
  if (migration.status !== 0) throw new Error(`Migration failed before persistence smoke. ${(migration.stderr || migration.stdout).slice(-2_000)}`);
  start(); await waitForReady(); await stop();

  const first = new Database(databasePath);
  first.exec("CREATE TABLE persistence_smoke (value TEXT PRIMARY KEY)");
  first.prepare("INSERT INTO persistence_smoke (value) VALUES (?)").run(marker);
  first.close();

  start(); await waitForReady();
  const second = new Database(databasePath, { readonly: true, fileMustExist: true });
  const restored = second.prepare("SELECT value FROM persistence_smoke").get() as { value: string } | undefined;
  second.close();
  if (restored?.value !== marker) throw new Error("Persistent database marker was not retained across restart.");
  console.log(JSON.stringify({ ok: true, restarts: 1, readiness: "ok", databasePersistence: "ok", schema: LATEST_MIGRATION_ID }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Production persistence smoke failed." }));
  process.exitCode = 1;
} finally {
  await stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
