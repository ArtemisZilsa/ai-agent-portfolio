import { logger, schedules } from "@trigger.dev/sdk";
import { curateDigest } from "./curate.js";
import { publishToNotion } from "./publish.js";
import { collectCandidates } from "./feeds.js";
import { fetchRecentUrls, requireDataSourceId } from "./notion.js";

/**
 * How far back to gather articles. Wider than one day on purpose: on a quiet
 * news day there are not 20 qualifying stories, so Claude picks the best of a
 * rolling pool instead of the list being padded with junk. Anything already
 * published to Notion is filtered out first, so nothing repeats.
 */
const CANDIDATE_WINDOW_DAYS = 7;

/** How far back to look in Notion when deciding what has already been sent. */
const DEDUPE_WINDOW_DAYS = 14;

/** Below this, something is wrong with the network rather than the news cycle. */
const MIN_VIABLE_CANDIDATES = 20;

export const dailyAiDigest = schedules.task({
  id: "daily-ai-digest",
  cron: { pattern: "0 7 * * *", timezone: "Asia/Tokyo" },
  maxDuration: 900,
  run: async (payload) => {
    logger.log("starting daily digest", {
      scheduledFor: payload.timestamp,
      timezone: payload.timezone,
    });

    // Fail fast on missing config, before spending anything.
    const dataSourceId = requireDataSourceId();
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

    // 1. Gather. Cheap, and safe to repeat.
    const { candidates, sourcesOk, sourcesTotal } = await collectCandidates(CANDIDATE_WINDOW_DAYS);
    logger.log("fetched candidates", {
      candidates: candidates.length,
      sourcesOk,
      sourcesTotal,
    });

    if (candidates.length < MIN_VIABLE_CANDIDATES) {
      throw new Error(
        `Only ${candidates.length} candidates from ${sourcesOk}/${sourcesTotal} sources — too few to curate, likely a network problem`,
      );
    }

    // 2. Drop anything already published, so Claude never spends tokens
    //    ranking articles that would be discarded at the write step.
    const alreadySent = await fetchRecentUrls(dataSourceId, DEDUPE_WINDOW_DAYS);
    const unseen = candidates.filter((item) => !alreadySent.has(item.url));
    logger.log("filtered against notion history", {
      before: candidates.length,
      alreadySent: candidates.length - unseen.length,
      remaining: unseen.length,
    });

    if (unseen.length === 0) {
      logger.warn("every candidate has already been published — nothing to do");
      return { created: 0, skipped: 0, failed: 0, curated: 0 };
    }

    // 3. Curate. The expensive step, isolated so step 4 can retry without it.
    const curated = await curateDigest.triggerAndWait({ candidates: unseen });
    if (!curated.ok) {
      logger.error("curation failed", { error: curated.error });
      throw new Error("Curation step failed — see the curate-digest run for details");
    }

    const { items, usage } = curated.output;
    logger.log("curated", {
      items: items.length,
      estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(4)),
    });

    if (items.length === 0) {
      logger.warn("curation returned no qualifying items");
      return { created: 0, skipped: 0, failed: 0, curated: 0 };
    }

    // 4. Publish. Deliberately not re-thrown on failure: throwing here would
    //    retry the whole scheduled run and pay for curation a second time.
    //    The publish task has already exhausted its own retries by this point.
    const published = await publishToNotion.triggerAndWait({ items });
    if (!published.ok) {
      logger.error("publish failed after its own retries — not re-running curation", {
        error: published.error,
      });
      return { created: 0, skipped: 0, failed: items.length, curated: items.length };
    }

    logger.log("daily digest complete", {
      ...published.output,
      curated: items.length,
      estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(4)),
    });

    return { ...published.output, curated: items.length };
  },
});
