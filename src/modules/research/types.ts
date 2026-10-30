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

export type ResearchModelTarget = { connectionId: string; modelId: string };
export type ResearchStatus = "evidence_only" | "synthesized" | "failed_synthesis";

export type StoredResearchSource = {
  id: string;
  title?: string;
  canonicalUrl: string;
  publishedAt?: string;
  retrievedAt: string;
  contentHash: string;
  excerpt: string;
  connector: ResearchItem["connector"];
};

export type ResearchClaim = {
  text: string;
  sourceIds: string[];
  confidence: "low" | "medium" | "high";
  uncertainty: string;
};

export type ResearchSynthesis = {
  executiveSummary: string;
  claims: ResearchClaim[];
  contradictions: string[];
  limitations: string[];
};

export type CitationSupport = {
  sourceId: string;
  supported: boolean;
  overlappingTokens: string[];
};

export type ClaimVerification = {
  claimIndex: number;
  status: "supported" | "unsupported";
  citations: CitationSupport[];
};

export type ResearchVerification = {
  status: "supported" | "has_unsupported_claims";
  claims: ClaimVerification[];
};
