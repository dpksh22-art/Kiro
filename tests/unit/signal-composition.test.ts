import { describe, expect, it } from "vitest";
import { boundedSignal } from "@/src/core/signals";

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("outbound cancellation composition", () => {
  it("retains the fixed deadline when an owner signal is present", async () => {
    const owner = new AbortController();
    const signal = boundedSignal(10, owner.signal);
    await waitForAbort(signal);
    expect(signal.aborted).toBe(true);
    expect(owner.signal.aborted).toBe(false);
  });

  it("also propagates owner and caller cancellation before the deadline", async () => {
    const owner = new AbortController(); const caller = new AbortController();
    const signal = boundedSignal(60_000, owner.signal, caller.signal);
    caller.abort(new Error("caller cancelled"));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(caller.signal.reason);
  });
});
