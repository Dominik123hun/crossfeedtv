import WebSocket from "ws";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { Platform } from "../types";
import { BaseIngester, type IngesterEvents } from "./base";
import type { XAccess, XAccessManager } from "./x-access";
import { normalizeXMessage, type RawXMessage } from "./x-normalize";

/* ───────────────────────────────────────────────────────────────────────────
   X broadcast chat ingester — the cheap, scalable consumer.

   It does NOT authenticate itself. It asks the shared XAccessManager for
   { chatWsUrl, accessToken } (cached/minted/refreshed centrally), opens one raw
   WebSocket, sends a subscribe frame, and parses chat frames into the normalized
   schema. So 20+ X chats = 20+ light sockets sharing one token-minter.

   Token expiry shows up as a socket close; we invalidate the cached token so the
   next (backed-off) attempt re-mints. The subscribe frame shape is UNKNOWN —
   TODO_X_SUBSCRIBE_FRAME (overridable via X_SUBSCRIBE_FRAME). See RECON.md.
   ─────────────────────────────────────────────────────────────────────────── */

// TODO(recon): the frame the client sends to subscribe after connecting.
// {token}/{broadcastId} are substituted. UNKNOWN shape.
const TODO_X_SUBSCRIBE_FRAME =
  '{"kind":1,"payload":{"access_token":"{token}","room":"{broadcastId}"}}';

export class XIngester extends BaseIngester {
  readonly platform: Platform = "x";

  private readonly broadcastId: string;
  private readonly access: XAccessManager;
  private readonly subscribeFrame: string;
  private ws?: WebSocket;
  /** Attempt token: bumped on every (re)connect/disconnect to ignore stale async work. */
  private seq = 0;

  constructor(
    broadcastId: string,
    cfg: AppConfig,
    log: Logger,
    events: IngesterEvents,
    access: XAccessManager,
  ) {
    super(broadcastId, cfg.reconnect, log, events);
    this.broadcastId = broadcastId;
    this.access = access;
    this.subscribeFrame = cfg.x.subscribeFrame || TODO_X_SUBSCRIBE_FRAME;
  }

  protected doConnect(): void {
    const my = ++this.seq;
    this.access
      .get(this.broadcastId)
      .then((access) => {
        if (my === this.seq) this.connectChat(access);
      })
      .catch((err: { message?: string }) => {
        if (my === this.seq) this.onClosed(err?.message || String(err));
      });
  }

  protected doDisconnect(): void {
    // Bump seq so any in-flight getAccess/connect for this attempt is ignored.
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

  private connectChat(access: XAccess): void {
    const ws = new WebSocket(access.chatWsUrl);
    this.ws = ws;

    ws.on("open", () => {
      const frame = this.subscribeFrame
        .replace("{token}", access.accessToken)
        .replace("{broadcastId}", this.broadcastId);
      try {
        ws.send(frame);
      } catch {
        /* socket may have closed already */
      }
      this.onConnected();
    });

    ws.on("message", (data: WebSocket.RawData) => this.handleFrame(data.toString()));
    ws.on("error", (e: Error) => this.onError(e.message));
    ws.on("close", (code: number) => {
      // A close often means the token expired — drop it so the next attempt re-mints.
      this.access.invalidate(this.broadcastId);
      this.onClosed(`x socket closed (${code})`);
    });
  }

  private handleFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // TODO(recon): handle heartbeat/control frames if the protocol needs a pong.
    const msg = normalizeXMessage(parsed as RawXMessage, this.broadcastId);
    if (msg) this.emit(msg);
  }
}
