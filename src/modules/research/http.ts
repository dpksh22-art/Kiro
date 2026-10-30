import { boundedSignal } from "@/src/core/signals";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as pinnedFetch } from "undici";

const MAX_BYTES = 2 * 1024 * 1024;

type Address = { address: string; family: number };

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!.replace(/^\[|\]$/g, "");
  try {
    const parsed = ipaddr.process(normalized);
    // The beta fetcher deliberately denies native IPv6. IANA special-purpose
    // allocations change over time; an incomplete handwritten allowlist is
    // unsafe. DNS names may still use any globally routable IPv4 answer.
    if (parsed.kind() !== "ipv4") return true;
    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
}

async function validatedAddresses(url: URL): Promise<Address[]> {
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    const address = url.hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIp(address)) throw new Error("Private network sources are blocked.");
    return [{ address, family: isIP(address) }];
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const safe = addresses.filter(({ address }) => !isPrivateIp(address));
  if (safe.length === 0) throw new Error("The source has no permitted globally routable IPv4 address.");
  return safe;
}

export async function assertPublicUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP and HTTPS sources are allowed.");
  if (url.username || url.password) throw new Error("Credentials in source URLs are not allowed.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Non-standard source ports are not allowed.");
  await validatedAddresses(url);
  return url;
}

function pinnedAgent(hostname: string, addresses: Address[]): Agent {
  let cursor = 0;
  return new Agent({
    connect: {
      lookup(requested, options, callback) {
        if (requested !== hostname) return callback(new Error("DNS hostname changed after validation."), "", 0);
        if (options.all) return callback(null, addresses);
        const selected = addresses[cursor++ % addresses.length]!;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

export async function safeFetch(input: string, init: RequestInit = {}, redirects = 0): Promise<{ response: Response; bytes: Uint8Array; finalUrl: string }> {
  if (redirects > 5) throw new Error("Too many redirects.");
  const url = await assertPublicUrl(input);
  const addresses = await validatedAddresses(url);
  const dispatcher = pinnedAgent(url.hostname, addresses);
  let response: Awaited<ReturnType<typeof pinnedFetch>>;
  try {
    response = await pinnedFetch(url, {
      ...(init as Parameters<typeof pinnedFetch>[1]),
      dispatcher,
      redirect: "manual",
      signal: boundedSignal(15_000, init.signal),
      headers: { "User-Agent": "NEXUS-AI-OS/0.1 research connector", Accept: "text/html,application/xhtml+xml,application/xml,application/json,text/plain", ...init.headers },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Redirect has no location.");
      const destination = new URL(location, url);
      const nextHeaders = new Headers(init.headers);
      if (destination.origin !== url.origin) nextHeaders.delete("authorization");
      return await safeFetch(destination.toString(), { ...init, headers: nextHeaders }, redirects + 1);
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) throw new Error("Source exceeds the 2 MiB limit.");
    if (!response.body) return { response: response as unknown as Response, bytes: new Uint8Array(), finalUrl: url.toString() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel(); throw new Error("Source exceeds the 2 MiB limit."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { response: response as unknown as Response, bytes, finalUrl: url.toString() };
  } finally {
    await dispatcher.close();
  }
}
