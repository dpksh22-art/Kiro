import { rmSync } from "node:fs";
import { resolve } from "node:path";
for (const suffix of ["", "-wal", "-shm"]) rmSync(resolve(process.cwd(), `data/production-smoke.db${suffix}`), { force: true });
