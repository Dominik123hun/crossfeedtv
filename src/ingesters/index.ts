import type { AppConfig } from "../config";
import type { IngesterFactory } from "../hub";
import { logger } from "../logger";
import type { Platform } from "../types";
import { KickIngester } from "./kick";
import { TwitchIngester } from "./twitch";
import { PooledTwitchIngester, TwitchPool } from "./twitch-pool";
import { createXAccessProvider, XAccessManager } from "./x-access";
import { XIngester } from "./x";

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

/** Release shared resources (Twitch pool, X browser token-minter) on shutdown. */
export function closeSharedResources(): void {
  twitchPool?.close();
  twitchPool = undefined;
  xAccess?.close();
  xAccess = undefined;
}

export const INGESTER_FACTORIES: Partial<Record<Platform, IngesterFactory>> = {
  twitch: (channel, cfg, log, events) =>
    cfg.twitch.multiplex
      ? new PooledTwitchIngester(channel, getTwitchPool(cfg), events)
      : new TwitchIngester(channel, cfg.reconnect, log, events, cfg.twitch.wsUrl),
  kick: (channel, cfg, log, events) => new KickIngester(channel, cfg, log, events),
  x: (channel, cfg, log, events) => new XIngester(channel, cfg, log, events, getXAccess(cfg)),
};
