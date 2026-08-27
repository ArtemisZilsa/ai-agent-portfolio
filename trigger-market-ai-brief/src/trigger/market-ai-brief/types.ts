/**
 * Shared types for the market + AI brief.
 */

export type SymbolGroup = "index" | "commodity" | "rate" | "ai-equity";

export type TrackedSymbol = {
  symbol: string;
  /** Our display name. Never Yahoo's `shortName` — see symbols.ts. */
  label: string;
  group: SymbolGroup;
  /** How to render the price. Indices are unitless point values. */
  unit?: "usd" | "percent";
};

/** One resolved price, normalized across every source. */
export type Quote = {
  label: string;
  group: SymbolGroup;
  price: number;
  /** Percent move vs the previous close. Null when we have no prior close. */
  changePct: number | null;
  unit?: "usd" | "percent";
  /** True when the quote has not updated recently — market closed or holiday. */
  stale: boolean;
};

export type CryptoQuote = {
  label: string;
  price: number;
  changePct: number | null;
};

export type FxQuote = {
  pair: string;
  rate: number;
};

/**
 * Everything the market layer managed to collect. Any field may be empty:
 * a source that fails is logged and skipped, and `unavailable` names it so the
 * brief can say what is missing instead of implying a flat market.
 */
export type MarketSnapshot = {
  quotes: Quote[];
  crypto: CryptoQuote[];
  cryptoMarketCapUsd: number | null;
  fx: FxQuote[];
  /** ECB publishes once per working day, so FX will not move between runs. */
  fxAsOf: string | null;
  unavailable: string[];
};

/** A headline handed to Claude, and echoed back in the email. */
export type Headline = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
};

/** What Claude writes. */
export type BriefOutput = {
  /** One sentence, used as the email subject line. */
  headline: string;
  marketsParagraph: string;
  aiParagraph: string;
  bullets: Array<{ title: string; url: string; source: string; note: string }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
};

export type SendOutput = {
  sent: boolean;
  emailId: string | null;
};
