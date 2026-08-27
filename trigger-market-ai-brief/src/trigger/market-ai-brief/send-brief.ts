import { AbortTaskRunError, logger, task } from "@trigger.dev/sdk";
import { sendBriefEmail } from "./email.js";
import type { BriefOutput, MarketSnapshot, SendOutput } from "./types.js";

/**
 * Delivers the brief.
 *
 * Split from summarize-brief so a transient Resend failure retries on its own
 * budget without re-running the Claude call. This mirrors how publish-to-notion
 * is split from curate-digest in the news pipeline.
 */
export const sendBrief = task({
  id: "send-brief",
  retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 20_000, factor: 2 },
  maxDuration: 300,
  run: async (payload: {
    brief: BriefOutput;
    snapshot: MarketSnapshot;
    generatedAt: string;
  }): Promise<SendOutput> => {
    try {
      return await sendBriefEmail(payload.brief, payload.snapshot, payload.generatedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A rejected key or a sender/recipient the account is not allowed to use
      // will fail identically on every retry. Stop instead of burning attempts.
      if (
        message.includes("Resend returned 401") ||
        message.includes("Resend returned 403") ||
        message.includes("Resend returned 422")
      ) {
        throw new AbortTaskRunError(
          `${message}\n\nCheck RESEND_API_KEY, BRIEF_FROM_EMAIL and BRIEF_RECIPIENT_EMAIL. ` +
            `The shared sender onboarding@resend.dev can only deliver to the address you ` +
            `signed up to Resend with — any other recipient needs a verified domain.`,
        );
      }

      logger.warn("send failed, will retry", { reason: message.slice(0, 300) });
      throw error;
    }
  },
});
