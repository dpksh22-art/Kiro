import { timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getConfig } from "@/src/core/config";
import { getDb } from "@/src/core/database";

const config = getConfig();

export const auth = betterAuth({
  appName: "NEXUS AI OS",
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,
  database: getDb(),
  trustedOrigins: [config.BETTER_AUTH_URL],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    storage: "database",
  },
  advanced: {
    database: {
      joins: true,
      validateSchema: config.NODE_ENV !== "test" && process.env.NEXT_PHASE !== "phase-production-build",
    },
    useSecureCookies: config.NODE_ENV === "production",
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      const supplied = ctx.headers?.get("x-nexus-bootstrap-token") ?? "";
      const expected = config.NEXUS_BOOTSTRAP_TOKEN ?? "";
      const authorized = supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!authorized) throw new APIError("FORBIDDEN", { message: "A valid owner bootstrap token is required." });
      const row = getDb().prepare("SELECT count(*) AS count FROM user").get() as { count: number };
      if (row.count > 0) {
        throw new APIError("FORBIDDEN", { message: "The owner account already exists." });
      }
    }),
  },
});
