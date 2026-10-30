import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const standalone = resolve(root, ".next/standalone");
mkdirSync(resolve(standalone, ".next"), { recursive: true });
cpSync(resolve(root, "public"), resolve(standalone, "public"), { recursive: true, force: true });
cpSync(resolve(root, ".next/static"), resolve(standalone, ".next/static"), { recursive: true, force: true });
