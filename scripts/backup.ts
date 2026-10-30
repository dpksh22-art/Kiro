import { BackupError, createBackup } from "../src/core/backup";

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error(JSON.stringify({ ok: false, error: { code: "usage", message: "Usage: npm run backup -- <absolute-dir>" } }));
  process.exitCode = 1;
} else {
  createBackup(target).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    const failure = error instanceof BackupError ? error : new BackupError("backup_failed", error instanceof Error ? error.message : "Backup failed.");
    console.error(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }));
    process.exitCode = 1;
  });
}
