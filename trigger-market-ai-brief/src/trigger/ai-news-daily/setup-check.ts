import { logger, task } from "@trigger.dev/sdk";
import { collectCandidates } from "./feeds.js";
import { fetchRecentUrls, lookupDataSourceId } from "./notion.js";

/**
 * One-off setup and health check. Run this before the real digest.
 *
 * It does three things, in order, and stops at the first failure:
 *   1. Resolves the data source id for NOTION_DATABASE_ID — copy the value it
 *      logs into NOTION_DATA_SOURCE_ID.
 *   2. Confirms the integration can actually read the database.
 *   3. Confirms the feeds are reachable and returning enough articles.
 *
 * It never writes anything and never calls Claude, so it is free to re-run.
 */
export const setupCheck = task({
  id: "setup-check",
  retry: { maxAttempts: 1 },
  maxDuration: 300,
  run: async () => {
    const databaseId = process.env.NOTION_DATABASE_ID;
    if (!databaseId) throw new Error("NOTION_DATABASE_ID is not set");
    if (!process.env.NOTION_API_KEY) throw new Error("NOTION_API_KEY is not set");

    // 1. Resolve the data source.
    const dataSources = await lookupDataSourceId(databaseId);
    if (dataSources.length === 0) {
      throw new Error(
        "Database has no data sources. Check that NOTION_DATABASE_ID points at a database, not a page.",
      );
    }

    logger.log("=== COPY THIS INTO YOUR .env ===", {
      NOTION_DATA_SOURCE_ID: dataSources[0]!.id,
      databaseName: dataSources[0]!.name,
      totalDataSources: dataSources.length,
    });

    // 2. Confirm we can query it. This is where a database that was never
    //    shared with the integration fails.
    const existing = await fetchRecentUrls(dataSources[0]!.id, 14);

    // 3. Confirm the feeds are healthy.
    const { candidates, sourcesOk, sourcesTotal } = await collectCandidates(7);
    const bySource = new Map<string, number>();
    for (const item of candidates) {
      bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
    }

    const dayAgo = Date.now() - 26 * 60 * 60 * 1000;
    const fromToday = candidates.filter((item) => Date.parse(item.publishedAt) >= dayAgo).length;

    logger.log("feed health", {
      sourcesOk,
      sourcesTotal,
      candidatesLast7Days: candidates.length,
      candidatesLast26Hours: fromToday,
      perSource: Object.fromEntries([...bySource.entries()].sort((a, b) => b[1] - a[1])),
    });

    return {
      dataSourceId: dataSources[0]!.id,
      notionReadable: true,
      existingUrls: existing.size,
      sourcesOk,
      sourcesTotal,
      candidates: candidates.length,
      candidatesLast26Hours: fromToday,
    };
  },
});
