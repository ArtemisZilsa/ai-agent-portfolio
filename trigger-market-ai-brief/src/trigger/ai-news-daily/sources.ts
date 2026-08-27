import type { FeedSource } from "./types.js";

/**
 * RSS/Atom feeds, all verified reachable on 2026-08-26.
 *
 * Deliberately absent: Anthropic, ElevenLabs, Runway, Adobe, Descript, Mistral
 * and Synthesia publish no public feed (404), and Microsoft AI / Search Engine
 * Land block automated fetches (403). Their launches still surface through the
 * aggregators below and through the targeted Hacker News queries in feeds.ts.
 */
export const FEEDS: FeedSource[] = [
  // First-party announcements — highest signal.
  { name: "OpenAI", url: "https://openai.com/news/rss.xml", tier: "vendor" },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/", tier: "vendor" },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", tier: "vendor" },
  { name: "NVIDIA", url: "https://blogs.nvidia.com/feed/", tier: "vendor" },
  { name: "AWS ML", url: "https://aws.amazon.com/blogs/machine-learning/feed/", tier: "vendor" },

  // Dedicated AI press.
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", tier: "ai-press" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", tier: "ai-press" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/", tier: "ai-press" },
  { name: "MarkTechPost", url: "https://www.marktechpost.com/feed/", tier: "ai-press" },
  { name: "AI News", url: "https://www.artificialintelligence-news.com/feed/", tier: "ai-press" },
  { name: "The Rundown AI", url: "https://www.therundown.ai/feed", tier: "ai-press" },

  // General tech — high volume, needs AI filtering downstream.
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", tier: "tech-press" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml", tier: "tech-press" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", tier: "tech-press" },
  { name: "9to5Google", url: "https://9to5google.com/feed/", tier: "tech-press" },

  // Marketing, editing and design trade press — the angle Rizhu actually needs.
  { name: "Search Engine Journal", url: "https://www.searchenginejournal.com/feed/", tier: "creative" },
  { name: "Social Media Today", url: "https://www.socialmediatoday.com/feeds/news/", tier: "creative" },
  { name: "Marketing Dive", url: "https://www.marketingdive.com/feeds/news/", tier: "creative" },
  { name: "PetaPixel", url: "https://petapixel.com/feed/", tier: "creative" },
  { name: "Zapier", url: "https://zapier.com/blog/feeds/latest/", tier: "creative" },
  { name: "Figma", url: "https://www.figma.com/blog/feed/atom.xml", tier: "creative" },
];

/**
 * Hacker News search terms, run against the free Algolia API.
 *
 * The named vendors are the ones with no RSS — HN is how we hear about their
 * releases. The bare "AI" sweep catches everything else.
 */
export const HN_QUERIES = [
  "AI",
  "Anthropic Claude",
  "Runway",
  "ElevenLabs",
  "Midjourney",
  "Adobe Firefly",
  "Mistral",
];

/** Ignore HN stories below this score — cuts most of the noise. */
export const HN_MIN_POINTS = 20;
