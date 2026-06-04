import type { NormalizedMessage } from "./types";
import { randomId } from "./util";

/**
 * Fake "test/preview" messages used by the dashboard + overlay test button.
 *
 * They are built here, flagged `test: true`, and pushed through the Hub to a
 * single user's clients via the exact same {type:"chat"} render path as real
 * chat — so a successful test proves the live pipeline works. They are never
 * persisted and never reach another user's feed.
 *
 * Emote images use the stable Twitch CDN regardless of the message's platform
 * (these are test messages — the source pill still labels Twitch/Kick/X), so an
 * inline emote reliably renders in each one.
 */
const TW = (id: string): string =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

interface Seed {
  platform: NormalizedMessage["platform"];
  author: string;
  color: string;
  badges: string[];
  text: string;
  emotes: { code: string; url: string }[];
}

const SEEDS: Seed[] = [
  {
    platform: "twitch",
    author: "test_ninja",
    color: "#ff7f50",
    badges: ["subscriber"],
    text: "this actually works Kappa",
    emotes: [{ code: "Kappa", url: TW("25") }],
  },
  {
    platform: "kick",
    author: "test_kicker",
    color: "#53fc18",
    badges: ["vip"],
    text: "green side up LUL",
    emotes: [{ code: "LUL", url: TW("425618") }],
  },
  {
    platform: "x",
    author: "@test_broadcast",
    color: "#ffffff",
    badges: [],
    text: "one feed for all three PogChamp",
    emotes: [{ code: "PogChamp", url: TW("305954156") }],
  },
  {
    platform: "twitch",
    author: "test_mod",
    color: "#9146ff",
    badges: ["moderator"],
    text: "merge looks clean Kappa",
    emotes: [{ code: "Kappa", url: TW("25") }],
  },
];

/** A fresh batch of test messages (unique ids + timestamps each call). */
export function buildTestMessages(): NormalizedMessage[] {
  const now = Date.now();
  return SEEDS.map((s, i) => ({
    id: randomId(),
    platform: s.platform,
    channel: "test",
    author: s.author,
    color: s.color,
    badges: s.badges,
    text: s.text,
    emotes: s.emotes,
    timestamp: now + i,
    test: true,
  }));
}

export const TEST_MESSAGE_COUNT = SEEDS.length;
