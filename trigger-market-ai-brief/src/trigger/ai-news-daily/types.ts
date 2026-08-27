/**
 * Shared types for the daily AI news digest.
 */

/** How much weight Claude should give a source when ranking. */
export type SourceTier =
  | "vendor" // first-party announcement — highest signal
  | "ai-press" // dedicated AI publications
  | "tech-press" // general tech, needs AI filtering
  | "creative"; // marketing / editing / design trade press

export type FeedSource = {
  name: string;
  url: string;
  tier: SourceTier;
};

/** A normalized article, whatever feed shape it arrived in. */
export type CandidateItem = {
  title: string;
  url: string;
  source: string;
  tier: SourceTier;
  /** ISO 8601. */
  publishedAt: string;
  /** Plain-text excerpt, trimmed. May be empty — not every feed provides one. */
  snippet: string;
};

export type Freshness = "Today" | "This Week";

export type Category =
  | "Model Release"
  | "Creative Tool"
  | "Marketing Platform"
  | "Research";

export type UseCase = "Marketing" | "Editing";

/** A slide-by-slide script, produced only for the top items. */
export type CarouselScript = {
  hook: string;
  slides: string[];
  caption: string;
  hashtags: string[];
};

/** One curated entry, as Claude returns it. */
export type CuratedItem = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  freshness: Freshness;
  category: Category;
  useCases: UseCase[];
  summary: string;
  whyItMatters: string;
  /** Present only on the top-ranked items. */
  carousel?: CarouselScript;
};

export type CurateOutput = {
  items: CuratedItem[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
};

export type PublishOutput = {
  created: number;
  skipped: number;
  failed: number;
};
