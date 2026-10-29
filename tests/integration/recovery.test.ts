import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import { recoverExpired } from "@/src/modules/agents/runtime";

describe("worker crash recovery", () => {
  it("finalizes an expired cancelled lease and its attempt", () => {
    const db = getDb(); const userId = getTestUser(); const runId = randomUUID(); const taskId = randomUUID(); const usageId = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO task_runs (id,user_id,title,goal,mode,status,max_parallelism,max_tasks,max_depth,cancel_requested_at,created_at,updated_at) VALUES (?,?,?,?,?,'cancel_requested',1,4,1,?,?,?)`).run(runId,userId,"Recovery","Recover cancellation","team",now,now,now);
    db.prepare(`INSERT INTO tasks (id,run_id,task_key,title,description,task_type,status,attempt_count,max_attempts,lease_token,lease_expires_at,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'cancel_requested',1,2,?,?, '{}',?,?)`).run(taskId,runId,"task","Task","Task","model_agent","lease",new Date(0).toISOString(),now,now);
    db.prepare(`INSERT INTO task_attempts (id,task_id,attempt_number,status,lease_token,started_at,heartbeat_at) VALUES (?,?,1,'running','lease',?,?)`).run(randomUUID(),taskId,now,now);
    db.prepare(`INSERT INTO usage_records (id,user_id,run_id,task_id,provider,model_id,estimated_cost_micros,status,created_at) VALUES (?,?,?,?,?,?,100,'reserved',?)`).run(usageId,userId,runId,taskId,"openai","model",now);
    recoverExpired();
    expect((db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as {status:string}).status).toBe("cancelled");
    expect((db.prepare("SELECT status FROM task_attempts WHERE task_id=?").get(taskId) as {status:string}).status).toBe("cancelled");
    expect((db.prepare("SELECT status FROM task_runs WHERE id=?").get(runId) as {status:string}).status).toBe("cancelled");
    expect((db.prepare("SELECT status FROM usage_records WHERE id=?").get(usageId) as {status:string}).status).toBe("released");
  });
});
