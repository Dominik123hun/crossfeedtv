import type { Emote, NormalizedMessage } from "../types";
import { colorForName, isValidHexColor, parseTimestamp, randomId } from "../util";
import type { IrcMessage } from "./twitch-irc";

/** Twitch emote CDN. Sizes: 1.0 / 2.0 / 3.0. We use 2.0 for crisp overlays. */
function emoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

/** "broadcaster/1,subscriber/12" -> ["broadcaster", "subscriber"] */
function parseBadges(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((b) => b.split("/")[0]?.trim())
    .filter((b): b is string => !!b);
}

/**
 * Parse Twitch's `emotes` tag into normalized {code,url} pairs.
 *
 * Tag format: "<id>:<start>-<end>,<start>-<end>/<id2>:<start>-<end>"
 * Positions index Unicode code points of the message text (not UTF-16 units),
 * so we split with the spread operator to honor surrogate pairs.
 */
export function parseTwitchEmotes(value: string | undefined, text: string): Emote[] {
  if (!value) return [];
  const chars = [...text];
  const out: Emote[] = [];
  const seen = new Set<string>();

  for (const group of value.split("/")) {
    const colon = group.indexOf(":");
    if (colon === -1) continue;
    const id = group.slice(0, colon);
    const ranges = group.slice(colon + 1);
    const first = ranges.split(",")[0];
    if (!id || !first) continue;
    const [startStr, endStr] = first.split("-");
    const start = Number(startStr);
    const end = Number(endStr);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    const code = chars.slice(start, end + 1).join("");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, url: emoteUrl(id) });
  }
  return out;
}

/**
 * Convert a Twitch PRIVMSG into the normalized schema. Returns null for lines
 * that aren't real chat messages.
 */
export function normalizeTwitchMessage(
  msg: IrcMessage,
  channel: string,
): NormalizedMessage | null {
  if (msg.command !== "PRIVMSG") return null;
  const tags = msg.tags;
  const text = msg.trailing ?? "";
  const author = (tags["display-name"] || "").trim() || msg.nick || "anonymous";
  const color = isValidHexColor(tags["color"]) ? tags["color"]! : colorForName(author);

  return {
    id: tags["id"] || randomId(),
    platform: "twitch",
    channel,
    author,
    color,
    badges: parseBadges(tags["badges"]),
    text,
    emotes: parseTwitchEmotes(tags["emotes"], text),
    timestamp: parseTimestamp(tags["tmi-sent-ts"]),
  };
}
