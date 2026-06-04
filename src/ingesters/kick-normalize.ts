import type { Emote, NormalizedMessage } from "../types";
import { colorForName, isValidHexColor, randomId } from "../util";

/**
 * Raw Kick chat message shape. Both the @retconned/kick-js "ChatMessage" event
 * and the Pusher "ChatMessageEvent" payload deliver this same structure, so a
 * single normalizer handles both transports. Fields are read defensively.
 */
export interface RawKickMessage {
  id?: string | number;
  content?: string;
  created_at?: string;
  sender?: {
    username?: string;
    identity?: {
      color?: string;
      badges?: Array<{ type?: string; text?: string }>;
    };
  };
}

/**
 * Kick embeds emotes inline as `[emote:<id>:<name>]`. Replace each with its
 * bare name (a whitespace-delimited token the overlay can swap for an image)
 * and collect the {code,url} pairs. Emote CDN: files.kick.com/emotes/<id>/fullsize.
 */
export function parseKickContent(content: string): { text: string; emotes: Emote[] } {
  const emotes: Emote[] = [];
  const seen = new Set<string>();
  const text = content
    .replace(/\[emote:(\d+):([^\]]+)\]/g, (_m, id: string, name: string) => {
      if (!seen.has(name)) {
        seen.add(name);
        emotes.push({ code: name, url: `https://files.kick.com/emotes/${id}/fullsize` });
      }
      return ` ${name} `;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, emotes };
}

export function normalizeKickMessage(
  raw: RawKickMessage,
  channel: string,
): NormalizedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const sender = raw.sender ?? {};
  const identity = sender.identity ?? {};
  const author = (sender.username ?? "").trim() || "anonymous";
  const color = isValidHexColor(identity.color) ? identity.color! : colorForName(author);
  const badges = Array.isArray(identity.badges)
    ? identity.badges.map((b) => String(b?.type ?? "").trim()).filter(Boolean)
    : [];
  const { text, emotes } = parseKickContent(String(raw.content ?? ""));
  const timestamp = raw.created_at ? Date.parse(raw.created_at) || Date.now() : Date.now();

  return {
    id: raw.id != null ? String(raw.id) : randomId(),
    platform: "kick",
    channel,
    author,
    color,
    badges,
    text,
    emotes,
    timestamp,
  };
}
