import type { NormalizedMessage } from "../types";
import { colorForName, isValidHexColor, parseTimestamp, randomId } from "../util";

/* ───────────────────────────────────────────────────────────────────────────
   Parse a Periscope/X chat WebSocket frame into the normalized schema.

   Wire shape (verified against jferas/ScopeSpeaker, a live reader):

     envelope = { kind, payload, signature }              // payload is a JSON STRING
       kind === 1  -> chat message     (handled here)
       kind === 2  -> join/leave       (ignored)
       other       -> hearts / control (ignored)

     payload  = JSON.parse(envelope.payload) = {
       sender: "<json string>",   // -> { username, display_name, ... }
       body:   "<json string>",   // -> { body: "<the message text>", ... }
       ...
     }

   So the text is double-stringified (payload.body -> .body) and the sender is a
   stringified JSON object. Text/author are sanitized (control chars stripped,
   whitespace collapsed, length-capped) before they ever reach the overlay; the
   overlay itself renders via textContent, so this is defense-in-depth.
   ─────────────────────────────────────────────────────────────────────────── */

export type RawXMessage = Record<string, unknown>;

/** Field names inside the (decoded) payload. TODO(recon): confirm id/color/ts keys. */
const PAYLOAD_SENDER = "sender";
const PAYLOAD_BODY = "body";
const BODY_TEXT = "body";
const SENDER_DISPLAY = "display_name";
const SENDER_USERNAME = "username";
const SENDER_COLOR = "color"; // TODO(recon): X sender color key, if any
const PAYLOAD_ID = "uuid"; // TODO(recon): confirm stable message id key
const PAYLOAD_TS = "timestamp"; // TODO(recon): confirm units (ms?)

const MAX_TEXT = 500;
const MAX_AUTHOR = 80;

/**
 * Strip control chars (C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F), collapse
 * whitespace, trim, then length-cap. Implemented as a codepoint filter so the
 * source contains no literal control bytes.
 */
export function sanitizeText(input: string, max: number): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max) : out;
}

function jsonParse(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/**
 * Convert a Periscope/X chat envelope into the normalized schema. Returns null
 * for non-chat frames (kind !== 1), malformed frames, and empty messages — the
 * caller just ignores nulls, so hearts/joins/DMs never crash the ingester.
 */
export function normalizeXMessage(envelope: RawXMessage, channel: string): NormalizedMessage | null {
  if (!envelope || typeof envelope !== "object") return null;
  if (Number(envelope["kind"]) !== 1) return null; // only chat messages

  const payload = jsonParse(envelope["payload"]);
  if (!payload) return null;

  const body = jsonParse(payload[PAYLOAD_BODY]);
  const rawText = body ? asString(body[BODY_TEXT]) : undefined;
  if (rawText == null) return null; // not a chat message
  const text = sanitizeText(rawText, MAX_TEXT);
  if (!text) return null;

  const sender = jsonParse(payload[PAYLOAD_SENDER]) ?? {};
  const rawAuthor = asString(sender[SENDER_DISPLAY]) || asString(sender[SENDER_USERNAME]) || "anonymous";
  const author = sanitizeText(rawAuthor, MAX_AUTHOR) || "anonymous";

  const colorRaw = asString(sender[SENDER_COLOR]);
  const color = isValidHexColor(colorRaw) ? colorRaw! : colorForName(author);

  const tsValue = payload[PAYLOAD_TS] ?? envelope[PAYLOAD_TS];
  const timestamp = typeof tsValue === "number" ? tsValue : parseTimestamp(asString(tsValue));

  return {
    id: asString(payload[PAYLOAD_ID]) ?? randomId(),
    platform: "x",
    channel,
    author,
    color,
    badges: [], // TODO(recon): map any X role/badge fields if present
    text,
    emotes: [], // X broadcasts have no custom emotes
    timestamp,
  };
}
