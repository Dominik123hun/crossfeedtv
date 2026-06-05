import type { AppConfig } from "./config";
import { logger } from "./logger";

const log = logger.child("email");

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  /** Short identifier for logs (e.g. "resend", "log"). */
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}

/**
 * Pick an email transport from config:
 *  - "resend": POST to the Resend HTTP API (no SDK dependency; uses global fetch).
 *  - "log":    print the message (incl. any link) to the server log. Used when no
 *              provider is configured so verification / reset still work in dev
 *              and self-hosting without external setup.
 */
export function createEmailSender(cfg: AppConfig): EmailSender {
  if (cfg.email.provider === "resend" && cfg.email.resendApiKey) {
    return resendSender(cfg.email.resendApiKey, cfg.email.from);
  }
  return logSender();
}

function resendSender(apiKey: string, from: string): EmailSender {
  return {
    name: "resend",
    async send(msg) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`resend responded ${res.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}

function logSender(): EmailSender {
  return {
    name: "log",
    async send(msg) {
      log.info(`(no email provider configured) would send to ${msg.to} — ${msg.subject}\n${msg.text}`);
    },
  };
}
