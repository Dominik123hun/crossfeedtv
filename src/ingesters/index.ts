import type { AppConfig } from "../config";
import type { IngesterFactory } from "../hub";
import { logger } from "../logger";
import type { Platform } from "../types";
import { KickIngester } from "./kick";
import { TwitchIngester } from "./twitch";
import { createXAccessProvider, XAccessManager } from "./x-access";
import { XIngester } from "./x";

/**
 * Registry of per-platform ingester factories. Platforms absent from this map
 * are silently skipped by the Hub, so the app stays runnable as platforms are
 * added across the build steps.
 *
 *   step 1: twitch  (done)
 *   step 2: kick    (done — kick-js primary, Pusher fallback)
 *   step 3: x       (done — structured adapter + TODOs)
 *   step 4: polish + the scalable X design (shared access manager + raw-WS fan-in)
 */

// One shared X access manager for the whole process: it mints/caches/refreshes
// the short-lived tokens once, so 20+ X ingesters stay cheap raw-WS consumers.
let xAccess: XAccessManager | undefined;

function getXAccess(cfg: AppConfig): XAccessManager {
  if (!xAccess) {
    const log = logger.child("x:access");
    const provider = createXAccessProvider(cfg.x, log);
    xAccess = new XAccessManager(provider, cfg.x.tokenTtlMs, log);
    log.info(`access provider: ${xAccess.mode}`);
  }
  return xAccess;
}

/** Release shared resources (e.g. the browser token-minter) on shutdown. */
export function closeSharedResources(): void {
  xAccess?.close();
  xAccess = undefined;
}

export const INGESTER_FACTORIES: Partial<Record<Platform, IngesterFactory>> = {
  twitch: (channel, cfg, log, events) =>
    new TwitchIngester(channel, cfg.reconnect, log, events, cfg.twitchWsUrl),
  kick: (channel, cfg, log, events) => new KickIngester(channel, cfg, log, events),
  x: (channel, cfg, log, events) => new XIngester(channel, cfg, log, events, getXAccess(cfg)),
};
