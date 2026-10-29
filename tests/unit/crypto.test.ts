import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";

describe("credential encryption", () => {
  it("round-trips without exposing plaintext in the envelope", () => {
    const secret = "sk-test-super-secret";
    const envelope = encryptSecret(secret);
    expect(envelope).not.toContain(secret);
    expect(decryptSecret(envelope)).toBe(secret);
  });

  it("rejects a tampered authentication tag", () => {
    const parts = encryptSecret("sensitive").split(".");
    const tag = Buffer.from(parts[2]!, "base64url");
    tag[0] = tag[0]! ^ 0xff;
    parts[2] = tag.toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});
