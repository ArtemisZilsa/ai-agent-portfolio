import { logger, task } from "@trigger.dev/sdk";
import { fetchRecentUrls, publishItems, requireDataSourceId } from "./notion.js";
import type { CuratedItem, PublishOutput } from "./types.js";

/**
 * Writes the curated items to Notion.
 *
 * Split out from curation so that a Notion failure retries on its own budget
 * without re-running the Claude call — a retry here costs nothing.
 */
export const publishToNotion = task({
  id: "publish-to-notion",
  retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 20_000, factor: 2 },
  maxDuration: 300,
  run: async (payload: { items: CuratedItem[] }): Promise<PublishOutput> => {
    const dataSourceId = requireDataSourceId();

    if (payload.items.length === 0) {
      logger.warn("nothing to publish");
      return { created: 0, skipped: 0, failed: 0 };
    }

    // Re-check immediately before writing. On a retry, some rows from the
    // previous attempt may already exist — this is what keeps the retry from
    // creating duplicates.
    const existing = await fetchRecentUrls(dataSourceId, 14);
    const fresh = payload.items.filter((item) => !existing.has(item.url));
    const skipped = payload.items.length - fresh.length;

    if (skipped > 0) {
      logger.log("skipping items already in notion", { skipped });
    }

    const { created, failed } = await publishItems(dataSourceId, fresh);

    logger.log("publish complete", { created, skipped, failed });

    // A partial failure should surface as a retry; a clean run should not.
    if (failed > 0 && created === 0) {
      throw new Error(`All ${failed} Notion writes failed`);
    }

    return { created, skipped, failed };
  },
});
