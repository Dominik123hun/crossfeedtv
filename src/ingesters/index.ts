import type { IngesterFactory } from "../hub";
import type { Platform } from "../types";
import { KickIngester } from "./kick";
import { TwitchIngester } from "./twitch";
import { XIngester } from "./x";

/**
 * Registry of per-platform ingester factories. Platforms absent from this map
 * are silently skipped by the Hub, so the app stays runnable as platforms are
 * added across the build steps.
 *
 *   step 1: twitch  (done)
 *   step 2: kick    (done)
 *   step 3: x       (structured adapter + TODOs; configure via RECON.md)
 */
export const INGESTER_FACTORIES: Partial<Record<Platform, IngesterFactory>> = {
  twitch: (channel, cfg, log, events) =>
    new TwitchIngester(channel, cfg.reconnect, log, events, cfg.twitchWsUrl),
  kick: (channel, cfg, log, events) => new KickIngester(channel, cfg, log, events),
  x: (channel, cfg, log, events) => new XIngester(channel, cfg, log, events),
};
