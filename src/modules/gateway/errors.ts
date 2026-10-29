export type GatewayErrorCode =
  | "authentication_failed"
  | "rate_limited"
  | "model_not_found"
  | "unsupported_capability"
  | "budget_exceeded"
  | "provider_unavailable"
  | "request_invalid"
  | "cancelled"
  | "provider_error";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly status: number = 502,
    public readonly retryable: boolean = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export async function providerError(response: Response): Promise<GatewayError> {
  const text = (await response.text()).slice(0, 1_000);
  const safe = text.replace(/(?:sk|key|token)-[A-Za-z0-9_-]+/gi, "[REDACTED]");
  if (response.status === 401 || response.status === 403) return new GatewayError("authentication_failed", "Provider authentication failed.", 401);
  if (response.status === 404) return new GatewayError("model_not_found", "The provider endpoint or model was not found.", 404);
  if (response.status === 429) {
    const retrySeconds = Number(response.headers.get("retry-after"));
    return new GatewayError("rate_limited", "The provider rate limit was reached.", 429, true, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : undefined);
  }
  if (response.status >= 500) return new GatewayError("provider_unavailable", `Provider unavailable (${response.status}).`, 503, true);
  return new GatewayError("provider_error", `Provider rejected the request (${response.status}): ${safe}`, 502);
}
