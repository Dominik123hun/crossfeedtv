import WebSocket from "ws";
import type { ReconnectConfig } from "../config";
import { mergeEmotes, type TwitchEmoteResolver } from "../emotes";
import type { Logger } from "../logger";
import type { NormalizedMessage, Platform } from "../types";
import { BaseIngester, type Ingester, type IngesterState } from "./base";
import { parseIrcLine } from "./twitch-irc";
import { normalizeTwitchMessage } from "./twitch-normalize";

/* ───────────────────────────────────────────────────────────────────────────
   Twitch connection multiplexing.

   A single anonymous IRC connection can JOIN many channels, so instead of one
   socket per channel (which trips connection/JOIN rate limits at scale), the
   TwitchPool spreads channels across a few shared TwitchConnections. Each
   connection reuses BaseIngester for the connect → handshake → reconnect-backoff
   lifecycle; per-channel work is JOIN/PART (rate-limited) plus routing each
   PRIVMSG to the right subscriber. One bad connection never affects the others.
   ─────────────────────────────────────────────────────────────────────────── */

export interface PoolConfig {
  wsUrl: string;
  maxChannelsPerConn: number;
  joinsPerWindow: number;
  joinWindowMs: number;
}

interface ChannelSub {
  /** Lowercased channel, no leading '#'. */
  channel: string;
  onMessage: (msg: NormalizedMessage) => void;
  onState: (state: IngesterState, info?: string) => void;
}

function anonNick(): string {
  return `justinfan${Math.floor(Math.random() * 80000 + 10000)}`;
}

/** One shared IRC connection holding up to N channels. */
class TwitchConnection extends BaseIngester {
  readonly platform: Platform = "twitch";

  private ws?: WebSocket;
  private nick = anonNick();
  private readonly subs = new Map<string, ChannelSub>();
  private readonly joined = new Set<string>();
  private readonly joinQueue: string[] = [];
  private joinStamps: number[] = [];
  private joinTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly id: string,
    reconnectCfg: ReconnectConfig,
    private readonly poolCfg: PoolConfig,
    log: Logger,
    private readonly emotes: TwitchEmoteResolver,
  ) {
    super(id, reconnectCfg, log, { onState: (s, info) => this.fanState(s, info) });
  }

  get size(): number {
    return this.subs.size;
  }
  hasRoom(): boolean {
    return this.subs.size < this.poolCfg.maxChannelsPerConn;
  }
  has(channel: string): boolean {
    return this.subs.has(channel);
  }

  addChannel(sub: ChannelSub): void {
    this.subs.set(sub.channel, sub);
    if (this.state === "connected") {
      sub.onState("connecting", "joining");
      this.enqueueJoin(sub.channel);
    } else {
      sub.onState(this.state === "idle" ? "connecting" : this.state);
    }
  }

  removeChannel(channel: string): void {
    this.subs.delete(channel);
    this.joined.delete(channel);
    const i = this.joinQueue.indexOf(channel);
    if (i >= 0) this.joinQueue.splice(i, 1);
    this.send(`PART #${channel}`);
  }

  protected doConnect(): void {
    const ws = new WebSocket(this.poolCfg.wsUrl);
    this.ws = ws;
    this.nick = anonNick();

    ws.on("open", () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n");
      ws.send(`NICK ${this.nick}\r\n`);
      this.onConnected();
      // (Re)JOIN every assigned channel, rate-limited.
      this.joined.clear();
      this.joinQueue.length = 0;
      for (const ch of this.subs.keys()) this.enqueueJoin(ch);
    });
    ws.on("message", (data: WebSocket.RawData) => this.handlePayload(data.toString()));
    ws.on("error", (e: Error) => this.onError(e.message));
    ws.on("close", (code: number) => this.onClosed(`socket closed (${code})`));
  }

  protected doDisconnect(): void {
    if (this.joinTimer) {
      clearTimeout(this.joinTimer);
      this.joinTimer = undefined;
    }
    this.joinQueue.length = 0;
    this.joinStamps = [];
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        /* best effort */
      }
    }
  }

  /** Relay the connection's lifecycle state to every channel it carries. */
  private fanState(state: IngesterState, info?: string): void {
    if (state !== "connected") this.joined.clear();
    for (const sub of this.subs.values()) {
      if (state === "connected") {
        sub.onState(this.joined.has(sub.channel) ? "connected" : "connecting", "joining");
      } else {
        sub.onState(state, info);
      }
    }
  }

  private enqueueJoin(channel: string): void {
    if (!this.joinQueue.includes(channel)) this.joinQueue.push(channel);
    this.pumpJoins();
  }

  /** Send queued JOINs without exceeding the per-window rate limit. */
  private pumpJoins(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const { joinsPerWindow, joinWindowMs } = this.poolCfg;
    this.joinStamps = this.joinStamps.filter((t) => now - t < joinWindowMs);

    while (this.joinQueue.length && this.joinStamps.length < joinsPerWindow) {
      const ch = this.joinQueue.shift()!;
      try {
        ws.send(`JOIN #${ch}\r\n`);
      } catch {
        /* ignore */
      }
      this.joinStamps.push(Date.now());
    }

    if (this.joinQueue.length && !this.joinTimer) {
      const oldest = this.joinStamps[0] ?? now;
      const wait = Math.max(50, joinWindowMs - (now - oldest) + 50);
      this.joinTimer = setTimeout(() => {
        this.joinTimer = undefined;
        this.pumpJoins();
      }, wait);
    }
  }

  private handlePayload(payload: string): void {
    for (const line of payload.split("\r\n")) if (line) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (line.startsWith("PING")) {
      this.send(line.replace("PING", "PONG"));
      return;
    }
    let msg;
    try {
      msg = parseIrcLine(line);
    } catch {
      return;
    }

    switch (msg.command) {
      case "PRIVMSG": {
        const channel = (msg.params[0] ?? "").replace(/^#/, "").toLowerCase();
        const sub = this.subs.get(channel);
        if (!sub) return;
        try {
          const normalized = normalizeTwitchMessage(msg, channel);
          if (normalized) {
            // Lazily warm 3rd-party sets once we know the channel's numeric id,
            // then augment native emotes with 7TV/BTTV/FFZ (3rd-party wins).
            const roomId = msg.tags["room-id"];
            if (roomId) this.emotes.warm(channel, roomId);
            normalized.emotes = mergeEmotes(
              normalized.emotes,
              this.emotes.match(channel, normalized.text),
            );
            sub.onMessage(normalized);
          }
        } catch (e) {
          this.log.warn("normalize/route failed", e);
        }
        break;
      }
      case "JOIN":
        // Membership capability echoes JOINs for everyone — only our own confirms a join.
        if (msg.nick && msg.nick !== this.nick) return;
        this.confirmJoin(msg.params[0]);
        break;
      case "ROOMSTATE": {
        const channel = (msg.params[0] ?? "").replace(/^#/, "").toLowerCase();
        if (channel) this.emotes.warm(channel, msg.tags["room-id"]);
        this.confirmJoin(msg.params[0]);
        break;
      }
      case "RECONNECT":
        this.log.info("server requested RECONNECT");
        this.onClosed("server RECONNECT");
        break;
      default:
        break;
    }
  }

  private confirmJoin(rawChannel: string | undefined): void {
    const channel = (rawChannel ?? "").replace(/^#/, "").toLowerCase();
    if (!channel || this.joined.has(channel)) return;
    this.joined.add(channel);
    this.subs.get(channel)?.onState("connected");
  }

  private send(raw: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(raw.endsWith("\r\n") ? raw : raw + "\r\n");
      } catch (e) {
        this.log.warn("send failed", e);
      }
    }
  }
}

/** Shared across the process: assigns channels to connections, spins up more as needed. */
export class TwitchPool {
  private readonly connections: TwitchConnection[] = [];
  private seq = 0;

  constructor(
    private readonly reconnectCfg: ReconnectConfig,
    private readonly poolCfg: PoolConfig,
    private readonly log: Logger,
    private readonly emotes: TwitchEmoteResolver,
  ) {}

  subscribe(sub: ChannelSub): () => void {
    let conn = this.connections.find((c) => c.has(sub.channel));
    if (!conn) conn = this.connections.find((c) => c.hasRoom());
    if (!conn) conn = this.spawn();
    conn.addChannel(sub);
    this.log.debug(
      `+${sub.channel} -> ${conn.id} (${conn.size} on conn, ${this.connections.length} conns)`,
    );

    let released = false;
    const target = conn;
    return () => {
      if (released) return;
      released = true;
      target.removeChannel(sub.channel);
      if (target.size === 0) {
        target.stop();
        const i = this.connections.indexOf(target);
        if (i >= 0) this.connections.splice(i, 1);
        this.log.info(`closed empty connection ${target.id} (${this.connections.length} left)`);
      }
    };
  }

  private spawn(): TwitchConnection {
    const id = `conn#${this.seq++}`;
    const conn = new TwitchConnection(id, this.reconnectCfg, this.poolCfg, this.log.child(id), this.emotes);
    this.connections.push(conn);
    conn.start();
    this.log.info(`opened connection ${id} (${this.connections.length} total)`);
    return conn;
  }

  snapshot(): unknown {
    return {
      connections: this.connections.map((c) => ({ id: c.id, channels: c.size, state: c.state })),
    };
  }

  close(): void {
    for (const c of this.connections) {
      try {
        c.stop();
      } catch {
        /* ignore */
      }
    }
    this.connections.length = 0;
  }
}

/**
 * The Hub-facing Twitch ingester when multiplexing is on: a thin subscriber to
 * the shared pool. It owns no socket — the pool delivers messages and state.
 */
export class PooledTwitchIngester implements Ingester {
  readonly platform: Platform = "twitch";
  readonly channel: string;
  private unsubscribe?: () => void;

  constructor(
    channel: string,
    private readonly pool: TwitchPool,
    private readonly events: {
      onMessage: (msg: NormalizedMessage) => void;
      onState: (state: IngesterState, info?: string) => void;
    },
  ) {
    this.channel = channel;
  }

  start(): void {
    this.unsubscribe = this.pool.subscribe({
      channel: this.channel.toLowerCase(),
      onMessage: (m) => {
        try {
          this.events.onMessage(m);
        } catch {
          /* isolate */
        }
      },
      onState: (s, info) => {
        try {
          this.events.onState(s, info);
        } catch {
          /* isolate */
        }
      },
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      this.events.onState("stopped");
    } catch {
      /* isolate */
    }
  }
}
