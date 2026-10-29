import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/src/core/auth";

export const { GET, POST } = toNextJsHandler(auth);
