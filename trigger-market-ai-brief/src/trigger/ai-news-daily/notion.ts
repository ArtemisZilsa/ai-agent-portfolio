import { logger } from "@trigger.dev/sdk";
import { normalizeUrl } from "./feeds.js";
import type { CuratedItem } from "./types.js";

const NOTION_BASE = "https://api.notion.com/v1";

/**
 * Notion versions its API by date and breaks compatibility between versions.
 * 2026-03-11 is the current one; it is the version that introduced data
 * sources, so pages parent to a data_source_id rather than a database_id.
 */
const NOTION_VERSION = "2026-03-11";

/** Notion rejects any single rich_text value longer than this. */
const RICH_TEXT_LIMIT = 2000;

/** Notion allows roughly 3 requests/second. Stay comfortably under it. */
const WRITE_SPACING_MS = 350;

function requireNotionKey(): string {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY is not set");
  return key;
}

export function requireDataSourceId(): string {
  const id = process.env.NOTION_DATA_SOURCE_ID;
  if (!id) throw new Error("NOTION_DATA_SOURCE_ID is not set");
  return id;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Notion REST call, retrying once on a 429 using the server's own
 * Retry-After hint. Errors carry Notion's message, which is specific enough to
 * diagnose most failures (wrong property name, integration not shared, etc).
 */
async function notionRequest<T>(
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: unknown },
): Promise<T> {
  const send = () =>
    fetch(`${NOTION_BASE}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${requireNotionKey()}`,
        "Notion-Version": NOTION_VERSION,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });

  let response = await send();

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    const waitMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 10_000);
    logger.warn("notion rate limited, retrying", { path, waitMs });
    await sleep(waitMs);
    response = await send();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Notion ${init.method} ${path} failed: ${response.status} ${detail.slice(0, 400)}`);
  }

  return (await response.json()) as T;
}

/**
 * Resolve a database's data source id. Used by the one-off setup script — the
 * task itself reads NOTION_DATA_SOURCE_ID from the environment rather than
 * spending a request on this every run.
 */
export async function lookupDataSourceId(databaseId: string): Promise<
  { id: string; name: string }[]
> {
  const database = await notionRequest<{ data_sources?: { id: string; name: string }[] }>(
    `/databases/${databaseId}`,
    { method: "GET" },
  );
  return database.data_sources ?? [];
}

type QueryResponse = {
  results: { properties?: Record<string, { url?: string | null }> }[];
  has_more: boolean;
  next_cursor: string | null;
};

/**
 * Every article URL published to the database within `days`. This is the
 * dedupe memory — the database is its own state store, so there is no separate
 * database to run.
 *
 * Notion pages 100 rows at a time and 20 items/day over a two-week window is
 * ~280 rows, so following the cursor is required, not optional.
 */
export async function fetchRecentUrls(dataSourceId: string, days: number): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const urls = new Set<string>();

  let cursor: string | null = null;
  let pages = 0;

  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      filter: { property: "Published", date: { on_or_after: since } },
    };
    if (cursor) body.start_cursor = cursor;

    const page: QueryResponse = await notionRequest<QueryResponse>(
      `/data_sources/${dataSourceId}/query`,
      { method: "POST", body },
    );

    for (const row of page.results) {
      const url = row.properties?.URL?.url;
      if (url) urls.add(normalizeUrl(url));
    }

    cursor = page.has_more ? page.next_cursor : null;
    pages += 1;
  } while (cursor && pages < 20);

  logger.log("loaded existing urls from notion", { count: urls.size, pages, since });
  return urls;
}

function richText(content: string) {
  return [{ type: "text" as const, text: { content: content.slice(0, RICH_TEXT_LIMIT) } }];
}

function paragraph(content: string) {
  return { object: "block" as const, type: "paragraph" as const, paragraph: { rich_text: richText(content) } };
}

function heading(content: string) {
  return { object: "block" as const, type: "heading_3" as const, heading_3: { rich_text: richText(content) } };
}

function bullet(content: string) {
  return {
    object: "block" as const,
    type: "numbered_list_item" as const,
    numbered_list_item: { rich_text: richText(content) },
  };
}

/** The carousel script, rendered as page body blocks. */
function carouselBlocks(item: CuratedItem) {
  if (!item.carousel) return [];
  const { hook, slides, caption, hashtags } = item.carousel;

  return [
    heading("Hook"),
    paragraph(hook),
    heading("Slides"),
    ...slides.map(bullet),
    heading("Caption"),
    paragraph(caption),
    heading("Hashtags"),
    paragraph(hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")),
  ];
}

function buildProperties(item: CuratedItem) {
  return {
    Name: { title: richText(item.title) },
    URL: { url: item.url },
    Source: { select: { name: item.source } },
    Published: { date: { start: item.publishedAt } },
    Freshness: { select: { name: item.freshness } },
    Category: { select: { name: item.category } },
    "Use Case": { multi_select: item.useCases.map((name) => ({ name })) },
    Summary: { rich_text: richText(item.summary) },
    "Why It Matters": { rich_text: richText(item.whyItMatters) },
    "Carousel Ready": { checkbox: Boolean(item.carousel) },
    Status: { select: { name: "New" } },
  };
}

/**
 * Write the curated items to Notion, one page each, spaced out to respect the
 * rate limit. A single failed row is logged and skipped rather than aborting
 * the batch — 19 good rows beat none.
 */
export async function publishItems(
  dataSourceId: string,
  items: CuratedItem[],
): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;

  for (const [index, item] of items.entries()) {
    try {
      await notionRequest(`/pages`, {
        method: "POST",
        body: {
          parent: { type: "data_source_id", data_source_id: dataSourceId },
          properties: buildProperties(item),
          children: carouselBlocks(item),
        },
      });
      created += 1;
    } catch (error) {
      failed += 1;
      logger.error("failed to create notion page", {
        title: item.title,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (index < items.length - 1) await sleep(WRITE_SPACING_MS);
  }

  return { created, failed };
}
