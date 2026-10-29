import { isAbsolute } from "node:path";
import { z } from "zod";

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32),
  NEXUS_DATABASE_PATH: z.string().min(1).default("./data/nexus.db"),
  NEXUS_MASTER_KEY: z.string().optional(),
  NEXUS_BOOTSTRAP_TOKEN: z.string().min(24).optional(),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434"),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === "production" && value.NEXUS_DATABASE_PATH !== ":memory:" && !isAbsolute(value.NEXUS_DATABASE_PATH)) {
    ctx.addIssue({ code: "custom", path: ["NEXUS_DATABASE_PATH"], message: "Must be absolute in production so migration and standalone server resolve the same file." });
  }
  if (value.NEXUS_MASTER_KEY) {
    let decoded: Buffer;
    try { decoded = Buffer.from(value.NEXUS_MASTER_KEY, "base64"); }
    catch { decoded = Buffer.alloc(0); }
    if (decoded.length !== 32) ctx.addIssue({ code: "custom", path: ["NEXUS_MASTER_KEY"], message: "Must decode to exactly 32 bytes." });
  } else if (value.NODE_ENV === "production") {
    ctx.addIssue({ code: "custom", path: ["NEXUS_MASTER_KEY"], message: "Required in production." });
  }
});

export type ServerConfig = z.infer<typeof serverSchema>;

let cached: ServerConfig | undefined;

export function getConfig(): ServerConfig {
  if (!cached) {
    cached = serverSchema.parse(process.env);
  }
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
