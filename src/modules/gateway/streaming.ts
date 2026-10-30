import { GatewayError } from "@/src/modules/gateway/errors";

export const PROVIDER_STREAM_LIMITS = Object.freeze({
  maxStreamBytes: 8_000_000,
  maxFrameBytes: 1_100_000,
  maxLineBytes: 1_100_000,
  maxToolArgumentsBytes: 256_000,
});

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const overflow = (kind: string): GatewayError => new GatewayError("provider_error", `Provider ${kind} exceeded the local byte limit.`, 502);

export function appendBoundedUtf8(current: string, delta: string, maximum: number, kind: string): string {
  if (bytes(current) + bytes(delta) > maximum) throw overflow(kind);
  return current + delta;
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel("provider stream byte limit exceeded"); } catch { /* stream may already be errored */ }
}

export async function* parseSse(response: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!response.body) throw new Error("Provider response has no stream body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  let frameBytes = 0;
  let streamBytes = 0;
  let streamFinished = false;

  const emit = () => {
    if (data.length === 0) return undefined;
    const value = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    frameBytes = 0;
    return value;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        streamBytes += value.byteLength;
        if (streamBytes > PROVIDER_STREAM_LIMITS.maxStreamBytes) throw overflow("stream");
      }
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      if (bytes(buffer) > PROVIDER_STREAM_LIMITS.maxLineBytes) throw overflow("stream line");
      for (const line of lines) {
        if (bytes(line) > PROVIDER_STREAM_LIMITS.maxLineBytes) throw overflow("stream line");
        if (line === "") {
          const item = emit();
          if (item) yield item;
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const part = line.slice(5).trimStart();
          frameBytes += bytes(part) + (data.length ? 1 : 0);
          if (frameBytes > PROVIDER_STREAM_LIMITS.maxFrameBytes) throw overflow("SSE frame");
          data.push(part);
        }
      }
      if (done) { streamFinished = true; break; }
    }
    const item = emit();
    if (item) yield item;
  } catch (error) {
    if (error instanceof GatewayError) await cancelQuietly(reader);
    throw error;
  } finally {
    if (!streamFinished) await cancelQuietly(reader);
  }
}

export async function* parseNdjson(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("Provider response has no stream body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamBytes = 0;
  let streamFinished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        streamBytes += value.byteLength;
        if (streamBytes > PROVIDER_STREAM_LIMITS.maxStreamBytes) throw overflow("stream");
      }
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      if (bytes(buffer) > PROVIDER_STREAM_LIMITS.maxLineBytes) throw overflow("NDJSON line");
      for (const line of lines) {
        if (bytes(line) > PROVIDER_STREAM_LIMITS.maxLineBytes) throw overflow("NDJSON line");
        if (line.trim()) yield JSON.parse(line);
      }
      if (done) { streamFinished = true; break; }
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } catch (error) {
    if (error instanceof GatewayError) await cancelQuietly(reader);
    throw error;
  } finally {
    if (!streamFinished) await cancelQuietly(reader);
  }
}
