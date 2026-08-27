import Anthropic from "@anthropic-ai/sdk";
import { AbortTaskRunError, logger, task } from "@trigger.dev/sdk";
import type { CandidateItem, CurateOutput, CuratedItem } from "./types.js";

const MODEL = "claude-sonnet-5";

/** Sonnet 5 list price, $ per million tokens. Used for the cost log line only. */
const INPUT_COST_PER_MTOK = 2;
const OUTPUT_COST_PER_MTOK = 10;

const TARGET_ITEMS = 20;
const CAROUSEL_ITEMS = 5;

/** Anything published inside this window is "Today" — slightly wider than the
 * 24h cron interval so stories can't slip through the gap between runs. */
const TODAY_WINDOW_HOURS = 26;

/** Cap what we send Claude. Candidates arrive newest-first, so this trims the tail. */
const MAX_CANDIDATES = 250;

const SYSTEM_PROMPT = `You are a research assistant for a solo marketer who publishes Instagram carousels about AI.

Your job each morning: read a list of recent articles and select the ${TARGET_ITEMS} most useful ones for making content.

WHAT QUALIFIES
An item qualifies if it is an AI model release, an AI feature launch, or an AI capability update that a marketer or a video/photo editor could plausibly use or talk about. That includes:
- Foundation model releases and capability updates (OpenAI, Anthropic, Google, Meta, Mistral, open weights)
- AI features shipping in creative tools (Canva, Adobe, CapCut, Figma, Runway, ElevenLabs, Midjourney, Descript)
- AI features shipping in marketing and social platforms (Meta Ads, TikTok, YouTube, LinkedIn, Google Ads, SEO tooling)
- Pricing, access, or availability changes that affect whether a small team can actually use a tool

WHAT DOES NOT QUALIFY
- Enterprise infrastructure, MLOps, chips, and datacenter news with no creative application
- Funding rounds, executive hires, lawsuits, and regulation, unless they change what a marketer can use today
- Pure research papers with no shipped product
- Opinion and speculation about what might launch later

RANKING
Rank by usefulness for making a carousel, in this order:
1. Something concrete actually shipped, and the reader could try it this week
2. It is usable without engineering work
3. It has a visual or creative angle that suits Instagram
4. There is a clear "so what" for a small team

Prefer first-party announcements (tier "vendor") over aggregator commentary when both cover the same story. Never select two items about the same underlying announcement — pick the better source.

WRITING RULES
- Write in English.
- "summary" is 1-2 plain sentences on what actually shipped.
- "whyItMatters" is one sentence addressed to a marketer, saying what they can now do. Be specific and concrete. Avoid hype words like "game-changing", "revolutionary", "unlock".
- Never state a detail that is not supported by the title and snippet you were given. If the snippet is thin, keep the summary correspondingly general. Do not invent version numbers, prices, dates, or feature specifics.

CAROUSEL SCRIPTS
Give the top ${CAROUSEL_ITEMS} items (the ${CAROUSEL_ITEMS} most useful, listed first) a full "carousel" script:
- "hook": one scroll-stopping opening line, under 12 words
- "slides": exactly 6 strings, one per slide, each a short punchy line under 20 words that builds the story
- "caption": 2-3 sentences for the post caption, ending with a question or call to action
- "hashtags": 8 relevant hashtags, no leading "#"
Items ranked ${CAROUSEL_ITEMS + 1} and below must omit "carousel" entirely.

Return exactly ${TARGET_ITEMS} items, best first. If fewer than ${TARGET_ITEMS} genuinely qualify, return only those that do — never pad the list with items that fail the criteria.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "url",
          "title",
          "freshness",
          "category",
          "useCases",
          "summary",
          "whyItMatters",
        ],
        properties: {
          url: { type: "string", description: "Must be copied exactly from the candidate list" },
          title: { type: "string" },
          freshness: { type: "string", enum: ["Today", "This Week"] },
          category: {
            type: "string",
            enum: ["Model Release", "Creative Tool", "Marketing Platform", "Research"],
          },
          useCases: {
            type: "array",
            items: { type: "string", enum: ["Marketing", "Editing"] },
            minItems: 1,
          },
          summary: { type: "string" },
          whyItMatters: { type: "string" },
          carousel: {
            type: "object",
            additionalProperties: false,
            required: ["hook", "slides", "caption", "hashtags"],
            properties: {
              hook: { type: "string" },
              slides: { type: "array", items: { type: "string" } },
              caption: { type: "string" },
              hashtags: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

type ModelItem = Omit<CuratedItem, "source" | "publishedAt">;

export const curateDigest = task({
  id: "curate-digest",
  // The expensive step. Two attempts, so a transient 500 recovers but a
  // persistent failure does not quietly bill four times over.
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 600,
  run: async (payload: { candidates: CandidateItem[] }): Promise<CurateOutput> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const candidates = payload.candidates.slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) {
      throw new AbortTaskRunError("No candidates to curate — the fetch step returned nothing");
    }

    // Index by URL so we can restore trusted metadata afterwards rather than
    // trusting the model to echo dates and source names back correctly.
    const byUrl = new Map(candidates.map((item) => [item.url, item]));
    const todayCutoff = Date.now() - TODAY_WINDOW_HOURS * 60 * 60 * 1000;

    const candidateList = candidates.map((item) => ({
      url: item.url,
      title: item.title,
      source: item.source,
      tier: item.tier,
      publishedAt: item.publishedAt,
      isFromToday: Date.parse(item.publishedAt) >= todayCutoff,
      snippet: item.snippet,
    }));

    const client = new Anthropic({ apiKey });

    let message;
    try {
      // Streaming: 20 digests plus 5 full scripts is a long generation, and a
      // non-streaming request at this max_tokens risks an HTTP timeout.
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 32_000,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [
          {
            role: "user",
            content:
              `Here are ${candidateList.length} candidate articles from the last few days.\n\n` +
              `Select the ${TARGET_ITEMS} most useful, best first, and write the top ${CAROUSEL_ITEMS} as full carousel scripts.\n\n` +
              `Set "freshness" to "Today" when the candidate has isFromToday true, otherwise "This Week".\n` +
              `Copy each "url" exactly as given.\n\n` +
              JSON.stringify(candidateList),
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
      throw new AbortTaskRunError("Claude declined to process this batch of headlines");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("Claude hit max_tokens before finishing — output truncated, retrying");
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed: { items?: ModelItem[] };
    try {
      parsed = JSON.parse(text) as { items?: ModelItem[] };
    } catch {
      throw new Error(`Claude returned unparseable JSON (${text.length} chars)`);
    }

    // Rebuild each item from our own trusted record of the article, keeping
    // only the judgement and the copy from the model. A hallucinated URL has
    // no matching candidate and is dropped here.
    const items: CuratedItem[] = [];
    const seen = new Set<string>();

    for (const modelItem of parsed.items ?? []) {
      const candidate = byUrl.get(modelItem.url);
      if (!candidate) {
        logger.warn("dropping curated item with unrecognised url", { url: modelItem.url });
        continue;
      }
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);

      items.push({
        title: modelItem.title || candidate.title,
        url: candidate.url,
        source: candidate.source,
        publishedAt: candidate.publishedAt,
        // Derived from the real timestamp, not from the model's claim.
        freshness: Date.parse(candidate.publishedAt) >= todayCutoff ? "Today" : "This Week",
        category: modelItem.category,
        useCases: modelItem.useCases?.length ? modelItem.useCases : ["Marketing"],
        summary: modelItem.summary,
        whyItMatters: modelItem.whyItMatters,
        carousel: modelItem.carousel,
      });
    }

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const estimatedCostUsd =
      (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
      (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;

    logger.log("curation complete", {
      candidatesConsidered: candidates.length,
      itemsSelected: items.length,
      withCarousel: items.filter((item) => item.carousel).length,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    });

    return {
      items: items.slice(0, TARGET_ITEMS),
      usage: { inputTokens, outputTokens, estimatedCostUsd },
    };
  },
});
