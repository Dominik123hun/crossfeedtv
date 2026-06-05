import type WebSocket from "ws";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { Platform } from "../types";
import { BaseIngester, type IngesterEvents } from "./base";
import type { XAccess, XAccessManager } from "./x-access";
import { connectChat, parseBroadcastId } from "./x-periscope";
import { normalizeXMessage, type RawXMessage } from "./x-normalize";

/* ───────────────────────────────────────────────────────────────────────────
   X (Twitter) broadcast chat ingester — EXPERIMENTAL / BETA, unofficial.

   X has no official broadcast-chat API; this replicates the public pscp.tv
   (Periscope) handshake the web player uses. It is a cheap consumer: it asks the
   shared XAccessManager for { chatWsUrl, accessToken } (the manager runs the
   resolve→access handshake, caches/refreshes centrally), opens one WebSocket,
   sends the auth + join frames, and parses chat frames into the normalized
   schema. 20+ X chats = 20+ light sockets over one shared access manager.

   A socket close usually means the access token expired → we invalidate the
   cached token so the next (backed-off) attempt re-mints. See RECON.md / the
   beta flag (X_ENABLED) in config.
   ─────────────────────────────────────────────────────────────────────────── */

/** Burst guard: drop chat frames above this rate (per ingester). Beta safety net. */
const MAX_MSGS_PER_SEC = 60;

export class XIngester extends BaseIngester {
  readonly platform: Platform = "x";

  /** The pscp.tv broadcast id (parsed out of a URL if the user pasted one). */
  private readonly broadcastId: string;
  private readonly access: XAccessManager;
  private readonly subscribeFrameOverride?: string;
  private ws?: WebSocket;
  /** Attempt token: bumped on every (re)connect/disconnect to ignore stale async work. */
  private seq = 0;

  // Burst guard window.
  private windowStart = 0;
  private inWindow = 0;

  constructor(
    channel: string,
    cfg: AppConfig,
    log: Logger,
    events: IngesterEvents,
    access: XAccessManager,
  ) {
    super(channel, cfg.reconnect, log, events);
    this.broadcastId = parseBroadcastId(channel) ?? channel;
    this.access = access;
    this.subscribeFrameOverride = cfg.x.subscribeFrame || undefined;
  }

  protected doConnect(): void {
    const my = ++this.seq;
    this.access
      .get(this.broadcastId)
      .then((access) => {
        if (my === this.seq) this.openChat(access);
      })
      .catch((err: { message?: string }) => {
        if (my !== this.seq) return;
        const detail = err?.message || String(err);
        // Surface a clean error, then back off (BaseIngester handles the retry).
        this.onError(detail);
        this.onClosed(detail);
      });
  }

  protected doDisconnect(): void {
    // Bump seq so any in-flight get()/connect for this attempt is ignored.
    this.seq++;
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

  private openChat(access: XAccess): void {
    this.ws = connectChat({
      wsUrl: access.chatWsUrl,
      accessToken: access.accessToken,
      broadcastId: this.broadcastId,
      subscribeFrameOverride: this.subscribeFrameOverride,
      onOpen: () => this.onConnected(),
      onMessage: (raw) => this.handleFrame(raw),
      onError: (e) => this.onError(e.message),
      onClose: (code) => {
        // A close often means the token expired — drop it so the next attempt re-mints.
        this.access.invalidate(this.broadcastId);
        this.onClosed(`x socket closed (${code})`);
      },
    });
  }

  private handleFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // non-JSON / control frame
    }
    const msg = normalizeXMessage(parsed as RawXMessage, this.broadcastId);
    if (!msg) return; // hearts / joins / DMs / acks — ignored, never crash
    if (this.overBurstLimit()) return;
    this.emit(msg);
  }

  /** Simple per-second cap so a misbehaving/unofficial source can't flood the feed. */
  private overBurstLimit(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    this.inWindow += 1;
    if (this.inWindow === MAX_MSGS_PER_SEC + 1) {
      this.log.warn(`x burst over ${MAX_MSGS_PER_SEC}/s — dropping excess (#${this.channel})`);
    }
    return this.inWindow > MAX_MSGS_PER_SEC;
  }
}
