export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEmbeddedWorker } = await import("@/src/modules/agents/runtime");
    startEmbeddedWorker();
  }
}
