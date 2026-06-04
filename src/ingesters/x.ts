import WebSocket from "ws";
import type { AppConfig, XConfig } from "../config";
import type { Logger } from "../logger";
import type { Platform } from "../types";
import { BaseIngester, type IngesterEvents } from "./base";
import { normalizeXMessage, type RawXMessage } from "./x-normalize";

/* ───────────────────────────────────────────────────────────────────────────
   ⚠️  X (Twitter) BROADCAST CHAT IS UNDOCUMENTED (descendant of Periscope).
   Every constant marked TODO_X_* below is a PLACEHOLDER, not a real value — do
   NOT trust them. The STRUCTURE, however, mirrors the real flow:

        getAccess()  ->  { chatWsUrl, accessToken }
        connectChat() ->  open socket -> send subscribe frame -> parse frames
                          -> normalize -> emit

   To make this run for real: capture the values from DevTools per RECON.md and
   either edit the constants here, or (no code change) set the env vars:
        X_CHAT_WS_URL + X_ACCESS_TOKEN        (skip getAccess entirely), or
        X_ACCESS_URL  + X_AUTH_BEARER         (let getAccess fetch them).
   Until configured, this ingester stays in a clean "not configured" backoff
   loop and never affects the Twitch/Kick feeds.
   ─────────────────────────────────────────────────────────────────────────── */

// TODO(recon): the XHR that grants chat access. {broadcastId} is substituted.
// UNKNOWN — left empty so we never pretend to know it.
const TODO_X_ACCESS_URL = "";

// TODO(recon): response field paths carrying the socket URL + token.
const TODO_X_ACCESS_WS_FIELD = "endpoint";
const TODO_X_ACCESS_TOKEN_FIELD = "access_token";

// TODO(recon): the frame the client sends to subscribe after connecting.
// {token}/{broadcastId} are substituted. UNKNOWN shape.
const TODO_X_SUBSCRIBE_FRAME =
  '{"kind":1,"payload":{"access_token":"{token}","room":"{broadcastId}"}}';

interface XAccess {
  chatWsUrl: string;
  accessToken: string;
}

/**
 * X broadcast chat ingester — structured adapter with all unknowns isolated as
 * TODO constants / env overrides (see header). Fits the shared BaseIngester
 * lifecycle so reconnect/backoff and feed isolation come for free.
 */
export class XIngester extends BaseIngester {
  readonly platform: Platform = "x";

  private readonly xCfg: XConfig;
  private readonly broadcastId: string;
  private ws?: WebSocket;
  private settled = false;

  constructor(broadcastId: string, cfg: AppConfig, log: Logger, events: IngesterEvents) {
    super(broadcastId, cfg.reconnect, log, events);
    this.broadcastId = broadcastId;
    this.xCfg = cfg.x;
  }

  protected doConnect(): void {
    this.settled = false;
    this.getAccess()
      .then((access) => {
        if (!this.settled) this.connectChat(access);
      })
      .catch((err: { message?: string }) => this.fail(err?.message || String(err)));
  }

  protected doDisconnect(): void {
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

  private fail(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.onClosed(reason);
  }

  /** Step 1 — obtain { chatWsUrl, accessToken }. */
  private async getAccess(): Promise<XAccess> {
    // Fast path: values captured manually from DevTools and supplied via env.
    if (this.xCfg.chatWsUrl && this.xCfg.accessToken) {
      return { chatWsUrl: this.xCfg.chatWsUrl, accessToken: this.xCfg.accessToken };
    }

    const accessUrl = this.xCfg.accessUrl || TODO_X_ACCESS_URL;
    if (!accessUrl) {
      throw new Error(
        "X access not configured — endpoint unknown. Capture chatWsUrl + accessToken " +
          "from DevTools and set X_CHAT_WS_URL/X_ACCESS_TOKEN (or X_ACCESS_URL/X_AUTH_BEARER). " +
          "See RECON.md.",
      );
    }

    const url = accessUrl.replace("{broadcastId}", encodeURIComponent(this.broadcastId));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.xCfg.authBearer) headers["Authorization"] = `Bearer ${this.xCfg.authBearer}`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`X access HTTP ${res.status} (see RECON.md)`);
    const json = (await res.json()) as Record<string, unknown>;

    const chatWsUrl = String(json[TODO_X_ACCESS_WS_FIELD] ?? "");
    const accessToken = String(json[TODO_X_ACCESS_TOKEN_FIELD] ?? "");
    if (!chatWsUrl || !accessToken) {
      throw new Error(
        "X access response missing ws/token fields — verify field names (see RECON.md)",
      );
    }
    return { chatWsUrl, accessToken };
  }

  /** Step 2 — open the chat socket, subscribe, and parse frames. */
  private connectChat(access: XAccess): void {
    const ws = new WebSocket(access.chatWsUrl);
    this.ws = ws;

    ws.on("open", () => {
      const frame = TODO_X_SUBSCRIBE_FRAME.replace("{token}", access.accessToken).replace(
        "{broadcastId}",
        this.broadcastId,
      );
      try {
        ws.send(frame);
      } catch {
        /* socket may have closed already */
      }
      this.onConnected();
    });

    ws.on("message", (data: WebSocket.RawData) => this.handleFrame(data.toString()));
    ws.on("error", (e: Error) => this.onError(e.message));
    ws.on("close", (code: number) => this.fail(`x socket closed (${code})`));
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
