import { logger, type Logger } from "./logger";
import type { Emote } from "./types";

/**
 * Twitch third-party emote resolution (7TV / BTTV / FFZ — global + per-channel),
 * done in the INGESTER so the overlay stays a dumb image-swapper. Sets are
 * fetched once on channel connect, cached, and refreshed periodically. Every
 * fetch FAILS SOFT: a set that won't load contributes nothing and the message
 * still renders (the unmatched code shows as plain text). Network never touches
 * the render path.
 *
 * Precedence on code collisions (lowest → highest; later wins):
 *   global FFZ < global BTTV < global 7TV < channel FFZ < channel BTTV < channel 7TV
 * → channel beats global, and within a scope 7TV > BTTV > FFZ. Twitch-native
 * emotes (from IRC tags) rank below all of these and are merged at message time
 * (see {@link mergeEmotes}).
 */

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const seventvUrl = (id: string): string => `https://cdn.7tv.app/emote/${id}/2x.webp`;
const bttvUrl = (id: string): string => `https://cdn.betterttv.net/emote/${id}/2x`;

type Pair = [code: string, url: string];

interface ChannelEntry {
  index: Map<string, string>;
  fetchedAt: number;
  loading: boolean;
  twitchId?: string;
}

export interface EmoteResolverOptions {
  fetchJson?: FetchJson;
  refreshMs?: number;
  log?: Logger;
}

export class TwitchEmoteResolver {
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly fetchJson: FetchJson;
  private readonly refreshMs: number;
  private readonly log: Logger;

  constructor(opts: EmoteResolverOptions = {}) {
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
    this.refreshMs = opts.refreshMs ?? 30 * 60 * 1000;
    this.log = opts.log ?? logger.child("emotes");
  }

  /** Begin (or refresh) loading a channel's emote sets. Non-blocking, idempotent. */
  warm(channel: string, twitchId?: string): void {
    const key = channel.toLowerCase();
    let entry = this.channels.get(key);
    if (!entry) {
      entry = { index: new Map(), fetchedAt: 0, loading: false };
      this.channels.set(key, entry);
    }
    // A late-arriving room-id unlocks the 7TV/BTTV channel sets — force a reload.
    if (twitchId && entry.twitchId !== twitchId) {
      entry.twitchId = twitchId;
      entry.fetchedAt = 0;
    }
    const fresh = entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < this.refreshMs;
    if (entry.loading || fresh) return;
    void this.load(key, entry);
  }

  /** Return {code,url} for whitespace tokens present in the channel's cached index. */
  match(channel: string, text: string): Emote[] {
    const entry = this.channels.get(channel.toLowerCase());
    if (!entry || entry.index.size === 0) return [];
    const out: Emote[] = [];
    const seen = new Set<string>();
    for (const tok of text.split(" ")) {
      if (!tok || seen.has(tok)) continue;
      const url = entry.index.get(tok);
      if (url) {
        seen.add(tok);
        out.push({ code: tok, url });
      }
    }
    return out;
  }

  /** Test/diagnostic hook: how many emotes are cached for a channel. */
  size(channel: string): number {
    return this.channels.get(channel.toLowerCase())?.index.size ?? 0;
  }

  private async load(key: string, entry: ChannelEntry): Promise<void> {
    entry.loading = true;
    const id = entry.twitchId;
    try {
      // Ordered lowest → highest precedence (later layers overwrite earlier).
      const layers = await Promise.all([
        this.safe(() => this.ffzGlobal()),
        this.safe(() => this.bttvGlobal()),
        this.safe(() => this.seventvGlobal()),
        this.safe(() => this.ffzChannel(key)), // FFZ rooms key by login
        id ? this.safe(() => this.bttvChannel(id)) : Promise.resolve<Pair[]>([]),
        id ? this.safe(() => this.seventvChannel(id)) : Promise.resolve<Pair[]>([]),
      ]);

      const next = new Map<string, string>();
      for (const layer of layers) {
        for (const [code, url] of layer) next.set(code, url);
      }

      // Keep the previous index if a refresh produced nothing (transient failure).
      if (next.size > 0 || entry.index.size === 0) entry.index = next;
      entry.fetchedAt = Date.now();
      this.log.debug(`loaded ${entry.index.size} emotes for ${key}${id ? ` (id ${id})` : ""}`);
    } catch (err) {
      this.log.warn(`emote load failed for ${key}`, err);
      entry.fetchedAt = Date.now(); // back off until the next refresh window
    } finally {
      entry.loading = false;
    }
  }

  private async safe(fn: () => Promise<Pair[]>): Promise<Pair[]> {
    try {
      return await fn();
    } catch {
      return []; // fail soft — this provider simply contributes nothing
    }
  }

  // ── Providers ────────────────────────────────────────────────────────────

  private async seventvGlobal(): Promise<Pair[]> {
    const data = (await this.fetchJson("https://7tv.io/v3/emote-sets/global")) as {
      emotes?: Array<{ name?: string; id?: string }>;
    };
    return (data.emotes ?? [])
      .filter((e) => e.name && e.id)
      .map((e) => [e.name as string, seventvUrl(e.id as string)]);
  }

  private async seventvChannel(twitchId: string): Promise<Pair[]> {
    const data = (await this.fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`)) as {
      emote_set?: { emotes?: Array<{ name?: string; id?: string }> };
    };
    return (data.emote_set?.emotes ?? [])
      .filter((e) => e.name && e.id)
      .map((e) => [e.name as string, seventvUrl(e.id as string)]);
  }

  private async bttvGlobal(): Promise<Pair[]> {
    const data = (await this.fetchJson(
      "https://api.betterttv.net/3/cached/emotes/global",
    )) as Array<{ code?: string; id?: string }>;
    return (data ?? [])
      .filter((e) => e.code && e.id)
      .map((e) => [e.code as string, bttvUrl(e.id as string)]);
  }

  private async bttvChannel(twitchId: string): Promise<Pair[]> {
    const data = (await this.fetchJson(
      `https://api.betterttv.net/3/cached/users/twitch/${twitchId}`,
    )) as {
      channelEmotes?: Array<{ code?: string; id?: string }>;
      sharedEmotes?: Array<{ code?: string; id?: string }>;
    };
    return [...(data.channelEmotes ?? []), ...(data.sharedEmotes ?? [])]
      .filter((e) => e.code && e.id)
      .map((e) => [e.code as string, bttvUrl(e.id as string)]);
  }

  private async ffzGlobal(): Promise<Pair[]> {
    return this.ffzParse(await this.fetchJson("https://api.frankerfacez.com/v1/set/global"));
  }

  private async ffzChannel(login: string): Promise<Pair[]> {
    return this.ffzParse(
      await this.fetchJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login)}`),
    );
  }

  private ffzParse(data: unknown): Pair[] {
    const sets = (data as { sets?: Record<string, { emoticons?: Array<{ name?: string; urls?: Record<string, string> }> }> })?.sets ?? {};
    const out: Pair[] = [];
    for (const set of Object.values(sets)) {
      for (const e of set.emoticons ?? []) {
        const raw = e.urls && (e.urls["2"] || e.urls["1"]);
        if (e.name && raw) out.push([e.name, raw.startsWith("http") ? raw : `https:${raw}`]);
      }
    }
    return out;
  }
}

/** Merge native (lowest precedence) and third-party emotes; third-party wins. */
export function mergeEmotes(native: Emote[], thirdParty: Emote[]): Emote[] {
  const byCode = new Map<string, string>();
  for (const e of native) byCode.set(e.code, e.url);
  for (const e of thirdParty) byCode.set(e.code, e.url);
  return [...byCode].map(([code, url]) => ({ code, url }));
}
