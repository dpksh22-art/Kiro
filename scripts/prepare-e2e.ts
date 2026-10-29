import { rmSync } from "node:fs";
import { resolve } from "node:path";

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(resolve(process.cwd(), `data/e2e.db${suffix}`), { force: true });
}

const { migrate } = await import("./migrate");
await migrate();
