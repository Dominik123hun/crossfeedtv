import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import type { AppConfig } from "./config";
import { logger, type Logger } from "./logger";
import type { BaseIngester, IngesterState } from "./ingesters/base";
import { PLATFORMS, type NormalizedMessage, type Platform, type ServerFrame } from "./types";
import { randomId } from "./util";

/**
 * Builds an ingester for one channel. Each platform registers a factory in
 * src/ingesters/index.ts; missing platforms are simply skipped (isolation).
 */
export type IngesterFactory = (
  channel: string,
  cfg: AppConfig,
  log: Logger,
  events: {
    onMessage: (msg: NormalizedMessage) => void;
    onState: (state: IngesterState, info?: string) => void;
  },
) => BaseIngester;

interface Entry {
  ingester: BaseIngester;
  /** Number of connected clients subscribed (env-default ingesters add 0). */
  refs: number;
  /** Persistent ingesters (from env defaults) are never torn down. */
  persistent: boolean;
  state: IngesterState;
  info?: string;
}

interface Client {
  id: string;
  ws: WebSocket;
  /** Subscription keys, e.g. "twitch:xqc". */
  subs: Set<string>;
}

function keyOf(platform: Platform, channel: string): string {
  return `${platform}:${channel.toLowerCase()}`;
}

function splitKey(key: string): [Platform, string] {
  const i = key.indexOf(":");
  return [key.slice(0, i) as Platform, key.slice(i + 1)];
}

/** Extract requested channels from a /feed?twitch=…&kick=…&x=… URL. */
function parseRequest(url: string | undefined): Partial<Record<Platform, string>> {
  const u = new URL(url || "/", "http://localhost");
  const get = (k: string): string | undefined => {
    const v = u.searchParams.get(k);
    return v && v.trim() ? v.trim() : undefined;
  };
  return { twitch: get("twitch"), kick: get("kick"), x: get("x") };
}

/**
 * The Hub is the heart of the fan-out: it owns the set of running ingesters
 * (reference-counted by subscribed clients), routes each normalized message to
 * exactly the clients that asked for that platform+channel, and relays ingester
 * state changes. One backend can therefore serve many overlays at once.
 */
export class Hub {
  private readonly entries = new Map<string, Entry>();
  private readonly clients = new Map<string, Client>();
  private readonly log = logger.child("hub");

  constructor(
    private readonly cfg: AppConfig,
    private readonly factories: Partial<Record<Platform, IngesterFactory>>,
  ) {}

  /** Start persistent ingesters for any env-default channels. */
  start(): void {
    for (const platform of PLATFORMS) {
      const channel = this.cfg.defaults[platform];
      if (channel) this.ensure(platform, channel, true);
    }
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.ingester.stop();
      } catch {
        /* ignore */
      }
    }
    this.entries.clear();
  }

  // --- Ingester management -------------------------------------------------

  private ensure(platform: Platform, channel: string, persistent: boolean): void {
    const key = keyOf(platform, channel);
    const existing = this.entries.get(key);
    if (existing) {
      if (persistent) existing.persistent = true;
      if (!persistent) existing.refs += 1;
      return;
    }

    const factory = this.factories[platform];
    if (!factory) {
      this.log.warn(`no ingester registered for "${platform}" (channel ${channel}); skipping`);
      return;
    }

    // Isolation: a failure constructing/starting one ingester must not affect others.
    try {
      const entry: Entry = {
        ingester: undefined as unknown as BaseIngester,
        refs: persistent ? 0 : 1,
        persistent,
        state: "idle",
      };
      entry.ingester = factory(channel, this.cfg, logger.child(key), {
        onMessage: (msg) => this.route(key, msg),
        onState: (state, info) => this.onIngesterState(key, platform, channel, state, info),
      });
      this.entries.set(key, entry);
      entry.ingester.start();
      this.log.info(`started ingester ${key} (persistent=${persistent})`);
    } catch (err) {
      this.log.error(`failed to start ingester ${key}:`, err);
      this.entries.delete(key);
    }
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs <= 0 && !entry.persistent) {
      try {
        entry.ingester.stop();
      } catch {
        /* ignore */
      }
      this.entries.delete(key);
      this.log.info(`stopped idle ingester ${key}`);
    }
  }

  // --- Client management ---------------------------------------------------

  addClient(ws: WebSocket, req: IncomingMessage): void {
    const id = randomId();
    const requested = parseRequest(req.url);
    const subs = new Set<string>();

    for (const platform of PLATFORMS) {
      const channel = requested[platform];
      if (!channel) continue;
      const key = keyOf(platform, channel);
      subs.add(key);
      this.ensure(platform, channel, false);
    }

    const client: Client = { id, ws, subs };
    this.clients.set(id, client);

    this.send(ws, { type: "hello", subscriptions: [...subs] });
    // Replay current state so the overlay can show connection status immediately.
    for (const key of subs) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      const [platform, channel] = splitKey(key);
      this.send(ws, { type: "status", platform, channel, state: entry.state, info: entry.info });
    }

    this.log.info(
      `client ${id.slice(0, 8)} connected; subs=[${[...subs].join(", ") || "none"}]; clients=${this.clients.size}`,
    );

    ws.on("close", () => this.removeClient(id));
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    for (const key of client.subs) this.release(key);
    this.log.info(`client ${id.slice(0, 8)} disconnected; clients=${this.clients.size}`);
  }

  // --- Fan-out -------------------------------------------------------------

  private route(key: string, msg: NormalizedMessage): void {
    const data = JSON.stringify({ type: "chat", msg } satisfies ServerFrame);
    for (const client of this.clients.values()) {
      if (client.subs.has(key)) this.sendRaw(client.ws, data);
    }
  }

  private onIngesterState(
    key: string,
    platform: Platform,
    channel: string,
    state: IngesterState,
    info?: string,
  ): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.state = state;
      entry.info = info;
    }
    const data = JSON.stringify({ type: "status", platform, channel, state, info } satisfies ServerFrame);
    for (const client of this.clients.values()) {
      if (client.subs.has(key)) this.sendRaw(client.ws, data);
    }
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    this.sendRaw(ws, JSON.stringify(frame));
  }

  private sendRaw(ws: WebSocket, data: string): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(data);
    } catch (err) {
      this.log.warn("send failed", err);
    }
  }

  /** Diagnostic snapshot served at /healthz. */
  snapshot(): unknown {
    return {
      clients: this.clients.size,
      ingesters: [...this.entries.entries()].map(([key, e]) => ({
        key,
        state: e.state,
        refs: e.refs,
        persistent: e.persistent,
        info: e.info,
      })),
    };
  }
}
