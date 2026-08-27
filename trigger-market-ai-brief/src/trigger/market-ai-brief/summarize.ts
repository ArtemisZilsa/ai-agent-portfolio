import Anthropic from "@anthropic-ai/sdk";
import { AbortTaskRunError, logger, task } from "@trigger.dev/sdk";
import type { BriefOutput, Headline, MarketSnapshot, Quote } from "./types.js";

const MODEL = "claude-sonnet-5";

/** Sonnet 5 list price, $ per million tokens. Used for the cost log line only. */
const INPUT_COST_PER_MTOK = 2;
const OUTPUT_COST_PER_MTOK = 10;

const MAX_BULLETS = 6;

/** Cap the headlines sent to Claude. They arrive newest-first, so this trims the tail. */
const MAX_HEADLINES = 60;

const SYSTEM_PROMPT = `You write a recurring market and AI briefing that is emailed to one reader every 6 hours.

Your reader wants to know, in under a minute: what moved, why it might matter, and what happened in AI.

TONE
Plain, factual, and specific. Write like a analyst's morning note, not like marketing copy.
No hype, no filler, no "in today's fast-moving landscape". Never use exclamation marks.

HARD RULES
- Only describe numbers that appear in the data given to you. Never invent or estimate a price, a percentage, or a market cap.
- Never explain WHY a market moved unless a supplied headline actually supports it. Correlation is not causation, and you do not have the news coverage to justify most moves. Describing the move itself is enough.
- Quotes marked "stale" mean that market is CLOSED (weekend, holiday, or outside trading hours). Say the market is closed. Never report a stale 0.00% as if it were a trading session that ended flat.
- FX rates are a once-daily European Central Bank fix. They do not move between briefs on the same day. Never describe FX as having moved intraday.
- If a data source is listed as unavailable, say so plainly in one short clause. Do not silently omit it, and do not treat missing data as a flat market.
- If there are no headlines, say there was no significant AI news in the window. Do not pad.

OUTPUT
- "headline": one sentence, under 90 characters, capturing the single most notable thing. This becomes the email subject line. No trailing period.
- "marketsParagraph": 2-4 sentences on indices, commodities, rates, crypto and FX. Lead with the biggest mover.
- "aiParagraph": 2-4 sentences on the AI-sector equities and what the headlines show. Connect the two only if the data supports it.
- "bullets": up to ${MAX_BULLETS} of the most significant headlines. Copy each "url" EXACTLY as given. "note" is one short clause on why it matters — under 120 characters.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    marketsParagraph: { type: "string" },
    aiParagraph: { type: "string" },
    bullets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
        },
        required: ["title", "url", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "marketsParagraph", "aiParagraph", "bullets"],
  additionalProperties: false,
};

type ModelBullet = { title?: string; url?: string; note?: string };

/** Render a quote group as compact lines for the prompt. */
function renderQuotes(quotes: Quote[], group: Quote["group"]): string {
  const rows = quotes.filter((q) => q.group === group);
  if (rows.length === 0) return "  (none available)";

  return rows
    .map((q) => {
      const change =
        q.changePct === null ? "change unknown" : `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`;
      const price = q.unit === "percent" ? `${q.price.toFixed(3)}%` : q.price.toLocaleString("en-US");
      return `  ${q.label}: ${price} (${change})${q.stale ? " [stale — market closed]" : ""}`;
    })
    .join("\n");
}

function renderSnapshot(snapshot: MarketSnapshot): string {
  const parts: string[] = [];

  parts.push("GLOBAL EQUITY INDICES:\n" + renderQuotes(snapshot.quotes, "index"));
  parts.push("COMMODITIES:\n" + renderQuotes(snapshot.quotes, "commodity"));
  parts.push("RATES:\n" + renderQuotes(snapshot.quotes, "rate"));
  parts.push("AI-SECTOR EQUITIES:\n" + renderQuotes(snapshot.quotes, "ai-equity"));

  const crypto =
    snapshot.crypto.length === 0
      ? "  (none available)"
      : snapshot.crypto
          .map((c) => {
            const change =
              c.changePct === null
                ? "change unknown"
                : `${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(2)}% 24h`;
            return `  ${c.label}: $${c.price.toLocaleString("en-US")} (${change})`;
          })
          .join("\n");
  const mcap =
    snapshot.cryptoMarketCapUsd === null
      ? ""
      : `\n  Total crypto market cap: $${(snapshot.cryptoMarketCapUsd / 1e12).toFixed(2)}T`;
  parts.push("CRYPTO:\n" + crypto + mcap);

  const fx =
    snapshot.fx.length === 0
      ? "  (none available)"
      : snapshot.fx.map((f) => `  ${f.pair}: ${f.rate}`).join("\n");
  parts.push(
    `FX (ECB daily fix${snapshot.fxAsOf ? `, as of ${snapshot.fxAsOf}` : ""} — does NOT move between briefs):\n` +
      fx,
  );

  if (snapshot.unavailable.length > 0) {
    parts.push(`UNAVAILABLE THIS RUN: ${snapshot.unavailable.join(", ")}`);
  }

  return parts.join("\n\n");
}

/**
 * Turns the snapshot and headlines into the written brief.
 *
 * Split from sending for the reason publish-to-notion is split from curation in
 * the news pipeline: a delivery retry must never re-run this and pay twice.
 */
export const summarizeBrief = task({
  id: "summarize-brief",
  retry: { maxAttempts: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 20_000, factor: 2 },
  maxDuration: 600,
  run: async (payload: {
    snapshot: MarketSnapshot;
    headlines: Headline[];
    windowLabel: string;
  }): Promise<BriefOutput> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const client = new Anthropic({ apiKey });

    const headlines = payload.headlines.slice(0, MAX_HEADLINES);

    // Our own trusted record, keyed by URL. Anything the model returns is
    // rebuilt from this, so a hallucinated URL has no match and is dropped.
    const byUrl = new Map(headlines.map((h) => [h.url, h]));

    const headlineBlock =
      headlines.length === 0
        ? "(no AI headlines published in this window)"
        : JSON.stringify(
            headlines.map((h) => ({
              title: h.title,
              url: h.url,
              source: h.source,
              publishedAt: h.publishedAt,
            })),
          );

    let message;
    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 8_000,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: {
            type: "json_schema",
            schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [
          {
            role: "user",
            content:
              `Write the brief for the window covering ${payload.windowLabel}.\n\n` +
              `=== MARKET DATA ===\n${renderSnapshot(payload.snapshot)}\n\n` +
              `=== AI HEADLINES PUBLISHED IN THIS WINDOW (${headlines.length}) ===\n${headlineBlock}`,
          },
        ],
      });
      message = await stream.finalMessage();
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new AbortTaskRunError("ANTHROPIC_API_KEY is invalid — check the key in .env");
      }
      if (error instanceof Anthropic.BadRequestError) {
        throw new AbortTaskRunError(`Claude rejected the request: ${error.message}`);
      }
      throw error;
    }

    if (message.stop_reason === "refusal") {
      throw new AbortTaskRunError("Claude declined to write this brief");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("Claude hit max_tokens before finishing — output truncated, retrying");
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed: {
      headline?: string;
      marketsParagraph?: string;
      aiParagraph?: string;
      bullets?: ModelBullet[];
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Claude returned unparseable JSON (${text.length} chars)`);
    }

    if (!parsed.headline || !parsed.marketsParagraph) {
      throw new Error("Claude returned a brief with no headline or markets paragraph");
    }

    // Keep only the model's judgement; take every fact about the article from
    // our own record.
    let dropped = 0;
    const bullets: BriefOutput["bullets"] = [];
    for (const bullet of parsed.bullets ?? []) {
      const trusted = bullet.url ? byUrl.get(bullet.url) : undefined;
      if (!trusted) {
        dropped += 1;
        continue;
      }
      bullets.push({
        title: trusted.title,
        url: trusted.url,
        source: trusted.source,
        note: (bullet.note ?? "").trim(),
      });
      if (bullets.length >= MAX_BULLETS) break;
    }

    if (dropped > 0) {
      logger.warn("dropped bullets with unrecognised urls", { dropped });
    }

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const estimatedCostUsd =
      (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
      (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;

    logger.log("brief written", {
      bullets: bullets.length,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    });

    return {
      headline: parsed.headline.trim(),
      marketsParagraph: parsed.marketsParagraph.trim(),
      aiParagraph: (parsed.aiParagraph ?? "").trim(),
      bullets,
      usage: { inputTokens, outputTokens, estimatedCostUsd },
    };
  },
});
