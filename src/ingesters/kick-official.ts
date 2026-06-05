import * as crypto from "crypto";
import { parseKickContent } from "./kick-normalize";
import type { NormalizedMessage } from "../types";
import { colorForName, isValidHexColor, randomId } from "../util";

/* ───────────────────────────────────────────────────────────────────────────
   OFFICIAL Kick adapter — GROUNDWORK ONLY, FEATURE-FLAGGED OFF BY DEFAULT.

   This is a SEPARATE path from the working WS/Pusher Kick ingester (which stays
   the default). The official Kick API is push-based: you register an app
   (OAuth 2.1 + PKCE), subscribe to `chat.message.sent`, and Kick POSTs each event
   to a public webhook URL with an RSA signature you verify.

   What's real here: the webhook **signature verification** (security-critical) and
   the event → NormalizedMessage mapping. What's TODO (a human must supply): the
   OAuth/subscription endpoints + credentials, the public webhook URL, Kick's
   event public key, and confirmation of the exact payload/header field names.

   Nothing in this file runs unless KICK_OFFICIAL_ENABLED=true. See OVERNIGHT_LOG.md
   ("Enabling the official Kick adapter") and RECON.md for the exact steps.
   ─────────────────────────────────────────────────────────────────────────── */

export interface KickOfficialConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  /** Local path Kick POSTs events to (e.g. "/webhooks/kick"). */
  webhookPath: string;
  /** The public https URL that maps to webhookPath (registered with Kick). */
  webhookPublicUrl?: string;
  /** Kick's event-signing RSA public key (PEM). Supplied via KICK_EVENT_PUBLIC_KEY. */
  eventPublicKeyPem?: string;
}

// TODO(kick-official): confirm these against the current Kick developer docs.
const TODO_KICK_OAUTH_TOKEN_URL = "https://id.kick.com/oauth/token";
const TODO_KICK_EVENTS_SUBSCRIBE_URL = "https://api.kick.com/public/v1/events/subscriptions";
const TODO_CHAT_EVENT_TYPE = "chat.message.sent";

// Header names Kick attaches to each delivery (TODO: verify exact casing/keys).
const HDR_SIGNATURE = "kick-event-signature";
const HDR_MESSAGE_ID = "kick-event-message-id";
const HDR_TIMESTAMP = "kick-event-message-timestamp";
const HDR_EVENT_TYPE = "kick-event-type";

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * Verify the RSA-SHA256 signature Kick attaches to a webhook delivery.
 *
 * TODO(kick-official): confirm the exact signed-content concatenation from Kick's
 * docs. The widely-used convention (and what this implements) is
 * `${messageId}.${timestamp}.${rawBody}`.
 */
export function verifyKickSignature(opts: {
  publicKeyPem: string;
  messageId: string;
  timestamp: string;
  rawBody: string;
  signatureB64: string;
}): boolean {
  if (!opts.publicKeyPem || !opts.signatureB64) return false;
  const signedContent = `${opts.messageId}.${opts.timestamp}.${opts.rawBody}`;
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(signedContent, "utf8"),
      opts.publicKeyPem,
      Buffer.from(opts.signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Map an official `chat.message.sent` payload to a NormalizedMessage.
 * TODO(kick-official): confirm field names from a real webhook payload.
 */
export function normalizeOfficialKickEvent(
  event: any,
  fallbackChannel = "",
): { channel: string; msg: NormalizedMessage } | null {
  if (!event || typeof event !== "object") return null;
  const broadcaster = event.broadcaster ?? {};
  const channel = String(
    broadcaster.channel_slug ?? broadcaster.slug ?? broadcaster.username ?? fallbackChannel ?? "",
  ).toLowerCase();
  if (!channel) return null;

  const sender = event.sender ?? {};
  const identity = sender.identity ?? {};
  const author = String(sender.username ?? "anonymous").trim() || "anonymous";
  const colorRaw = identity.username_color ?? identity.color;
  const color = isValidHexColor(colorRaw) ? colorRaw : colorForName(author);
  const badges = Array.isArray(identity.badges)
    ? identity.badges.map((b: any) => String(b?.type ?? b?.text ?? "").trim()).filter(Boolean)
    : [];
  const { text, emotes } = parseKickContent(String(event.content ?? ""));
  const timestamp = event.created_at ? Date.parse(event.created_at) || Date.now() : Date.now();

  return {
    channel,
    msg: {
      id: String(event.message_id ?? event.id ?? randomId()),
      platform: "kick",
      channel,
      author,
      color,
      badges,
      text,
      emotes,
      timestamp,
    },
  };
}

export interface WebhookResult {
  status: number;
  channel?: string;
  msg?: NormalizedMessage;
}

/**
 * Process one webhook delivery: verify signature, ignore non-chat events, and
 * parse `chat.message.sent` into a routable message. Pure (no I/O) so it's fully
 * testable; the server mounts it only when the feature flag is on.
 */
export function handleKickWebhook(
  cfg: KickOfficialConfig,
  headers: Headers,
  rawBody: string,
): WebhookResult {
  if (!cfg.eventPublicKeyPem) return { status: 503 }; // not configured
  const ok = verifyKickSignature({
    publicKeyPem: cfg.eventPublicKeyPem,
    messageId: header(headers, HDR_MESSAGE_ID),
    timestamp: header(headers, HDR_TIMESTAMP),
    rawBody,
    signatureB64: header(headers, HDR_SIGNATURE),
  });
  if (!ok) return { status: 403 };

  const type = header(headers, HDR_EVENT_TYPE);
  if (type && type !== TODO_CHAT_EVENT_TYPE) return { status: 200 }; // acked, ignored

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400 };
  }
  const parsed = normalizeOfficialKickEvent(event);
  if (!parsed) return { status: 200 };
  return { status: 200, channel: parsed.channel, msg: parsed.msg };
}

// ── OAuth 2.1 + event subscription — structured stubs (not implemented) ───────
// These are intentionally inert; fill in the TODO endpoints/credentials to enable.

export async function exchangeCodeForToken(
  _cfg: KickOfficialConfig,
  _code: string,
  _codeVerifier: string,
  _redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  // TODO(kick-official): POST to TODO_KICK_OAUTH_TOKEN_URL with PKCE
  // (grant_type=authorization_code, code, code_verifier, client_id, redirect_uri).
  void TODO_KICK_OAUTH_TOKEN_URL;
  throw new Error("official Kick OAuth not implemented — supply credentials + verify endpoints (see RECON.md)");
}

export async function subscribeToChatEvents(
  _accessToken: string,
  _broadcasterUserId: string,
  _webhookUrl: string,
): Promise<void> {
  // TODO(kick-official): POST to TODO_KICK_EVENTS_SUBSCRIBE_URL to subscribe to
  // chat.message.sent for the broadcaster, pointing at the public webhook URL.
  void TODO_KICK_EVENTS_SUBSCRIBE_URL;
  throw new Error("official Kick event subscription not implemented (see RECON.md)");
}
