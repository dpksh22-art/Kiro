export type ResearchItem = {
  connector: "web" | "rss" | "hackernews" | "github" | "tavily";
  sourceType: "page" | "feed-entry" | "post" | "repository";
  title?: string;
  canonicalUrl: string;
  publishedAt?: string;
  retrievedAt: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type ResearchSourceInput =
  | { connector: "web" | "rss"; url: string }
  | { connector: "hackernews"; itemId: number }
  | { connector: "github"; repository: string }
  | { connector: "tavily"; query: string };
