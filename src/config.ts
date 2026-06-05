import * as path from "path";
import type { LogLevel } from "./logger";

export interface ReconnectConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Jitter as a fraction of the computed delay (0.3 = +/-30%). */
  jitter: number;
  /** Force a reconnect if a connect doesn't reach "connected" within this long. */
  connectTimeoutMs: number;
}

export interface KickConfig {
  /** Skip the @retconned/kick-js library and go straight to the Pusher adapter. */
  forcePusher: boolean;
  /** Base URL for the Cloudflare-protected channel lookup API. */
  apiBase: string;
  /** Pusher app key for Kick's chat cluster (see RECON.md — verify if it breaks). */
  pusherAppKey: string;
  pusherCluster: string;
  pusherVersion: string;
  /** If the library doesn't reach "ready" in this long, fall back to Pusher. */
  readyTimeoutMs: number;
}

/**
 * How the shared X access provider mints { chatWsUrl, accessToken }:
 *   static  — use captured X_CHAT_WS_URL + X_ACCESS_TOKEN (one broadcast)
 *   http    — replicate the access XHR yourself (X_ACCESS_URL + auth)
 *   browser — optional Puppeteer token-minter (one session → many broadcasts);
 *             the scalable path for 20+ chats
 *   auto    — pick the first of the above that's configured
 */
export type XMode = "auto" | "static" | "http" | "browser";

export interface XConfig {
  mode: XMode;
  /** static: a chat socket URL captured directly from DevTools. */
  chatWsUrl?: string;
  /** static: an access token captured directly from DevTools. */
  accessToken?: string;
  /** http: XHR template that grants chat access; {broadcastId} is substituted. UNKNOWN — see RECON.md. */
  accessUrl?: string;
  /** http: bearer token for the access XHR. */
  authBearer?: string;
  /** http/browser: the `auth_token` cookie value (logged-in session). */
  authTokenCookie?: string;
  /** http/browser: the `ct0` CSRF cookie value. */
  csrfToken?: string;
  /** browser: run the token-minter headless. */
  browserHeadless: boolean;
  /** Override the (TODO) subscribe frame sent after the chat socket opens. */
  subscribeFrame?: string;
  /** Treat a minted token as valid for this long, then refresh. */
  tokenTtlMs: number;
}

export interface TwitchConfig {
  wsUrl: string;
  /** Multiplex many channels onto a few shared IRC connections (scales to many channels). */
  multiplex: boolean;
  /** Max channels JOINed per shared connection before opening another. */
  maxChannelsPerConn: number;
  /** JOIN rate limit per shared connection (Twitch allows ~20 / 10s). */
  joinsPerWindow: number;
  joinWindowMs: number;
}

export interface AppConfig {
  host: string;
  port: number;
  publicDir: string;
  defaults: { twitch?: string; kick?: string; x?: string };
  twitch: TwitchConfig;
  kick: KickConfig;
  x: XConfig;
  reconnect: ReconnectConfig;
  logLevel: LogLevel;
  /** Directory for the SaaS data store (users/sessions). */
  dataDir: string;
  /** Session lifetime in ms. */
  sessionTtlMs: number;
  /** Force/disable the Secure cookie flag; if undefined, inferred per-request. */
  cookieSecure?: boolean;
  /** Rate limiting for auth endpoints (signup/login), per client IP. */
  auth: { rateMax: number; rateWindowMs: number };
}

/**
 * Kick's public Pusher app key (cluster us2). This value is observed from the
 * browser, not documented, and can change — override via KICK_PUSHER_APP_KEY /
 * KICK_PUSHER_CLUSTER. See RECON.md for how to capture the current values.
 */
const DEFAULT_KICK_PUSHER_APP_KEY = "32cbd69e4b950bf97679";
const DEFAULT_KICK_PUSHER_CLUSTER = "us2";

/** Load a .env file if present (Node >= 20.6). Silently ignore if missing. */
function loadEnvFile(): void {
  try {
    const loader = (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
    loader?.();
  } catch {
    /* no .env file — that's fine, env vars are optional */
  }
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function float(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined): string | undefined {
  const s = (value ?? "").trim();
  return s.length ? s : undefined;
}

function bool(value: string | undefined): boolean {
  const s = (value ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  return {
    host: str(process.env.HOST) ?? "0.0.0.0",
    port: int(process.env.PORT, 8080),
    // ../public works from both ./src (tsx dev) and ./dist (compiled).
    publicDir: str(process.env.PUBLIC_DIR) ?? path.resolve(__dirname, "..", "public"),
    defaults: {
      twitch: str(process.env.TWITCH_CHANNEL),
      kick: str(process.env.KICK_CHANNEL),
      x: str(process.env.X_BROADCAST_ID),
    },
    twitch: {
      wsUrl: str(process.env.TWITCH_WS_URL) ?? "wss://irc-ws.chat.twitch.tv:443",
      multiplex: process.env.TWITCH_MULTIPLEX === undefined ? true : bool(process.env.TWITCH_MULTIPLEX),
      maxChannelsPerConn: int(process.env.TWITCH_MAX_CHANNELS_PER_CONN, 50),
      joinsPerWindow: int(process.env.TWITCH_JOINS_PER_WINDOW, 18),
      joinWindowMs: int(process.env.TWITCH_JOIN_WINDOW_MS, 10000),
    },
    kick: {
      forcePusher: bool(process.env.KICK_FORCE_PUSHER),
      apiBase: str(process.env.KICK_API_BASE) ?? "https://kick.com",
      pusherAppKey: str(process.env.KICK_PUSHER_APP_KEY) ?? DEFAULT_KICK_PUSHER_APP_KEY,
      pusherCluster: str(process.env.KICK_PUSHER_CLUSTER) ?? DEFAULT_KICK_PUSHER_CLUSTER,
      pusherVersion: str(process.env.KICK_PUSHER_VERSION) ?? "8.4.0",
      readyTimeoutMs: int(process.env.KICK_READY_TIMEOUT_MS, 20000),
    },
    x: {
      mode: (str(process.env.X_MODE) as XMode) ?? "auto",
      chatWsUrl: str(process.env.X_CHAT_WS_URL),
      accessToken: str(process.env.X_ACCESS_TOKEN),
      accessUrl: str(process.env.X_ACCESS_URL),
      authBearer: str(process.env.X_AUTH_BEARER),
      authTokenCookie: str(process.env.X_AUTH_TOKEN),
      csrfToken: str(process.env.X_CSRF),
      browserHeadless: process.env.X_BROWSER_HEADLESS === undefined ? true : bool(process.env.X_BROWSER_HEADLESS),
      subscribeFrame: str(process.env.X_SUBSCRIBE_FRAME),
      tokenTtlMs: int(process.env.X_TOKEN_TTL_MS, 240000),
    },
    reconnect: {
      initialMs: int(process.env.RECONNECT_INITIAL_MS, 1000),
      maxMs: int(process.env.RECONNECT_MAX_MS, 30000),
      factor: int(process.env.RECONNECT_FACTOR, 2),
      jitter: float(process.env.RECONNECT_JITTER, 0.3),
      connectTimeoutMs: int(process.env.RECONNECT_CONNECT_TIMEOUT_MS, 15000),
    },
    logLevel: (str(process.env.LOG_LEVEL) as LogLevel) ?? "info",
    dataDir: str(process.env.DATA_DIR) ?? path.resolve(__dirname, "..", "data"),
    sessionTtlMs: int(process.env.SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    cookieSecure:
      process.env.COOKIE_SECURE === undefined ? undefined : bool(process.env.COOKIE_SECURE),
    auth: {
      rateMax: int(process.env.AUTH_RATE_MAX, 20),
      rateWindowMs: int(process.env.AUTH_RATE_WINDOW_MS, 5 * 60 * 1000),
    },
  };
}
