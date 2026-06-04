import type { ReconnectConfig } from "../config";
import type { Logger } from "../logger";
import type { NormalizedMessage, Platform } from "../types";

export type IngesterState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "stopped";

export interface IngesterEvents {
  onMessage?: (msg: NormalizedMessage) => void;
  onState?: (state: IngesterState, info?: string) => void;
}

/**
 * Shared lifecycle for every platform ingester:
 *
 *   connect -> handshake -> parse -> normalize -> emit -> auto-reconnect (backoff)
 *
 * Subclasses implement only the transport (`doConnect` / `doDisconnect`) and
 * call the protected hooks (`onConnected`, `emit`, `onError`, `onClosed`) as
 * their socket/library reports events. This base class owns the reconnect
 * state machine with exponential backoff + jitter.
 *
 * ISOLATION GUARANTEE: every callback into user code is wrapped in try/catch,
 * and connect exceptions are funneled into the reconnect path. A single
 * ingester can never throw out into the Hub and take down the other sources.
 */
export abstract class BaseIngester {
  abstract readonly platform: Platform;
  readonly channel: string;

  protected readonly log: Logger;

  private readonly reconnectCfg: ReconnectConfig;
  private readonly events: IngesterEvents;

  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private _state: IngesterState = "idle";

  constructor(
    channel: string,
    reconnectCfg: ReconnectConfig,
    log: Logger,
    events: IngesterEvents = {},
  ) {
    this.channel = channel;
    this.reconnectCfg = reconnectCfg;
    this.log = log;
    this.events = events;
  }

  get state(): IngesterState {
    return this._state;
  }

  get key(): string {
    return `${this.platform}:${this.channel.toLowerCase()}`;
  }

  /** Begin the lifecycle. Safe to call once; no-op if already running. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.openConnection();
  }

  /** Permanently stop. Cancels any pending reconnect and tears down the transport. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.safeDisconnect();
    this.setState("stopped");
  }

  // --- Subclass transport hooks -------------------------------------------

  /** Open the underlying socket/library and wire its events to the hooks below. */
  protected abstract doConnect(): void;

  /** Close the underlying socket/library. Must be idempotent and never throw upward. */
  protected abstract doDisconnect(): void;

  // --- Hooks the subclass calls -------------------------------------------

  /** Call once the connection + handshake succeeded. */
  protected onConnected(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.setState("connected");
    this.log.info(`connected (#${this.channel})`);
  }

  /** Emit a normalized message to the Hub. */
  protected emit(msg: NormalizedMessage): void {
    try {
      this.events.onMessage?.(msg);
    } catch (err) {
      this.log.warn("onMessage handler threw", err);
    }
  }

  /** Report a transport error. Usually followed by `onClosed`. */
  protected onError(info: string): void {
    if (this.stopped) return;
    this.setState("error", info);
    this.log.warn(`error: ${info}`);
  }

  /** Report that the transport closed; schedules a reconnect unless stopped. */
  protected onClosed(info?: string): void {
    if (this.stopped) return;
    this.safeDisconnect();
    this.scheduleReconnect(info);
  }

  // --- Internals -----------------------------------------------------------

  private openConnection(): void {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    try {
      this.doConnect();
    } catch (err) {
      this.log.warn("connect threw", err);
      this.scheduleReconnect("connect exception");
    }
  }

  private scheduleReconnect(info?: string): void {
    if (this.stopped) return;
    this.attempt += 1;
    const { initialMs, maxMs, factor, jitter } = this.reconnectCfg;
    const base = Math.min(maxMs, initialMs * Math.pow(factor, this.attempt - 1));
    const delta = (Math.random() * 2 - 1) * jitter * base;
    const wait = Math.max(0, Math.round(base + delta));
    this.setState(
      "reconnecting",
      `attempt ${this.attempt}, retry in ${wait}ms${info ? ` (${info})` : ""}`,
    );
    this.log.info(`reconnecting in ${wait}ms (attempt ${this.attempt})${info ? ` after ${info}` : ""}`);
    this.timer = setTimeout(() => this.openConnection(), wait);
  }

  private safeDisconnect(): void {
    try {
      this.doDisconnect();
    } catch (err) {
      this.log.warn("disconnect error (ignored)", err);
    }
  }

  private setState(state: IngesterState, info?: string): void {
    this._state = state;
    try {
      this.events.onState?.(state, info);
    } catch (err) {
      this.log.warn("onState handler threw", err);
    }
  }
}
