import { logger } from "@trigger.dev/sdk";
import {
  CRYPTO_IDS,
  FX_BASE,
  FX_SYMBOLS,
  STALE_AFTER_HOURS,
  TRACKED_SYMBOLS,
} from "./symbols.js";
import type { CryptoQuote, FxQuote, MarketSnapshot, Quote } from "./types.js";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Yahoo returns 401 to unrecognised clients. The same plain browser UA the news
 * pipeline uses works here — see ai-news-daily/feeds.ts for the original note.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
    }> | null;
    error?: { description?: string } | null;
  };
};

/**
 * One symbol from Yahoo's chart endpoint.
 *
 * Deliberately the per-symbol v8 endpoint rather than the v7 batch quote
 * endpoint: v7 returns "Unauthorized" without a cookie/crumb handshake, and
 * maintaining that handshake is far more fragile than 20 parallel requests.
 */
async function fetchYahooQuote(symbol: string): Promise<{
  price: number;
  previousClose: number | null;
  marketTimeMs: number | null;
}> {
  const endpoint =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=1d`;

  const response = await fetch(endpoint, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = (await response.json()) as YahooChartResponse;

  if (body.chart?.error) {
    throw new Error(body.chart.error.description ?? "Yahoo returned an error");
  }

  const meta = body.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== "number") throw new Error("no regularMarketPrice in response");

  const previousClose =
    typeof meta?.chartPreviousClose === "number"
      ? meta.chartPreviousClose
      : typeof meta?.previousClose === "number"
        ? meta.previousClose
        : null;

  return {
    price,
    previousClose,
    // Yahoo reports this in seconds.
    marketTimeMs:
      typeof meta?.regularMarketTime === "number" ? meta.regularMarketTime * 1000 : null,
  };
}

/** Fetch every tracked symbol in parallel. Individual failures are skipped. */
async function fetchAllQuotes(): Promise<{ quotes: Quote[]; failed: string[] }> {
  const staleBeforeMs = Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000;

  const results = await Promise.allSettled(
    TRACKED_SYMBOLS.map((tracked) => fetchYahooQuote(tracked.symbol)),
  );

  const quotes: Quote[] = [];
  const failed: string[] = [];

  results.forEach((result, index) => {
    const tracked = TRACKED_SYMBOLS[index]!;

    if (result.status === "rejected") {
      failed.push(tracked.label);
      logger.warn(`quote failed: ${tracked.label}`, {
        symbol: tracked.symbol,
        reason: String(result.reason).slice(0, 200),
      });
      return;
    }

    const { price, previousClose, marketTimeMs } = result.value;

    quotes.push({
      label: tracked.label,
      group: tracked.group,
      price,
      changePct:
        previousClose && previousClose !== 0
          ? ((price - previousClose) / previousClose) * 100
          : null,
      unit: tracked.unit,
      stale: marketTimeMs !== null && marketTimeMs < staleBeforeMs,
    });
  });

  return { quotes, failed };
}

type CoinGeckoPrices = Record<string, { usd?: number; usd_24h_change?: number }>;

/** Crypto prices plus total market cap, from CoinGecko's keyless free tier. */
async function fetchCrypto(): Promise<{
  crypto: CryptoQuote[];
  marketCapUsd: number | null;
}> {
  const ids = Object.keys(CRYPTO_IDS);

  const priceEndpoint =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}` +
    `&vs_currencies=usd&include_24hr_change=true`;

  const [priceResult, globalResult] = await Promise.allSettled([
    fetch(priceEndpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<CoinGeckoPrices>;
    }),
    fetch("https://api.coingecko.com/api/v3/global", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ data?: { total_market_cap?: Record<string, number> } }>;
    }),
  ]);

  const crypto: CryptoQuote[] = [];

  if (priceResult.status === "fulfilled") {
    for (const [id, label] of Object.entries(CRYPTO_IDS)) {
      const entry = priceResult.value[id];
      if (!entry || typeof entry.usd !== "number") continue;
      crypto.push({
        label,
        price: entry.usd,
        changePct: typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : null,
      });
    }
  } else {
    logger.warn("coingecko prices failed", {
      reason: String(priceResult.reason).slice(0, 200),
    });
  }

  const marketCapUsd =
    globalResult.status === "fulfilled"
      ? (globalResult.value.data?.total_market_cap?.usd ?? null)
      : null;

  if (globalResult.status === "rejected") {
    logger.warn("coingecko global failed", {
      reason: String(globalResult.reason).slice(0, 200),
    });
  }

  return { crypto, marketCapUsd };
}

/**
 * FX from Frankfurter (European Central Bank reference rates).
 *
 * The ECB publishes one fix per working day, so these will be identical across
 * every run on the same day. `asOf` is carried through so the brief can label
 * them as a daily fix rather than imply an intraday move.
 */
async function fetchFx(): Promise<{ fx: FxQuote[]; asOf: string | null }> {
  const endpoint =
    `https://api.frankfurter.dev/v1/latest?base=${FX_BASE}&symbols=${FX_SYMBOLS.join(",")}`;

  const response = await fetch(endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = (await response.json()) as { date?: string; rates?: Record<string, number> };

  const fx: FxQuote[] = [];
  for (const symbol of FX_SYMBOLS) {
    const rate = body.rates?.[symbol];
    if (typeof rate === "number") fx.push({ pair: `${FX_BASE}/${symbol}`, rate });
  }

  return { fx, asOf: body.date ?? null };
}

/**
 * Collect every market source in parallel.
 *
 * Nothing here throws on a partial failure — a dead source is recorded in
 * `unavailable` so the brief names it explicitly. Deciding that *everything*
 * failed is the orchestrator's job, not this function's.
 */
export async function collectMarketSnapshot(): Promise<MarketSnapshot> {
  const [quoteResult, cryptoResult, fxResult] = await Promise.allSettled([
    fetchAllQuotes(),
    fetchCrypto(),
    fetchFx(),
  ]);

  const unavailable: string[] = [];

  let quotes: Quote[] = [];
  if (quoteResult.status === "fulfilled") {
    quotes = quoteResult.value.quotes;
    unavailable.push(...quoteResult.value.failed);
  } else {
    unavailable.push("all equity, commodity and rate quotes");
    logger.warn("yahoo layer failed entirely", {
      reason: String(quoteResult.reason).slice(0, 200),
    });
  }

  let crypto: CryptoQuote[] = [];
  let cryptoMarketCapUsd: number | null = null;
  if (cryptoResult.status === "fulfilled") {
    crypto = cryptoResult.value.crypto;
    cryptoMarketCapUsd = cryptoResult.value.marketCapUsd;
    if (crypto.length === 0) unavailable.push("crypto");
  } else {
    unavailable.push("crypto");
  }

  let fx: FxQuote[] = [];
  let fxAsOf: string | null = null;
  if (fxResult.status === "fulfilled") {
    fx = fxResult.value.fx;
    fxAsOf = fxResult.value.asOf;
  } else {
    unavailable.push("FX");
    logger.warn("frankfurter failed", { reason: String(fxResult.reason).slice(0, 200) });
  }

  logger.log("market snapshot assembled", {
    quotes: quotes.length,
    crypto: crypto.length,
    fx: fx.length,
    staleQuotes: quotes.filter((q) => q.stale).length,
    unavailable,
  });

  return { quotes, crypto, cryptoMarketCapUsd, fx, fxAsOf, unavailable };
}

/** True when nothing at all came back — the caller should throw and retry. */
export function isSnapshotEmpty(snapshot: MarketSnapshot): boolean {
  return (
    snapshot.quotes.length === 0 && snapshot.crypto.length === 0 && snapshot.fx.length === 0
  );
}
