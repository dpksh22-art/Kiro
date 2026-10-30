import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "session-owner" } } as { user: { id: string } } | null,
  verifyPassword: vi.fn(),
  signOut: vi.fn(),
  deleteOwnerAccount: vi.fn(),
}));

vi.mock("@/src/core/session", () => ({ requireApiSession: vi.fn(async () => mocks.session) }));
vi.mock("@/src/core/auth", () => ({ auth: { api: { verifyPassword: mocks.verifyPassword, signOut: mocks.signOut } } }));
vi.mock("@/src/modules/lifecycle/account-deletion", () => {
  class AccountDeletionError extends Error {
    constructor(message: string, public readonly status: number, public readonly code: string) { super(message); }
  }
  return {
    ACCOUNT_DELETION_CONFIRMATION: "DELETE MY NEXUS ACCOUNT",
    AccountDeletionError,
    deleteOwnerAccount: mocks.deleteOwnerAccount,
  };
});

import { POST } from "@/app/api/v1/account/delete/route";

const key = "3f9c0e50-83a9-4a17-b0c4-647e98822e08";
function request(body: unknown) {
  return new Request("http://localhost/api/v1/account/delete", { method: "POST", headers: { "Content-Type": "application/json", cookie: "session=test" }, body: JSON.stringify(body) });
}

describe("account deletion route", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "session-owner" } };
    mocks.verifyPassword.mockReset().mockResolvedValue({ status: true });
    mocks.signOut.mockReset().mockResolvedValue({ response: { success: true }, headers: new Headers({ "Set-Cookie": "better-auth.session_token=; Max-Age=0; Path=/" }) });
    mocks.deleteOwnerAccount.mockReset().mockResolvedValue({ jobId: "job", state: "completed", retryable: false });
  });

  it("denies a missing session before password verification", async () => {
    mocks.session = null;
    const response = await POST(request({ password: "wrong password", confirmation: "DELETE MY NEXUS ACCOUNT", idempotencyKey: key }));
    expect(response.status).toBe(401);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.deleteOwnerAccount).not.toHaveBeenCalled();
  });

  it("rejects the wrong phrase and user-controlled identity fields", async () => {
    const wrongPhrase = await POST(request({ password: "valid-looking-password", confirmation: "DELETE MY ACCOUNT", idempotencyKey: key }));
    expect(wrongPhrase.status).toBe(400);
    const injectedUser = await POST(request({ password: "valid-looking-password", confirmation: "DELETE MY NEXUS ACCOUNT", idempotencyKey: key, userId: "victim" }));
    expect(injectedUser.status).toBe(400);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("uses Better Auth server verification and rejects a wrong password", async () => {
    mocks.verifyPassword.mockRejectedValue(new Error("INVALID_PASSWORD"));
    const response = await POST(request({ password: "wrong-password", confirmation: "DELETE MY NEXUS ACCOUNT", idempotencyKey: key }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("Current password") }));
    expect(mocks.deleteOwnerAccount).not.toHaveBeenCalled();
  });

  it("derives the owner from the session and completes the exact request", async () => {
    const response = await POST(request({ password: "current-password", confirmation: "DELETE MY NEXUS ACCOUNT", idempotencyKey: key }));
    expect(response.status).toBe(200);
    expect(mocks.verifyPassword).toHaveBeenCalledWith(expect.objectContaining({ body: { password: "current-password" } }));
    expect(mocks.deleteOwnerAccount).toHaveBeenCalledWith({ userId: "session-owner", confirmation: "DELETE MY NEXUS ACCOUNT", idempotencyKey: key });
    expect(mocks.signOut).toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
