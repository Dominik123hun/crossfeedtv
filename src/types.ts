/**
 * Shared, platform-agnostic types.
 *
 * Every ingester (Twitch, Kick, X) converts its native chat payload into a
 * single {@link NormalizedMessage}. The overlay only ever sees normalized
 * messages, so it never needs to know which platform a message came from
 * beyond the `platform` tag used for styling.
 */

export type Platform = "twitch" | "kick" | "x";

export const PLATFORMS: readonly Platform[] = ["twitch", "kick", "x"] as const;

export interface Emote {
  /** The literal token in `text` that should be replaced by the image. */
  code: string;
  /** Absolute URL to the emote image. */
  url: string;
}

/**
 * The normalized message schema shared by all three platforms.
 *
 * The public schema (per the spec) is:
 *   { id, platform, author, color, badges, text, emotes, timestamp }
 *
 * `channel` is an extra routing field (the source channel / broadcast id) so a
 * single backend can serve many overlays at once. Clients may ignore it.
 */
export interface NormalizedMessage {
  id: string;
  platform: Platform;
  channel: string;
  author: string;
  /** Author name color as a CSS hex string (e.g. "#9146FF"). */
  color: string;
  /** Badge identifiers, e.g. ["broadcaster", "subscriber"]. */
  badges: string[];
  text: string;
  emotes: Emote[];
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** True for injected test/preview messages — never persisted, never cross-user. */
  test?: boolean;
}

/** Frames sent from the backend down to connected overlay clients. */
export type ServerFrame =
  | { type: "hello"; subscriptions: string[] }
  | { type: "chat"; msg: NormalizedMessage }
  | {
      type: "status";
      platform: Platform;
      channel: string;
      state: string;
      info?: string;
    };
