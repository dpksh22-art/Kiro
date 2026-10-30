export function boundedSignal(timeoutMs: number, ...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = [...signals.filter((signal): signal is AbortSignal => Boolean(signal)), AbortSignal.timeout(timeoutMs)];
  return active.length === 1 ? active[0]! : AbortSignal.any(active);
}
