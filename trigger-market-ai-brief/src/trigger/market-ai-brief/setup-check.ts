import { logger, task } from "@trigger.dev/sdk";
import { collectCandidates } from "../ai-news-daily/feeds.js";
import { collectMarketSnapshot, isSnapshotEmpty } from "./market.js";
import { TRACKED_SYMBOLS } from "./symbols.js";

/**
 * Health check for the market + AI brief. Run this before the real thing.
 *
 * It confirms the env vars are present, every market source answers, and the
 * news feeds return something — then reports what it found.
 *
 * It never calls Claude and never sends an email, so it is free to re-run.
 */
export const marketBriefSetupCheck = task({
  id: "market-brief-setup-check",
  retry: { maxAttempts: 1 },
  maxDuration: 300,
  run: async () => {
    // 1. Environment. Report every problem at once rather than stopping at the
    //    first, so the fix is a single pass.
    const missing: string[] = [];
    for (const key of ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "BRIEF_RECIPIENT_EMAIL"]) {
      if (!process.env[key]) missing.push(key);
    }

    logger.log("environment", {
      missing,
      from: process.env.BRIEF_FROM_EMAIL ?? "onboarding@resend.dev (default)",
      // Never log the values themselves — only whether they resolved.
      recipientConfigured: Boolean(process.env.BRIEF_RECIPIENT_EMAIL),
    });

    if (missing.length > 0) {
      throw new Error(
        `Missing env vars: ${missing.join(", ")}. Add them to .env, and to the ` +
          `Trigger.dev dashboard before deploying.`,
      );
    }

    // 2. Market data.
    const snapshot = await collectMarketSnapshot();

    if (isSnapshotEmpty(snapshot)) {
      throw new Error("No market data from any source — check network access from this runner");
    }

    logger.log("market sources", {
      quotesOk: `${snapshot.quotes.length}/${TRACKED_SYMBOLS.length}`,
      cryptoOk: snapshot.crypto.length,
      fxOk: snapshot.fx.length,
      fxAsOf: snapshot.fxAsOf,
      stale: snapshot.quotes.filter((q) => q.stale).map((q) => q.label),
      unavailable: snapshot.unavailable,
    });

    // A sample, so the run log shows real numbers and not just counts.
    logger.log(
      "sample quotes",
      Object.fromEntries(
        snapshot.quotes.slice(0, 8).map((q) => [
          q.label,
          `${q.price} (${q.changePct === null ? "n/a" : `${q.changePct.toFixed(2)}%`})${q.stale ? " stale" : ""}`,
        ]),
      ),
    );

    // 3. News feeds, over the same 7h window the first real run would use.
    const news = await collectCandidates(7 / 24);

    logger.log("news feeds", {
      feedsOk: `${news.sourcesOk}/${news.sourcesTotal}`,
      headlinesInLast7h: news.candidates.length,
      newest: news.candidates[0]?.title ?? "(none in window)",
    });

    // Zero headlines in a 7h window is normal overnight — not a failure.
    if (news.candidates.length === 0) {
      logger.warn(
        "no headlines in the last 7 hours — normal outside news hours, the brief will send market-only",
      );
    }

    logger.log("=== SETUP CHECK PASSED ===", {
      next: "Trigger 'market-ai-brief' to send a real test email",
    });

    return {
      quotes: snapshot.quotes.length,
      crypto: snapshot.crypto.length,
      fx: snapshot.fx.length,
      headlines: news.candidates.length,
      unavailable: snapshot.unavailable,
    };
  },
});
