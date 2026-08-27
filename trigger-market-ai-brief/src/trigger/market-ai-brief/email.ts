import { logger } from "@trigger.dev/sdk";
import type { BriefOutput, MarketSnapshot, Quote, SendOutput } from "./types.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FETCH_TIMEOUT_MS = 20_000;

/** Inline styles only — email clients strip <style> blocks and ignore classes. */
const COLORS = {
  up: "#0f7b3d",
  down: "#c0392b",
  flat: "#5f6b7a",
  text: "#1a1f26",
  muted: "#6b7684",
  rule: "#e3e8ee",
  bg: "#f5f7fa",
  card: "#ffffff",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(quote: Quote): string {
  if (quote.unit === "percent") return `${quote.price.toFixed(3)}%`;
  return quote.price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatChange(quote: Quote): { text: string; color: string } {
  if (quote.stale) return { text: "closed", color: COLORS.flat };
  if (quote.changePct === null) return { text: "—", color: COLORS.flat };
  const sign = quote.changePct >= 0 ? "+" : "";
  return {
    text: `${sign}${quote.changePct.toFixed(2)}%`,
    color: quote.changePct > 0 ? COLORS.up : quote.changePct < 0 ? COLORS.down : COLORS.flat,
  };
}

/** One titled table of quotes. Returns "" when the group has nothing in it. */
function quoteTable(title: string, quotes: Quote[]): string {
  if (quotes.length === 0) return "";

  const rows = quotes
    .map((quote) => {
      const change = formatChange(quote);
      return `<tr>
  <td style="padding:7px 0;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.text};">${escapeHtml(quote.label)}</td>
  <td style="padding:7px 0;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.text};text-align:right;font-variant-numeric:tabular-nums;">${formatPrice(quote)}</td>
  <td style="padding:7px 0 7px 14px;border-bottom:1px solid ${COLORS.rule};font-size:14px;font-weight:600;color:${change.color};text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${change.text}</td>
</tr>`;
    })
    .join("\n");

  return `<p style="margin:24px 0 6px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COLORS.muted};">${escapeHtml(title)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>`;
}

export function buildHtml(brief: BriefOutput, snapshot: MarketSnapshot, generatedAt: string): string {
  const indices = snapshot.quotes.filter((q) => q.group === "index");
  const commodities = snapshot.quotes.filter(
    (q) => q.group === "commodity" || q.group === "rate",
  );
  const aiEquities = snapshot.quotes.filter((q) => q.group === "ai-equity");

  const cryptoRows = snapshot.crypto
    .map((c) => {
      const color =
        c.changePct === null
          ? COLORS.flat
          : c.changePct > 0
            ? COLORS.up
            : c.changePct < 0
              ? COLORS.down
              : COLORS.flat;
      const change =
        c.changePct === null ? "—" : `${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(2)}%`;
      return `<tr>
  <td style="padding:7px 0;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.text};">${escapeHtml(c.label)}</td>
  <td style="padding:7px 0;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.text};text-align:right;font-variant-numeric:tabular-nums;">$${c.price.toLocaleString("en-US")}</td>
  <td style="padding:7px 0 7px 14px;border-bottom:1px solid ${COLORS.rule};font-size:14px;font-weight:600;color:${color};text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${change}</td>
</tr>`;
    })
    .join("\n");

  const cryptoBlock =
    snapshot.crypto.length === 0
      ? ""
      : `<p style="margin:24px 0 6px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COLORS.muted};">Crypto${
          snapshot.cryptoMarketCapUsd
            ? ` &middot; total cap $${(snapshot.cryptoMarketCapUsd / 1e12).toFixed(2)}T`
            : ""
        }</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${cryptoRows}</table>`;

  const fxBlock =
    snapshot.fx.length === 0
      ? ""
      : `<p style="margin:24px 0 6px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COLORS.muted};">FX &middot; ECB daily fix${
          snapshot.fxAsOf ? ` (${escapeHtml(snapshot.fxAsOf)})` : ""
        }</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${snapshot.fx
          .map(
            (f) => `<tr>
  <td style="padding:7px 0;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.text};">${escapeHtml(f.pair)}</td>
  <td style="padding:7px 0;border-bottom:1px solid ${COLORS.rule};font-size:14px;color:${COLORS.text};text-align:right;font-variant-numeric:tabular-nums;">${f.rate}</td>
</tr>`,
          )
          .join("\n")}</table>`;

  const bulletsBlock =
    brief.bullets.length === 0
      ? `<p style="margin:0;font-size:14px;line-height:1.6;color:${COLORS.muted};">No significant AI stories published in this window.</p>`
      : brief.bullets
          .map(
            (b) => `<div style="margin:0 0 16px;">
  <a href="${escapeHtml(b.url)}" style="font-size:15px;font-weight:600;color:#1155cc;text-decoration:none;line-height:1.45;">${escapeHtml(b.title)}</a>
  <div style="margin-top:3px;font-size:13px;line-height:1.55;color:${COLORS.muted};">${escapeHtml(b.source)}${b.note ? ` &middot; ${escapeHtml(b.note)}` : ""}</div>
</div>`,
          )
          .join("\n");

  const unavailableBlock =
    snapshot.unavailable.length === 0
      ? ""
      : `<p style="margin:20px 0 0;font-size:12px;line-height:1.55;color:${COLORS.muted};">Unavailable this run: ${escapeHtml(snapshot.unavailable.join(", "))}.</p>`;

  return `<div style="margin:0;padding:24px 12px;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:${COLORS.card};border-radius:10px;">
<tr><td style="padding:30px 30px 34px;">

  <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COLORS.muted};">Market &amp; AI Brief</p>
  <p style="margin:0 0 22px;font-size:12px;color:${COLORS.muted};">${escapeHtml(generatedAt)}</p>

  <h1 style="margin:0 0 20px;font-size:21px;line-height:1.35;font-weight:700;color:${COLORS.text};">${escapeHtml(brief.headline)}</h1>

  <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${COLORS.text};">${escapeHtml(brief.marketsParagraph)}</p>
  ${brief.aiParagraph ? `<p style="margin:0;font-size:15px;line-height:1.65;color:${COLORS.text};">${escapeHtml(brief.aiParagraph)}</p>` : ""}

  ${quoteTable("Global indices", indices)}
  ${quoteTable("AI sector", aiEquities)}
  ${quoteTable("Commodities & rates", commodities)}
  ${cryptoBlock}
  ${fxBlock}

  <p style="margin:32px 0 12px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COLORS.muted};">AI headlines</p>
  ${bulletsBlock}

  ${unavailableBlock}

  <p style="margin:26px 0 0;padding-top:16px;border-top:1px solid ${COLORS.rule};font-size:11px;line-height:1.6;color:${COLORS.muted};">
    Generated automatically every 6 hours. Prices from Yahoo Finance, CoinGecko and the ECB, and may be delayed. Not investment advice.
  </p>

</td></tr>
</table>
</div>`;
}

/** Plain-text fallback, for clients that refuse HTML. */
export function buildText(brief: BriefOutput, snapshot: MarketSnapshot, generatedAt: string): string {
  const lines: string[] = [
    `MARKET & AI BRIEF — ${generatedAt}`,
    "",
    brief.headline,
    "",
    brief.marketsParagraph,
  ];

  if (brief.aiParagraph) lines.push("", brief.aiParagraph);

  const groups: Array<[string, Quote["group"]]> = [
    ["GLOBAL INDICES", "index"],
    ["AI SECTOR", "ai-equity"],
    ["COMMODITIES", "commodity"],
    ["RATES", "rate"],
  ];

  for (const [title, group] of groups) {
    const rows = snapshot.quotes.filter((q) => q.group === group);
    if (rows.length === 0) continue;
    lines.push("", title);
    for (const q of rows) {
      lines.push(`  ${q.label}: ${formatPrice(q)} (${formatChange(q).text})`);
    }
  }

  if (snapshot.crypto.length > 0) {
    lines.push("", "CRYPTO");
    for (const c of snapshot.crypto) {
      const change =
        c.changePct === null ? "—" : `${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(2)}%`;
      lines.push(`  ${c.label}: $${c.price.toLocaleString("en-US")} (${change})`);
    }
  }

  if (snapshot.fx.length > 0) {
    lines.push("", `FX (ECB daily fix${snapshot.fxAsOf ? `, ${snapshot.fxAsOf}` : ""})`);
    for (const f of snapshot.fx) lines.push(`  ${f.pair}: ${f.rate}`);
  }

  lines.push("", "AI HEADLINES");
  if (brief.bullets.length === 0) {
    lines.push("  No significant AI stories published in this window.");
  } else {
    for (const b of brief.bullets) {
      lines.push(`  - ${b.title} (${b.source})`, `    ${b.url}`);
    }
  }

  if (snapshot.unavailable.length > 0) {
    lines.push("", `Unavailable this run: ${snapshot.unavailable.join(", ")}.`);
  }

  lines.push(
    "",
    "Generated automatically every 6 hours. Prices may be delayed. Not investment advice.",
  );

  return lines.join("\n");
}

/**
 * Send the brief through Resend.
 *
 * Throws on failure so the calling task's retry budget applies — a retry here
 * costs nothing, because the Claude call has already happened.
 */
export async function sendBriefEmail(
  brief: BriefOutput,
  snapshot: MarketSnapshot,
  generatedAt: string,
): Promise<SendOutput> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");

  const to = process.env.BRIEF_RECIPIENT_EMAIL;
  if (!to) throw new Error("BRIEF_RECIPIENT_EMAIL is not set");

  const from = process.env.BRIEF_FROM_EMAIL ?? "onboarding@resend.dev";

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `Market & AI Brief <${from}>`,
      to: [to],
      subject: brief.headline,
      html: buildHtml(brief, snapshot, generatedAt),
      text: buildText(brief, snapshot, generatedAt),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    message?: string;
  };

  if (!response.ok) {
    // Resend's own message is specific enough to diagnose most failures
    // (unverified domain, invalid key, recipient not allowed on the shared sender).
    throw new Error(
      `Resend returned ${response.status}: ${body.name ?? "error"} — ${body.message ?? "no message"}`,
    );
  }

  logger.log("brief emailed", { emailId: body.id ?? null });

  return { sent: true, emailId: body.id ?? null };
}
