import { XMLParser } from "fast-xml-parser";
import { logger } from "@trigger.dev/sdk";
import { FEEDS, HN_MIN_POINTS, HN_QUERIES } from "./sources.js";
import type { CandidateItem, SourceTier } from "./types.js";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * A plain browser UA. MarkTechPost and AI News return 403 to anything that
 * looks like a bot — including the usual "compatible; my-app/1.0" form.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MAX_SNIPPET_CHARS = 400;

/** No single feed may dominate the candidate pool. */
const MAX_ITEMS_PER_SOURCE = 30;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

/** fast-xml-parser collapses single-element lists — force an array back. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Feed text arrives as a string, a CDATA object, or a number. Flatten it. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)["#text"];
    if (typeof inner === "string") return inner;
  }
  return "";
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

/**
 * Decode HTML entities. Feeds mix named and numeric forms freely — The Verge
 * ships `&#241;` for ñ, others ship `&amp;` — and undecoded entities would flow
 * straight through Claude into the published Notion copy.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      const replacement = NAMED_ENTITIES[name.toLowerCase()];
      return replacement === undefined ? match : replacement;
    });
}

/** Titles are plain text but still arrive entity-encoded. */
function toTitle(raw: unknown): string {
  return decodeEntities(asText(raw)).replace(/\s+/g, " ").trim();
}

/** Feed descriptions are HTML. Reduce to plain text and cap the length. */
function toSnippet(raw: unknown): string {
  const stripped = asText(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(stripped).replace(/\s+/g, " ").trim();

  return text.length > MAX_SNIPPET_CHARS
    ? `${text.slice(0, MAX_SNIPPET_CHARS)}...`
    : text;
}

/** Atom links are attribute-bearing elements, sometimes several per entry. */
function atomLink(link: unknown): string {
  for (const candidate of asArray(link)) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const obj = candidate as Record<string, unknown>;
      const rel = obj["@_rel"];
      const href = obj["@_href"];
      if (typeof href === "string" && (rel === undefined || rel === "alternate")) {
        return href;
      }
    }
  }
  return "";
}

function parseDate(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const text = asText(candidate);
    if (!text) continue;
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Turn one feed document into normalized items. Handles both RSS 2.0
 * (channel/item) and Atom (feed/entry).
 */
function parseFeed(xml: string, sourceName: string, tier: SourceTier): CandidateItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const items: CandidateItem[] = [];

  for (const entry of asArray(doc?.rss?.channel?.item)) {
    const url = asText(entry?.link) || asText(entry?.guid);
    const title = toTitle(entry?.title);
    const publishedAt = parseDate(entry?.pubDate, entry?.["dc:date"], entry?.date);
    if (!url || !title || !publishedAt) continue;

    items.push({
      title,
      url,
      source: sourceName,
      tier,
      publishedAt,
      snippet: toSnippet(entry?.description ?? entry?.["content:encoded"] ?? entry?.summary),
    });
  }

  for (const entry of asArray(doc?.feed?.entry)) {
    const url = atomLink(entry?.link);
    const title = toTitle(entry?.title);
    const publishedAt = parseDate(entry?.published, entry?.updated);
    if (!url || !title || !publishedAt) continue;

    items.push({
      title,
      url,
      source: sourceName,
      tier,
      publishedAt,
      snippet: toSnippet(entry?.summary ?? entry?.content),
    });
  }

  return items;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Fetch every configured RSS/Atom feed. Failures are logged, never thrown. */
async function fetchRssFeeds(): Promise<{ items: CandidateItem[]; okCount: number }> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => parseFeed(await fetchText(feed.url), feed.name, feed.tier)),
  );

  const items: CandidateItem[] = [];
  let okCount = 0;

  results.forEach((result, index) => {
    const feed = FEEDS[index]!;
    if (result.status === "fulfilled") {
      okCount += 1;
      items.push(...result.value);
      logger.log(`feed ok: ${feed.name}`, { count: result.value.length });
    } else {
      logger.warn(`feed failed: ${feed.name}`, {
        reason: String(result.reason).slice(0, 200),
      });
    }
  });

  return { items, okCount };
}

type HnHit = {
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  points?: number | null;
  created_at?: string | null;
};

/**
 * Hacker News via the free Algolia API — no key required. This is how we catch
 * releases from vendors that publish no RSS feed.
 */
async function fetchHackerNews(sinceMs: number): Promise<CandidateItem[]> {
  const sinceSeconds = Math.floor(sinceMs / 1000);
  const items: CandidateItem[] = [];

  const results = await Promise.allSettled(
    HN_QUERIES.map(async (query) => {
      const endpoint =
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}` +
        `&tags=story&numericFilters=created_at_i>${sinceSeconds},points>${HN_MIN_POINTS}` +
        `&hitsPerPage=50`;
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { hits?: HnHit[] };
      return { query, hits: body.hits ?? [] };
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("hacker news query failed", {
        reason: String(result.reason).slice(0, 200),
      });
      continue;
    }
    const { query, hits } = result.value;
    for (const hit of hits) {
      // Ask HN and similar self-posts carry no outbound URL — skip them.
      if (!hit.url || !hit.title || !hit.created_at) continue;
      items.push({
        title: toTitle(hit.title),
        url: hit.url,
        source: "Hacker News",
        tier: "tech-press",
        publishedAt: new Date(hit.created_at).toISOString(),
        snippet: toSnippet(
          hit.story_text ?? `${hit.points ?? 0} points on Hacker News (matched: ${query})`,
        ),
      });
    }
  }

  return items;
}

/** Strip tracking params so one article isn't seen as two different URLs. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref" || key === "source" || key === "fbclid") {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

/**
 * Terms that mark a story as AI-related. Used only to screen the high-volume
 * general feeds — vendor and AI-press feeds are already on-topic.
 *
 * Deliberately specific: a bare "model" or "agent" would let through car
 * reviews and sports reporting.
 */
const AI_TERMS = [
  "ai", "a.i.", "artificial intelligence", "machine learning", "llm", "llms",
  "generative", "genai", "neural", "diffusion", "transformer", "multimodal",
  "chatbot", "copilot", "agentic", "deepfake", "text-to-video", "text-to-image",
  "openai", "chatgpt", "gpt", "sora", "dall-e",
  "anthropic", "claude", "gemini", "deepmind", "llama", "mistral", "grok",
  "hugging face", "stable diffusion", "midjourney", "runway", "elevenlabs",
  "synthesia", "heygen", "descript", "perplexity", "nano banana",
  "firefly", "photoshop", "premiere pro", "canva", "capcut", "davinci resolve",
];

/**
 * Word-boundary matching, not substring. Plain `includes(" ai")` also matches
 * "aid", "air" and "Thai", which was letting Android app-deal roundups through.
 */
const AI_PATTERN = new RegExp(
  `\\b(${AI_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/** Does this look like an AI story? Checked against title and snippet. */
function mentionsAi(item: CandidateItem): boolean {
  return AI_PATTERN.test(`${item.title} ${item.snippet}`);
}

/**
 * Collect every candidate article published within `windowDays`, de-duplicated
 * by normalized URL. Newest first.
 *
 * General tech and trade feeds are screened for an AI angle before they get
 * through: 9to5Google alone contributes ~94 items a week, almost all Android
 * app deals. Sending that to Claude wastes tokens and dilutes the ranking.
 */
export async function collectCandidates(windowDays: number): Promise<{
  candidates: CandidateItem[];
  sourcesOk: number;
  sourcesTotal: number;
}> {
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const [rss, hnItems] = await Promise.all([
    fetchRssFeeds(),
    fetchHackerNews(cutoffMs),
  ]);

  const seen = new Set<string>();
  const kept: CandidateItem[] = [];
  let droppedOffTopic = 0;

  for (const item of [...rss.items, ...hnItems]) {
    if (Date.parse(item.publishedAt) < cutoffMs) continue;

    const key = normalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate = { ...item, url: key };

    // Vendor and AI-press feeds are on-topic by construction; everything else
    // has to earn its place.
    const needsScreening = candidate.tier === "tech-press" || candidate.tier === "creative";
    if (needsScreening && !mentionsAi(candidate)) {
      droppedOffTopic += 1;
      continue;
    }

    kept.push(candidate);
  }

  kept.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  // Cap per source, newest first, so one prolific feed can't crowd out the rest.
  const perSource = new Map<string, number>();
  const candidates: CandidateItem[] = [];
  let droppedOverCap = 0;

  for (const item of kept) {
    const count = perSource.get(item.source) ?? 0;
    if (count >= MAX_ITEMS_PER_SOURCE) {
      droppedOverCap += 1;
      continue;
    }
    perSource.set(item.source, count + 1);
    candidates.push(item);
  }

  logger.log("candidate pool assembled", {
    kept: candidates.length,
    droppedOffTopic,
    droppedOverCap,
  });

  return {
    candidates,
    sourcesOk: rss.okCount + (hnItems.length > 0 ? 1 : 0),
    sourcesTotal: FEEDS.length + 1,
  };
}
