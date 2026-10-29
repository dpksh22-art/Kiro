import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import { assertBudget, releaseUsage, reserveUsage } from "@/src/modules/gateway/budgets";

describe("backend budget enforcement", () => {
  it("fails closed when a monetary policy exists and pricing is unknown", () => {
    const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString(); const policyId = randomUUID();
    db.prepare(`INSERT INTO budget_policies (id,user_id,provider,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,?,'daily',1000000,'stop',?,?)`).run(policyId, userId, "openai", now, now);
    expect(() => assertBudget(userId, "openai", undefined)).toThrow(/no verified price/i);
    expect(() => assertBudget(userId, "openai", 500_000)).not.toThrow();
    db.prepare("DELETE FROM budget_policies WHERE id=?").run(policyId);
  });

  it("aggregates a global policy across providers", () => {
    const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString(); const policyId = randomUUID();
    db.prepare(`INSERT INTO budget_policies (id,user_id,provider,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,NULL,'daily',100,'stop',?,?)`).run(policyId, userId, now, now);
    const reservation = reserveUsage({ userId, provider: "openai", modelId: "a", estimatedCostMicros: 60, currency: "USD" });
    expect(() => reserveUsage({ userId, provider: "anthropic", modelId: "b", estimatedCostMicros: 60, currency: "USD" })).toThrow(/spending limit/i);
    releaseUsage(reservation);
    db.prepare("DELETE FROM budget_policies WHERE id=?").run(policyId);
  });
});
