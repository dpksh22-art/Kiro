import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "@/src/core/config";

const VERSION = "v1";

function getKey(): Buffer {
  const encoded = getConfig().NEXUS_MASTER_KEY;
  if (!encoded) throw new Error("NEXUS_MASTER_KEY is required to store or use provider credentials.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("NEXUS_MASTER_KEY must decode to exactly 32 bytes.");
  return key;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string): string {
  const [version, ivText, tagText, cipherText] = envelope.split(".");
  if (version !== VERSION || !ivText || !tagText || !cipherText) throw new Error("Unsupported credential envelope.");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64url")), decipher.final()]).toString("utf8");
}
