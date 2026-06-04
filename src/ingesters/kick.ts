import WebSocket from "ws";
import type { AppConfig, KickConfig } from "../config";
import type { Logger } from "../logger";
import type { Platform } from "../types";
import { BaseIngester, type IngesterEvents } from "./base";
import { lookupKickChatroom } from "./kick-lookup";
import { normalizeKickMessage, type RawKickMessage } from "./kick-normalize";

/**
 * A genuine dynamic import that survives TypeScript's CommonJS down-leveling
 * (which would otherwise rewrite `import()` to `require()` and choke on an
 * ESM-only package). Lets us load the OPTIONAL @retconned/kick-js at runtime
 * without making it a hard dependency.
 */
const dynamicImport: (spec: string) => Promise<any> = new Function(
  "spec",
  "return import(spec);",
) as (spec: string) => Promise<any>;

/** Kick's Pusher chat event name (literal backslashes). */
const CHAT_EVENT = "App\\Events\\ChatMessageEvent";

/**
 * Kick chat ingester.
 *
 * PRIMARY: @retconned/kick-js in readOnly mode — it handles the Cloudflare
 *   chatroom-id lookup and Pusher socket for us.
 * FALLBACK: a structured Pusher-WebSocket adapter (channel/chatroom lookup
 *   isolated in kick-lookup.ts). If the library is missing, errors, or never
 *   reaches "ready", we permanently switch this ingester to the fallback and
 *   let BaseIngester's backoff drive the retry.
 */
export class KickIngester extends BaseIngester {
  readonly platform: Platform = "kick";

  private readonly kickCfg: KickConfig;
  private usePusher: boolean;

  // Library transport handles
  private libClient?: any;
  private libReadyTimer?: ReturnType<typeof setTimeout>;
  // Pusher transport handles
  private ws?: WebSocket;
  private chatroomChannel?: string;
  // Guards exactly one terminal outcome per connect attempt.
  private settled = false;

  constructor(channel: string, cfg: AppConfig, log: Logger, events: IngesterEvents) {
    super(channel, cfg.reconnect, log, events);
    this.kickCfg = cfg.kick;
    this.usePusher = cfg.kick.forcePusher;
  }

  protected doConnect(): void {
    this.settled = false;
    if (this.usePusher) this.connectPusher();
    else this.connectLibrary();
  }

  protected doDisconnect(): void {
    if (this.libReadyTimer) {
      clearTimeout(this.libReadyTimer);
      this.libReadyTimer = undefined;
    }
    const client = this.libClient;
    this.libClient = undefined;
    if (client) {
      try {
        client.removeAllListeners?.();
      } catch {
        /* kick-js has no documented close; drop refs and let reconnect handle it */
      }
    }
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

  /** Funnel a terminal failure into BaseIngester's reconnect path exactly once. */
  private fail(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.onClosed(reason);
  }

  // --- Primary: @retconned/kick-js -----------------------------------------

  private connectLibrary(): void {
    this.log.info("trying @retconned/kick-js (readOnly)…");
    dynamicImport("@retconned/kick-js")
      .then((mod) => {
        const createClient = mod?.createClient ?? mod?.default?.createClient;
        if (typeof createClient !== "function") {
          this.switchToPusher("kick-js has no createClient export");
          return;
        }
        const client = createClient(this.channel.toLowerCase(), {
          readOnly: true,
          logger: false,
        });
        this.libClient = client;
        this.libReadyTimer = setTimeout(
          () => this.switchToPusher("kick-js did not reach ready in time"),
          this.kickCfg.readyTimeoutMs,
        );
        client.on?.("ready", () => {
          if (this.libReadyTimer) {
            clearTimeout(this.libReadyTimer);
            this.libReadyTimer = undefined;
          }
          this.onConnected();
        });
        client.on?.("ChatMessage", (m: RawKickMessage) => {
          const normalized = normalizeKickMessage(m, this.channel);
          if (normalized) this.emit(normalized);
        });
        client.on?.("error", (e: unknown) => this.switchToPusher(`kick-js error: ${String(e)}`));
      })
      .catch((err: { code?: string; message?: string }) => {
        this.switchToPusher(`kick-js unavailable (${err?.code || err?.message || err})`);
      });
  }

  /** After the library path fails once, prefer the Pusher fallback from now on. */
  private switchToPusher(reason: string): void {
    if (this.settled) return;
    this.log.warn(`falling back to Pusher adapter: ${reason}`);
    this.usePusher = true;
    this.fail(reason);
  }

  // --- Fallback: structured Pusher adapter ---------------------------------

  private connectPusher(): void {
    const { apiBase, pusherAppKey, pusherCluster, pusherVersion } = this.kickCfg;
    lookupKickChatroom(this.channel, apiBase)
      .then((info) => {
        if (this.settled) return;
        this.chatroomChannel = info.chatroomChannel;
        const url =
          `wss://ws-${pusherCluster}.pusher.com/app/${pusherAppKey}` +
          `?protocol=7&client=js&version=${pusherVersion}&flash=false`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.on("message", (data: WebSocket.RawData) => this.handlePusher(data.toString()));
        ws.on("error", (e: Error) => this.onError(e.message));
        ws.on("close", (code: number) => this.fail(`pusher socket closed (${code})`));
      })
      .catch((err: { message?: string }) =>
        this.fail(`kick chatroom lookup failed: ${err?.message || err}`),
      );
  }

  private handlePusher(raw: string): void {
    let frame: { event?: string; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    switch (frame.event) {
      case "pusher:connection_established":
        // Subscribe to the public chatroom channel (no auth required).
        this.send(
          JSON.stringify({
            event: "pusher:subscribe",
            data: { auth: "", channel: this.chatroomChannel },
          }),
        );
        this.onConnected();
        break;
      case "pusher:ping":
        this.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        break;
      case CHAT_EVENT: {
        const payload = typeof frame.data === "string" ? safeJson(frame.data) : frame.data;
        const normalized = normalizeKickMessage(payload as RawKickMessage, this.channel);
        if (normalized) this.emit(normalized);
        break;
      }
      default:
        break;
    }
  }

  private send(raw: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(raw);
      } catch (err) {
        this.log.warn("send failed", err);
      }
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
