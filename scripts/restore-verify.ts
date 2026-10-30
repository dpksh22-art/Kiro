import { BackupError, verifyBackup } from "../src/core/backup";

const bundle = process.argv[2];
if (!bundle || process.argv.length !== 3) {
  console.error(JSON.stringify({ ok: false, error: { code: "usage", message: "Usage: npm run restore:verify -- <absolute-bundle-dir>" } }));
  process.exitCode = 1;
} else {
  verifyBackup(bundle).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    const failure = error instanceof BackupError ? error : new BackupError("restore_verify_failed", error instanceof Error ? error.message : "Restore verification failed.");
    console.error(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }));
    process.exitCode = 1;
  });
}
