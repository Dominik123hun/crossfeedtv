import WebSocket from "ws";
import type { ReconnectConfig } from "../config";
import { mergeEmotes, type TwitchEmoteResolver } from "../emotes";
import type { Logger } from "../logger";
import type { Platform } from "../types";
import { BaseIngester, type IngesterEvents } from "./base";
import { parseIrcLine } from "./twitch-irc";
import { normalizeTwitchMessage } from "./twitch-normalize";

const DEFAULT_WS_URL = "wss://irc-ws.chat.twitch.tv:443";

/** Generate a fresh anonymous read-only login (justinfan<random>). */
function anonNick(): string {
  return `justinfan${Math.floor(Math.random() * 80000 + 10000)}`;
}

/**
 * Anonymous, read-only Twitch chat ingester.
 *
 * Lifecycle: open IRC-over-WebSocket -> CAP REQ tags/commands/membership ->
 * NICK justinfan<random> -> JOIN #channel -> parse PRIVMSG -> normalize -> emit.
 * No API key required. Reconnect/backoff is inherited from BaseIngester.
 */
export class TwitchIngester extends BaseIngester {
  readonly platform: Platform = "twitch";

  private ws?: WebSocket;
  private readonly wsUrl: string;

  constructor(
    channel: string,
    reconnectCfg: ReconnectConfig,
    log: Logger,
    events: IngesterEvents,
    wsUrl: string = DEFAULT_WS_URL,
    private readonly emotes?: TwitchEmoteResolver,
  ) {
    super(channel, reconnectCfg, log, events);
    this.wsUrl = wsUrl;
  }

  protected doConnect(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      // Handshake: request metadata capabilities, log in anonymously, join.
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n");
      ws.send(`NICK ${anonNick()}\r\n`);
      ws.send(`JOIN #${this.channel.toLowerCase()}\r\n`);
      this.onConnected();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      this.handlePayload(data.toString());
    });

    ws.on("error", (err: Error) => {
      this.onError(err.message);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.onClosed(`socket closed (${code}${reason?.length ? ` ${reason.toString()}` : ""})`);
    });
  }

  protected doDisconnect(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.removeAllListeners();
    try {
      ws.terminate();
    } catch {
      /* best effort */
    }
  }

  /** A single WS frame may contain several CRLF-delimited IRC lines. */
  private handlePayload(payload: string): void {
    for (const line of payload.split("\r\n")) {
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // Keep-alive: reply to PING immediately, preserving the token.
    if (line.startsWith("PING")) {
      this.send(line.replace("PING", "PONG"));
      return;
    }

    const msg = parseIrcLine(line);
    switch (msg.command) {
      case "PRIVMSG": {
        const normalized = normalizeTwitchMessage(msg, this.channel);
        if (normalized) {
          if (this.emotes) {
            const roomId = msg.tags["room-id"];
            if (roomId) this.emotes.warm(this.channel, roomId);
            normalized.emotes = mergeEmotes(
              normalized.emotes,
              this.emotes.match(this.channel, normalized.text),
            );
          }
          this.emit(normalized);
        }
        break;
      }
      case "ROOMSTATE":
        this.emotes?.warm(this.channel, msg.tags["room-id"]);
        break;
      case "RECONNECT":
        // Twitch asks clients to reconnect before maintenance.
        this.log.info("server requested RECONNECT");
        this.onClosed("server RECONNECT");
        break;
      case "NOTICE":
        this.log.debug(`NOTICE: ${msg.trailing ?? ""}`);
        break;
      default:
        // 001/002/353/366/CAP/JOIN/etc. — ignored for read-only chat.
        break;
    }
  }

  private send(raw: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(raw.endsWith("\r\n") ? raw : raw + "\r\n");
      } catch (err) {
        this.log.warn("send failed", err);
      }
    }
  }
}
