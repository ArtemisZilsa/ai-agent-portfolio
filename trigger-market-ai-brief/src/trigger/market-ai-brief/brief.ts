import { logger, schedules } from "@trigger.dev/sdk";
import { collectCandidates } from "../ai-news-daily/feeds.js";
import { collectMarketSnapshot, isSnapshotEmpty } from "./market.js";
import { summarizeBrief } from "./summarize.js";
import { sendBrief } from "./send-brief.js";
import type { Headline } from "./types.js";

/**
 * Fallback news window for the very first run, when there is no previous run to
 * measure from. Slightly wider than the 6h cron so nothing falls through the
 * gap between runs.
 */
const FALLBACK_WINDOW_HOURS = 7;

/** However long the gap, never look back further than this. */
const MAX_WINDOW_HOURS = 24;

/** Cap the headlines carried into the prompt. */
const MAX_HEADLINES = 60;

function formatWindow(fromMs: number, toMs: number, timezone: string): string {
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  return `${fmt(fromMs)} to ${fmt(toMs)} (${timezone})`;
}

export const marketAiBrief = schedules.task({
  id: "market-ai-brief",
  cron: { pattern: "0 */6 * * *", timezone: "Asia/Tokyo" },
  maxDuration: 900,
  run: async (payload) => {
    // Fail fast on missing config, before spending anything on Claude.
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
    if (!process.env.BRIEF_RECIPIENT_EMAIL) {
      throw new Error("BRIEF_RECIPIENT_EMAIL is not set");
    }

    const timezone = payload.timezone ?? "Asia/Tokyo";
    const nowMs = payload.timestamp.getTime();

    /**
     * Measure the news window from the previous run rather than a fixed
     * lookback. This is what stops the same story appearing in two consecutive
     * briefs: each run only ever sees what was published since the last one.
     * Clamped, so a long outage cannot pull in a week of stale headlines.
     */
    const elapsedHours = payload.lastTimestamp
      ? (nowMs - payload.lastTimestamp.getTime()) / 3_600_000
      : FALLBACK_WINDOW_HOURS;
    const windowHours = Math.min(Math.max(elapsedHours, 1), MAX_WINDOW_HOURS);

    logger.log("starting market + ai brief", {
      scheduledFor: payload.timestamp,
      lastRun: payload.lastTimestamp ?? null,
      windowHours: Number(windowHours.toFixed(2)),
      timezone,
    });

    // Markets and news are independent — fetch both at once. Neither throws on
    // a partial failure, so Promise.all is safe here. (Note this is plain
    // fetching, not triggerAndWait, which must never go in Promise.all.)
    const [snapshot, news] = await Promise.all([
      collectMarketSnapshot(),
      collectCandidates(windowHours / 24),
    ]);

    // Every market source failing at once is a network problem, not a quiet
    // market. Throw so Trigger.dev retries rather than emailing an empty brief.
    if (isSnapshotEmpty(snapshot)) {
      throw new Error(
        "No market data from any source (Yahoo, CoinGecko, Frankfurter) — likely a network problem",
      );
    }

    const headlines: Headline[] = news.candidates.slice(0, MAX_HEADLINES).map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      publishedAt: item.publishedAt,
    }));

    logger.log("inputs collected", {
      quotes: snapshot.quotes.length,
      crypto: snapshot.crypto.length,
      fx: snapshot.fx.length,
      headlines: headlines.length,
      feedsOk: `${news.sourcesOk}/${news.sourcesTotal}`,
      unavailable: snapshot.unavailable,
    });

    const windowLabel = formatWindow(nowMs - windowHours * 3_600_000, nowMs, timezone);

    // Write the brief. The expensive step, isolated so delivery can retry
    // without paying for it twice.
    const written = await summarizeBrief.triggerAndWait({
      snapshot,
      headlines,
      windowLabel,
    });

    if (!written.ok) {
      logger.error("summarization failed", { error: written.error });
      throw new Error("Could not write the brief — see the summarize-brief run for details");
    }

    const brief = written.output;

    const generatedAt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(new Date(nowMs));

    // Deliberately not re-thrown on failure: throwing here would retry the
    // whole scheduled run and pay for the Claude call a second time. send-brief
    // has already exhausted its own retries by this point.
    const sent = await sendBrief.triggerAndWait({ brief, snapshot, generatedAt });

    if (!sent.ok) {
      logger.error("delivery failed after its own retries — not re-running summarization", {
        error: sent.error,
      });
      return {
        sent: false,
        headline: brief.headline,
        bullets: brief.bullets.length,
        estimatedCostUsd: Number(brief.usage.estimatedCostUsd.toFixed(4)),
      };
    }

    logger.log("brief complete", {
      headline: brief.headline,
      emailId: sent.output.emailId,
      estimatedCostUsd: Number(brief.usage.estimatedCostUsd.toFixed(4)),
    });

    return {
      sent: true,
      headline: brief.headline,
      bullets: brief.bullets.length,
      estimatedCostUsd: Number(brief.usage.estimatedCostUsd.toFixed(4)),
    };
  },
});
