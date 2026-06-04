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

/** Per-user overlay appearance settings (travel with the token to the overlay). */
export interface OverlaySettings {
  /** Base font size in px. */
  fontSize: number;
  /** Translucent panel behind each message, 0 (transparent) … 1. */
  bgOpacity: number;
  position: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** Per-platform show/hide. */
  show: { twitch: boolean; kick: boolean; x: boolean };
  /** Show the small on-overlay connection dots. */
  statusIndicator: boolean;
}

/** Defaults chosen so existing overlays look unchanged until a user customizes. */
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  fontSize: 18,
  bgOpacity: 0,
  position: "bottom-left",
  show: { twitch: true, kick: true, x: true },
  statusIndicator: false,
};

/** Per-user, per-platform connection state shown in the dashboard/overlay. */
export type ConnState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "error"
  | "disconnected"
  | "idle";

/** Frames sent from the backend down to connected overlay clients. */
export type ServerFrame =
  | { type: "hello"; subscriptions: string[] }
  | { type: "chat"; msg: NormalizedMessage }
  | {
      type: "status";
      platform: Platform;
      state: ConnState;
      /** Short last-error/detail string (mainly for the "error" state). */
      detail?: string;
    }
  | { type: "settings"; settings: OverlaySettings };
