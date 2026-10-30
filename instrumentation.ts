export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverQuiescingDeletionJobs } = await import("@/src/modules/lifecycle/account-deletion");
    await recoverQuiescingDeletionJobs();
    const { startEmbeddedWorker } = await import("@/src/modules/agents/runtime");
    startEmbeddedWorker();
  }
}
