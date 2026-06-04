import type { WebSocket } from "ws";
import type { AppConfig } from "./config";
import { logger, type Logger } from "./logger";
import type { Ingester, IngesterState } from "./ingesters/base";
import type { UserChannels } from "./store";
import { buildTestMessages } from "./test-feed";
import {
  PLATFORMS,
  type ConnState,
  type NormalizedMessage,
  type OverlaySettings,
  type Platform,
  type ServerFrame,
} from "./types";
import { randomId } from "./util";

/** Map an internal ingester lifecycle state to the public connection state. */
function wireState(state: IngesterState): ConnState {
  switch (state) {
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "error":
      return "error";
    case "stopped":
      return "disconnected";
    case "connecting":
    case "idle":
    default:
      return "connecting";
  }
}

/** Which channels a feed client wants, plus optional owning user (multi-tenant). */
export interface FeedSubscription {
  channels: UserChannels;
  userId?: string;
  /** Overlay settings to push on connect (token-resolved clients). */
  settings?: OverlaySettings;
}

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
) => Ingester;

interface Entry {
  ingester: Ingester;
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
  /** Owning user (multi-tenant), if this client connected via a token. */
  userId?: string;
}

function keyOf(platform: Platform, channel: string): string {
  return `${platform}:${channel.toLowerCase()}`;
}

function splitKey(key: string): [Platform, string] {
  const i = key.indexOf(":");
  return [key.slice(0, i) as Platform, key.slice(i + 1)];
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
  /** Index of clients by owning user, for live re-subscription and disconnects. */
  private readonly clientsByUser = new Map<string, Set<string>>();
  /** Debounce key ("u:<userId>" / "c:<clientId>") -> last test-fire timestamp. */
  private readonly lastTestAt = new Map<string, number>();
  private readonly testCooldownMs = 2500;
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
        ingester: undefined as unknown as Ingester,
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

  addClient(ws: WebSocket, sub: FeedSubscription): void {
    const id = randomId();
    const subs = new Set<string>();

    for (const platform of PLATFORMS) {
      const channel = sub.channels[platform];
      if (!channel) continue;
      const key = keyOf(platform, channel);
      subs.add(key);
      this.ensure(platform, channel, false);
    }

    const client: Client = { id, ws, subs, userId: sub.userId };
    this.clients.set(id, client);
    if (client.userId) {
      let set = this.clientsByUser.get(client.userId);
      if (!set) this.clientsByUser.set(client.userId, (set = new Set()));
      set.add(id);
    }

    this.send(ws, { type: "hello", subscriptions: [...subs] });
    if (sub.settings) this.send(ws, { type: "settings", settings: sub.settings });
    // Definitive per-platform status (idle for platforms with no channel set).
    for (const platform of PLATFORMS) {
      const key = [...subs].find((k) => k.startsWith(`${platform}:`));
      if (key) this.sendStatusForKey(ws, key);
      else this.send(ws, { type: "status", platform, state: "idle" });
    }

    this.log.info(
      `client ${id.slice(0, 8)}${client.userId ? ` (user ${client.userId.slice(0, 8)})` : ""} connected; subs=[${[...subs].join(", ") || "none"}]; clients=${this.clients.size}`,
    );

    ws.on("close", () => this.removeClient(id));
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
    // Inbound control frames from the overlay (e.g. its "Send test" button).
    ws.on("message", (raw) => {
      let frame: { type?: string };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame && frame.type === "test") {
        if (client.userId) this.triggerTestForUser(client.userId);
        else this.triggerTestForClient(id);
      }
    });
  }

  // --- Test / preview feed -------------------------------------------------

  /** Inject staggered test messages into every client of a user. Debounced. */
  triggerTestForUser(userId: string): boolean {
    if (!this.allowTest(`u:${userId}`)) return false;
    const ids = this.clientsByUser.get(userId);
    const targets: Client[] = [];
    if (ids) {
      for (const cid of ids) {
        const c = this.clients.get(cid);
        if (c) targets.push(c);
      }
    }
    this.staggerTest(targets);
    return true;
  }

  /** Inject test messages into a single (non-user/demo) client. Debounced. */
  triggerTestForClient(clientId: string): boolean {
    if (!this.allowTest(`c:${clientId}`)) return false;
    const client = this.clients.get(clientId);
    if (client) this.staggerTest([client]);
    return true;
  }

  private allowTest(key: string): boolean {
    const now = Date.now();
    if (now - (this.lastTestAt.get(key) ?? 0) < this.testCooldownMs) return false;
    this.lastTestAt.set(key, now);
    return true;
  }

  private staggerTest(targets: Client[]): void {
    if (targets.length === 0) return;
    const messages = buildTestMessages();
    messages.forEach((msg, i) => {
      const delay = i * (350 + Math.floor(Math.random() * 120));
      setTimeout(() => {
        const data = JSON.stringify({ type: "chat", msg } satisfies ServerFrame);
        for (const c of targets) this.sendRaw(c.ws, data);
      }, delay);
    });
  }

  /**
   * Apply a user's new channel set to their live overlay connections so changes
   * in the dashboard take effect without an OBS refresh. Each user's ingesters
   * stay isolated — adding/removing only affects that user's clients' refs.
   */
  resubscribe(userId: string, channels: UserChannels): void {
    const ids = this.clientsByUser.get(userId);
    if (!ids || ids.size === 0) return;

    const desired = new Set<string>();
    for (const platform of PLATFORMS) {
      const channel = channels[platform];
      if (channel) desired.add(keyOf(platform, channel));
    }

    for (const id of ids) {
      const client = this.clients.get(id);
      if (!client) continue;

      for (const key of desired) {
        if (client.subs.has(key)) continue;
        const [platform, channel] = splitKey(key);
        this.ensure(platform, channel, false);
        client.subs.add(key);
        this.sendStatusForKey(client.ws, key);
      }
      for (const key of [...client.subs]) {
        if (desired.has(key)) continue;
        client.subs.delete(key);
        this.release(key);
        const [platform] = splitKey(key);
        // A platform with no channel anymore reports idle.
        this.send(client.ws, { type: "status", platform, state: "idle" });
      }
      this.send(client.ws, { type: "hello", subscriptions: [...client.subs] });
    }
    this.log.info(`resubscribed user ${userId.slice(0, 8)} -> [${[...desired].join(", ") || "none"}]`);
  }

  /** Push updated overlay settings to all of a user's live clients (no OBS refresh). */
  pushSettings(userId: string, settings: OverlaySettings): void {
    const ids = this.clientsByUser.get(userId);
    if (!ids) return;
    const data = JSON.stringify({ type: "settings", settings } satisfies ServerFrame);
    for (const id of ids) {
      const client = this.clients.get(id);
      if (client) this.sendRaw(client.ws, data);
    }
  }

  /** Force-disconnect every overlay client belonging to a user (e.g. on delete). */
  disconnectUser(userId: string): void {
    const ids = this.clientsByUser.get(userId);
    if (!ids) return;
    for (const id of [...ids]) {
      const client = this.clients.get(id);
      if (!client) continue;
      try {
        client.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private sendStatusForKey(ws: WebSocket, key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const [platform] = splitKey(key);
    this.send(ws, { type: "status", platform, state: wireState(entry.state), detail: entry.info });
  }

  private removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    this.lastTestAt.delete(`c:${id}`);
    if (client.userId) {
      const set = this.clientsByUser.get(client.userId);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.clientsByUser.delete(client.userId);
      }
    }
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
    const data = JSON.stringify({
      type: "status",
      platform,
      state: wireState(state),
      detail: info,
    } satisfies ServerFrame);
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
