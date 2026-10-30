import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { releaseUsage } from "@/src/modules/gateway/budgets";

export class OwnerQuiescingError extends Error {
  constructor() { super("Account deletion is quiescing this owner; new work is not accepted."); this.name = "OwnerQuiescingError"; }
}

type ActiveOperation = { id: string; kind: string; controller: AbortController };
const activeByOwner = new Map<string, Map<string, ActiveOperation>>();

export function assertOwnerActive(userId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT state,epoch FROM owner_runtime_state WHERE user_id=?").get(userId) as { state: string; epoch: number } | undefined;
  if (!row) {
    if (!db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)) throw new OwnerQuiescingError();
    db.prepare("INSERT OR IGNORE INTO owner_runtime_state(user_id,state,epoch,updated_at) VALUES (?,'active',0,?)").run(userId, new Date().toISOString());
    return 0;
  }
  if (row.state !== "active") throw new OwnerQuiescingError();
  return row.epoch;
}

export function beginOwnerOperation(userId: string, kind: string, controller = new AbortController()): { signal: AbortSignal; epoch: number; end: () => void; controller: AbortController } {
  const epoch = assertOwnerActive(userId);
  const id = randomUUID();
  const operation = { id, kind, controller };
  let operations = activeByOwner.get(userId);
  if (!operations) { operations = new Map(); activeByOwner.set(userId, operations); }
  operations.set(id, operation);
  let ended = false;
  return {
    signal: controller.signal,
    epoch,
    controller,
    end: () => {
      if (ended) return;
      ended = true;
      const current = activeByOwner.get(userId);
      current?.delete(id);
      if (!current?.size) activeByOwner.delete(userId);
    },
  };
}

export function quiesceOwner(userId: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  const epoch = db.transaction(() => {
    const changed = db.prepare("UPDATE owner_runtime_state SET state='quiescing',epoch=epoch+1,updated_at=? WHERE user_id=? AND state='active'").run(now, userId);
    if (!changed.changes) {
      const existing = db.prepare("SELECT epoch,state FROM owner_runtime_state WHERE user_id=?").get(userId) as { epoch: number; state: string } | undefined;
      if (!existing || existing.state !== "quiescing") throw new OwnerQuiescingError();
      return existing.epoch;
    }
    const row = db.prepare("SELECT epoch FROM owner_runtime_state WHERE user_id=?").get(userId) as { epoch: number };
    db.prepare(`UPDATE task_runs SET status='cancel_requested',cancel_requested_at=COALESCE(cancel_requested_at,?),updated_at=?
      WHERE user_id=? AND status NOT IN ('succeeded','failed','cancelled')`).run(now, now, userId);
    db.prepare(`UPDATE tasks SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,error_code='account_deletion',
      error_message='Cancelled for account deletion.',updated_at=?,completed_at=? WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?)
      AND status NOT IN ('succeeded','failed','cancelled','skipped')`).run(now, now, userId);
    db.prepare(`UPDATE task_attempts SET status='cancelled',completed_at=?,error_code='account_deletion',error_message='Cancelled for account deletion.'
      WHERE task_id IN (SELECT id FROM tasks WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?)) AND status='running'`).run(now, userId);
    db.prepare("UPDATE agent_messages SET state='expired',updated_at=? WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?) AND state='pending'").run(now, userId);
    return row.epoch;
  })();
  const usage = db.prepare("SELECT id FROM usage_records WHERE user_id=? AND status='reserved'").all(userId) as Array<{ id: string }>;
  for (const row of usage) releaseUsage(row.id);
  for (const operation of activeByOwner.get(userId)?.values() ?? []) operation.controller.abort(new Error("Account deletion quiescence"));
  return epoch;
}

export async function waitForOwnerDrain(userId: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const active = activeByOwner.get(userId)?.size ?? 0;
    const leased = (getDb().prepare(`SELECT count(*) AS count FROM tasks WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?)
      AND (lease_token IS NOT NULL OR status IN ('leased','running','cancel_requested'))`).get(userId) as { count: number }).count;
    if (active === 0 && leased === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

export function clearOwnerQuiescenceIfSafe(userId: string): boolean {
  if ((activeByOwner.get(userId)?.size ?? 0) !== 0) return false;
  const db = getDb();
  const leased = (db.prepare(`SELECT count(*) AS count FROM tasks WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?)
    AND (lease_token IS NOT NULL OR status IN ('leased','running','cancel_requested'))`).get(userId) as { count: number }).count;
  if (leased !== 0 || !db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)) return false;
  return db.prepare("UPDATE owner_runtime_state SET state='active',updated_at=? WHERE user_id=? AND state='quiescing'").run(new Date().toISOString(), userId).changes === 1;
}

export function activeOwnerOperationCountForTests(userId: string): number {
  return activeByOwner.get(userId)?.size ?? 0;
}
