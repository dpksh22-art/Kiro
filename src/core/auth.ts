import { createNexusAuth } from "@/src/core/auth-config";

// Runtime initialization keeps Better Auth schema validation enabled in production.
export const auth = createNexusAuth();
