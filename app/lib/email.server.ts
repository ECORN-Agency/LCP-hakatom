// Thin wrapper around Resend. Gracefully no-ops + logs if RESEND_API_KEY is
// missing so devs can wire up alerts without having a real provider yet.
//
// Required env to actually deliver mail:
//   RESEND_API_KEY     — get from https://resend.com (free tier 100/day)
//   ALERT_FROM_EMAIL   — verified sender, e.g. "alerts@your-domain.com"
//                        (during dev you can use "onboarding@resend.dev")

import { logger } from "../logger.server";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type EmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL ?? "onboarding@resend.dev";

  if (!apiKey) {
    logger.warn(
      { to: msg.to, subject: msg.subject },
      "RESEND_API_KEY not set — would have sent email, skipping",
    );
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  // Resend free tier allows 5 requests/sec. When the cron drains a backlog,
  // we can easily blow past that on the first burst — retry on 429 with a
  // bounded number of attempts.
  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 600; // covers Resend's 5/sec on first retry

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "0", 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn({ attempt, delayMs: delay }, "resend 429, backing off");
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const errorBody = await res.text();
        return { ok: false, error: `429 after ${MAX_ATTEMPTS} attempts: ${errorBody.slice(0, 200)}` };
      }

      if (!res.ok) {
        const errorBody = await res.text();
        logger.error({ status: res.status, body: errorBody }, "resend api returned non-2xx");
        return { ok: false, error: `${res.status}: ${errorBody.slice(0, 200)}` };
      }

      const data = (await res.json()) as { id?: string };
      return { ok: true, id: data.id ?? "" };
    } catch (err) {
      logger.error({ err, attempt }, "resend api call threw");
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** (attempt - 1)));
        continue;
      }
      return { ok: false, error: String(err) };
    }
  }

  return { ok: false, error: "exhausted retries" };
}
