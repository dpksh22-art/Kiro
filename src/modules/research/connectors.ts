import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { safeFetch } from "@/src/modules/research/http";
import type { ResearchItem, ResearchSourceInput } from "@/src/modules/research/types";

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function htmlText(html: string): { title?: string; text: string; canonical?: string } {
  const $ = load(html);
  $("script,style,noscript,iframe,form,svg,canvas").remove();
  const title = normalizeSpace($("title").first().text()) || undefined;
  const canonical = $('link[rel="canonical"]').attr("href");
  const root = $("main,article").first().length ? $("main,article").first() : $("body");
  return { title, text: normalizeSpace(root.text()).slice(0, 100_000), canonical };
}

export async function fetchWeb(url: string): Promise<ResearchItem[]> {
  const { response, bytes, finalUrl } = await safeFetch(url);
  const mediaType = response.headers.get("content-type") ?? "";
  const raw = new TextDecoder().decode(bytes);
  if (mediaType.includes("json")) {
    return [{ connector: "web", sourceType: "page", canonicalUrl: finalUrl, retrievedAt: new Date().toISOString(), text: JSON.stringify(JSON.parse(raw)).slice(0, 100_000), metadata: { mediaType } }];
  }
  if (!mediaType.includes("html") && !mediaType.includes("text") && !mediaType.includes("xml")) throw new Error(`Unsupported source media type: ${mediaType || "unknown"}`);
  const parsed = mediaType.includes("html") ? htmlText(raw) : { text: normalizeSpace(raw) };
  const canonicalUrl = parsed.canonical ? new URL(parsed.canonical, finalUrl).toString() : finalUrl;
  return [{ connector: "web", sourceType: "page", title: parsed.title, canonicalUrl, retrievedAt: new Date().toISOString(), text: parsed.text, metadata: { mediaType, finalUrl } }];
}

export async function fetchFeed(url: string): Promise<ResearchItem[]> {
  const { bytes, finalUrl } = await safeFetch(url);
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, allowBooleanAttributes: true }).parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const rssChannel = (parsed.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined;
  const atomFeed = parsed.feed as Record<string, unknown> | undefined;
  const values = rssChannel?.item ?? atomFeed?.entry ?? [];
  const entries = Array.isArray(values) ? values : [values];
  return entries.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const rawLink = typeof item.link === "string" ? item.link : typeof item.link === "object" ? (item.link as Record<string, unknown>)["@_href"] : undefined;
    if (typeof rawLink !== "string") return [];
    const title = typeof item.title === "string" ? item.title : undefined;
    const body = String(item.description ?? item.summary ?? item.content ?? "");
    return [{ connector: "rss" as const, sourceType: "feed-entry" as const, title, canonicalUrl: new URL(rawLink, finalUrl).toString(), publishedAt: String(item.pubDate ?? item.published ?? item.updated ?? "") || undefined, retrievedAt: new Date().toISOString(), text: htmlText(body).text, metadata: { feedUrl: finalUrl } }];
  });
}

export async function fetchHackerNews(itemId: number): Promise<ResearchItem[]> {
  const { bytes } = await safeFetch(`https://hacker-news.firebaseio.com/v0/item/${itemId}.json`);
  const item = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (!item.id) throw new Error("Hacker News item not found.");
  return [{ connector: "hackernews", sourceType: "post", title: typeof item.title === "string" ? item.title : undefined,
    canonicalUrl: typeof item.url === "string" ? item.url : `https://news.ycombinator.com/item?id=${itemId}`,
    publishedAt: typeof item.time === "number" ? new Date(item.time * 1000).toISOString() : undefined,
    retrievedAt: new Date().toISOString(), text: normalizeSpace(String(item.text ?? item.title ?? "")), metadata: { itemId, by: item.by, score: item.score, discussionUrl: `https://news.ycombinator.com/item?id=${itemId}` } }];
}

export async function fetchGitHub(repository: string): Promise<ResearchItem[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository must use owner/name format.");
  const token = process.env.GITHUB_TOKEN;
  const { bytes } = await safeFetch(`https://api.github.com/repos/${repository}`, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const repo = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  return [{ connector: "github", sourceType: "repository", title: String(repo.full_name ?? repository), canonicalUrl: String(repo.html_url ?? `https://github.com/${repository}`),
    publishedAt: typeof repo.updated_at === "string" ? repo.updated_at : undefined, retrievedAt: new Date().toISOString(),
    text: normalizeSpace([repo.description, `Primary language: ${repo.language ?? "unknown"}`, `Default branch: ${repo.default_branch ?? "unknown"}`, `Archived: ${repo.archived ?? "unknown"}`].filter(Boolean).join(". ")),
    metadata: { id: repo.id, stars: repo.stargazers_count, forks: repo.forks_count, openIssues: repo.open_issues_count, license: (repo.license as Record<string, unknown> | null)?.spdx_id } }];
}

export async function searchTavily(query: string): Promise<ResearchItem[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured.");
  const response = await fetch("https://api.tavily.com/search", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false, safe_search: true }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
  const body = await response.json() as { results?: Array<{ url?: string }> };
  const urls = (body.results ?? []).flatMap((item) => item.url ? [item.url] : []).slice(0, 5);
  const settled = await Promise.allSettled(urls.map(fetchWeb));
  return settled.flatMap((result) => result.status === "fulfilled" ? result.value.map((item) => ({ ...item, connector: "tavily" as const, metadata: { ...item.metadata, discoveredBy: "tavily", query } })) : []);
}

export async function executeConnector(input: ResearchSourceInput): Promise<ResearchItem[]> {
  switch (input.connector) {
    case "web": return fetchWeb(input.url);
    case "rss": return fetchFeed(input.url);
    case "hackernews": return fetchHackerNews(input.itemId);
    case "github": return fetchGitHub(input.repository);
    case "tavily": return searchTavily(input.query);
  }
}
