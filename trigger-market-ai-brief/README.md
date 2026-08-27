# Trigger.dev Automations

Two scheduled TypeScript automations running on [Trigger.dev](https://trigger.dev).

## 1. Market + AI Brief — `src/trigger/market-ai-brief/`

Every 6 hours, collects live global market data and recent AI headlines, has Claude write a
short analyst-style brief, and emails it.

**Data sources** — all keyless except delivery:

| Source | Provides |
|---|---|
| Yahoo Finance (`v8/finance/chart`) | 8 global indices, gold, WTI/Brent, US 10Y yield, 8 AI-sector equities |
| CoinGecko | BTC / ETH / SOL, total crypto market cap |
| Frankfurter (ECB) | USD against JPY, EUR, GBP, CNY |
| Resend | Email delivery |

**Pipeline**

```
brief.ts (schedules.task, cron "0 */6 * * *")
  ├─ market.ts        collect quotes, crypto, FX in parallel
  ├─ feeds.ts         reuse the news pipeline's RSS + Hacker News collector
  ├─ summarize.ts ──► one Claude call, JSON-schema constrained
  └─ send-brief.ts ─► render HTML + text, POST to Resend
```

**Design notes**

- **Summarization and delivery are separate tasks.** A failed send retries on its own budget
  without re-running — and re-paying for — the Claude call.
- **Headline dedupe uses `payload.lastTimestamp`.** Each run only sees stories published
  since the previous run, so consecutive briefs never repeat an item. Clamped to 24h so a
  long outage can't drag in a week of stale news.
- **Partial failure is survivable.** Any source that fails is named in the email rather than
  silently omitted, so missing data is never mistaken for a flat market. Only a total outage
  throws.
- **Closed markets are detected**, not narrated. A quote whose `regularMarketTime` is stale
  is labelled "closed" instead of being reported as a session that ended flat.
- **The model never sees a URL it can invent.** Every bullet is rebuilt from our own record
  of the article; anything with an unrecognised URL is dropped.
- **Display labels are ours.** Yahoo's `shortName` returns padded, truncated junk
  (`"DAX                           P"`), so it is never rendered.

## 2. Daily AI News Digest — `src/trigger/ai-news-daily/`

Once a day, pulls ~22 RSS/Atom feeds plus targeted Hacker News queries, screens general tech
feeds for an actual AI angle, has Claude rank the top items and write Instagram carousel
scripts for the best few, then writes them to a Notion database.

Deduplicates against the last 14 days of Notion rows *before* the Claude call, so no tokens
are spent ranking articles that would be discarded at the write step.

## Running it

```bash
npm install
cp .env.example .env      # then fill in the values
npx trigger.dev@latest login
npx trigger.dev@latest dev
```

Trigger the `market-brief-setup-check` task first — it validates every env var and pings
every data source without calling Claude or sending an email, so it is free to re-run.

Before deploying, add every variable from `.env.example` to the Trigger.dev dashboard under
Environment Variables. A key that exists locally but not there is the most common production
failure.

## Stack

TypeScript, Trigger.dev v4, `@anthropic-ai/sdk`, native `fetch`, `fast-xml-parser`.
No Python, no shell scripts, no plain Node entrypoints — everything runs as a Trigger.dev task.
