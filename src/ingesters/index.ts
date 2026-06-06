import type { AppConfig } from "../config";
import { TwitchEmoteResolver } from "../emotes";
import type { IngesterFactory } from "../hub";
import { logger } from "../logger";
import type { Platform } from "../types";
import type { Ingester } from "./base";
import { KickIngester } from "./kick";
import { TwitchIngester } from "./twitch";
import { PooledTwitchIngester, TwitchPool } from "./twitch-pool";
import { createXAccessProvider, XAccessManager } from "./x-access";
import { XIngester } from "./x";
import { closeSharedXBrowser, XBrowserIngester } from "./x-browser";

// Shared Twitch 3rd-party emote resolver (7TV/BTTV/FFZ), cached per channel.
const twitchEmotes = new TwitchEmoteResolver({ log: logger.child("emotes") });

/**
 * Registry of per-platform ingester factories. Platforms absent from this map
 * are silently skipped by the Hub, so the app stays runnable as platforms are
 * added across the build steps.
 *
 *   twitch — anonymous IRC; multiplexed across shared connections by default
 *   kick   — kick-js primary, Pusher fallback
 *   x      — shared token-minting access manager + raw-WS fan-in
 */

// One shared Twitch connection pool for the whole process (channel multiplexing).
let twitchPool: TwitchPool | undefined;

function getTwitchPool(cfg: AppConfig): TwitchPool {
  if (!twitchPool) {
    twitchPool = new TwitchPool(
      cfg.reconnect,
      {
        wsUrl: cfg.twitch.wsUrl,
        maxChannelsPerConn: cfg.twitch.maxChannelsPerConn,
        joinsPerWindow: cfg.twitch.joinsPerWindow,
        joinWindowMs: cfg.twitch.joinWindowMs,
      },
      logger.child("twitch:pool"),
      twitchEmotes,
    );
  }
  return twitchPool;
}

// One shared X access manager: mints/caches/refreshes short-lived tokens once.
let xAccess: XAccessManager | undefined;

function getXAccess(cfg: AppConfig): XAccessManager {
  if (!xAccess) {
    const log = logger.child("x:access");
    xAccess = new XAccessManager(createXAccessProvider(cfg.x, log), cfg.x.tokenTtlMs, log);
    log.info(`access provider: ${xAccess.mode}`);
  }
  return xAccess;
}

/**
 * Inert ingester used when a platform is behind an off feature flag (X beta).
 * It registers in the Hub (so the dashboard shows the source) but never connects,
 * so the status simply stays "idle".
 */
class DisabledIngester implements Ingester {
  constructor(
    readonly platform: Platform,
    readonly channel: string,
  ) {}
  start(): void {}
  stop(): void {}
}

/** Release shared resources (Twitch pool, X browser token-minter) on shutdown. */
export function closeSharedResources(): void {
  twitchPool?.close();
  twitchPool = undefined;
  xAccess?.close();
  xAccess = undefined;
  closeSharedXBrowser();
}

export const INGESTER_FACTORIES: Partial<Record<Platform, IngesterFactory>> = {
  twitch: (channel, cfg, log, events) =>
    cfg.twitch.multiplex
      ? new PooledTwitchIngester(channel, getTwitchPool(cfg), events)
      : new TwitchIngester(channel, cfg.reconnect, log, events, cfg.twitch.wsUrl, twitchEmotes),
  kick: (channel, cfg, log, events) => new KickIngester(channel, cfg, log, events),
  // X is BETA + unofficial — only connects when X_ENABLED=true; otherwise inert.
  // X_MODE=browser drives a real headless browser (most robust); else the
  // fetch-based Periscope resolver.
  x: (channel, cfg, log, events) => {
    if (!cfg.x.enabled) return new DisabledIngester("x", channel);
    if (cfg.x.mode === "browser") return new XBrowserIngester(channel, cfg, log, events);
    // DEFAULT (auto) and ingest = no server-side connection; a browser userscript
    // scrapes the chat DOM and pushes it to /x-ingest (the channel just subscribes).
    // The fetch resolver is confirmed blocked from servers, so it's opt-in only
    // via X_MODE=periscope|http|static.
    if (cfg.x.mode === "auto" || cfg.x.mode === "ingest") return new DisabledIngester("x", channel);
    return new XIngester(channel, cfg, log, events, getXAccess(cfg));
  },
};
