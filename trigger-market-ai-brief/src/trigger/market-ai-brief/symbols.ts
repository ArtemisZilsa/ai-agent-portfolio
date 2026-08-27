import type { TrackedSymbol } from "./types.js";

/**
 * Everything the brief quotes, all verified resolvable on Yahoo's
 * v8/finance/chart endpoint on 2026-08-27.
 *
 * The `label` is ours on purpose. Yahoo's own `shortName` is padded and
 * truncated for several of these — it returns "DAX                           P"
 * and "CBOE Interest Rate 10 Year T No" — so rendering the API's name straight
 * into an email looks broken. Never display `shortName`.
 */
export const TRACKED_SYMBOLS: TrackedSymbol[] = [
  // Global equity indices, roughly west-to-east.
  { symbol: "^GSPC", label: "S&P 500", group: "index" },
  { symbol: "^IXIC", label: "Nasdaq Composite", group: "index" },
  { symbol: "^DJI", label: "Dow Jones", group: "index" },
  { symbol: "^N225", label: "Nikkei 225", group: "index" },
  { symbol: "^HSI", label: "Hang Seng", group: "index" },
  { symbol: "^FTSE", label: "FTSE 100", group: "index" },
  { symbol: "^GDAXI", label: "DAX", group: "index" },
  { symbol: "^STOXX50E", label: "Euro Stoxx 50", group: "index" },

  // Commodities and the one rate that moves everything else.
  { symbol: "GC=F", label: "Gold", group: "commodity", unit: "usd" },
  { symbol: "CL=F", label: "WTI Crude", group: "commodity", unit: "usd" },
  { symbol: "BZ=F", label: "Brent Crude", group: "commodity", unit: "usd" },
  { symbol: "^TNX", label: "US 10Y Yield", group: "rate", unit: "percent" },

  // The AI trade.
  { symbol: "NVDA", label: "NVIDIA", group: "ai-equity", unit: "usd" },
  { symbol: "MSFT", label: "Microsoft", group: "ai-equity", unit: "usd" },
  { symbol: "GOOGL", label: "Alphabet", group: "ai-equity", unit: "usd" },
  { symbol: "META", label: "Meta", group: "ai-equity", unit: "usd" },
  { symbol: "AMD", label: "AMD", group: "ai-equity", unit: "usd" },
  { symbol: "AVGO", label: "Broadcom", group: "ai-equity", unit: "usd" },
  { symbol: "PLTR", label: "Palantir", group: "ai-equity", unit: "usd" },
  { symbol: "TSM", label: "TSMC", group: "ai-equity", unit: "usd" },
];

/** CoinGecko ids -> display labels. */
export const CRYPTO_IDS: Record<string, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  solana: "Solana",
};

/** Frankfurter quotes everything against a base; USD is the base we want. */
export const FX_BASE = "USD";

/** FX pairs to report, as USD -> X. */
export const FX_SYMBOLS = ["JPY", "EUR", "GBP", "CNY"];

/**
 * A quote older than this is treated as stale — the market is closed, or the
 * exchange is on holiday. The brief says so rather than reporting a flat move
 * as if it were news. Wide enough to survive a normal weekend gap on a Monday
 * morning run without falsely flagging a live quote.
 */
export const STALE_AFTER_HOURS = 24;
