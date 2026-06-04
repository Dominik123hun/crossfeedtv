import type { NormalizedMessage } from "../types";
import { colorForName, isValidHexColor, parseTimestamp, randomId } from "../util";

/* ─────────────────────────────────────────────────────────────────────────
   ⚠️  The field names in a real X (Twitter) broadcast chat frame are UNKNOWN
   and UNDOCUMENTED (descendant of Periscope). Everything below is a labelled
   PLACEHOLDER — confirm/replace each from a captured frame per RECON.md.
   The mapping is centralized here so it's a one-place fill-in.
   ───────────────────────────────────────────────────────────────────────── */
export const TODO_X_FIELD = {
  /** chat text */
  text: "body",
  /** login/handle */
  author: "username",
  /** pretty name (preferred over `author` if present) */
  displayName: "display_name",
  /** hex color string, if any */
  color: "color",
  /** stable message id */
  id: "uuid",
  /** epoch-ms timestamp */
  timestampMs: "timestamp",
} as const;

export type RawXMessage = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/**
 * Periscope/X frames historically wrapped the real message as a JSON STRING
 * inside a `payload`/`body` field (sometimes nested twice). Unwrap one level if
 * we detect it. TODO(recon): confirm which field is double-encoded, if any.
 */
function unwrap(raw: RawXMessage): RawXMessage {
  for (const key of ["payload", "body", "data"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try {
        return { ...raw, ...(JSON.parse(value) as RawXMessage) };
      } catch {
        /* not JSON after all — leave as-is */
      }
    }
  }
  return raw;
}

/**
 * Convert an X broadcast chat frame into the normalized schema. Returns null
 * for control/heartbeat frames (no text field).
 */
export function normalizeXMessage(input: RawXMessage, channel: string): NormalizedMessage | null {
  if (!input || typeof input !== "object") return null;
  const raw = unwrap(input);
  const F = TODO_X_FIELD;

  const text = asString(raw[F.text]);
  if (text == null) return null; // not a chat message

  const author = asString(raw[F.displayName]) || asString(raw[F.author]) || "anonymous";
  const colorRaw = asString(raw[F.color]);
  const color = isValidHexColor(colorRaw) ? colorRaw! : colorForName(author);
  const tsValue = raw[F.timestampMs];
  const timestamp =
    typeof tsValue === "number" ? tsValue : parseTimestamp(asString(tsValue));

  return {
    id: asString(raw[F.id]) ?? randomId(),
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
