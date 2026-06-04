import * as path from "path";
import type { LogLevel } from "./logger";

export interface ReconnectConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Jitter as a fraction of the computed delay (0.3 = +/-30%). */
  jitter: number;
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

export interface AppConfig {
  host: string;
  port: number;
  publicDir: string;
  defaults: { twitch?: string; kick?: string; x?: string };
  twitchWsUrl: string;
  kick: KickConfig;
  reconnect: ReconnectConfig;
  logLevel: LogLevel;
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
    twitchWsUrl: str(process.env.TWITCH_WS_URL) ?? "wss://irc-ws.chat.twitch.tv:443",
    kick: {
      forcePusher: bool(process.env.KICK_FORCE_PUSHER),
      apiBase: str(process.env.KICK_API_BASE) ?? "https://kick.com",
      pusherAppKey: str(process.env.KICK_PUSHER_APP_KEY) ?? DEFAULT_KICK_PUSHER_APP_KEY,
      pusherCluster: str(process.env.KICK_PUSHER_CLUSTER) ?? DEFAULT_KICK_PUSHER_CLUSTER,
      pusherVersion: str(process.env.KICK_PUSHER_VERSION) ?? "8.4.0",
      readyTimeoutMs: int(process.env.KICK_READY_TIMEOUT_MS, 20000),
    },
    reconnect: {
      initialMs: int(process.env.RECONNECT_INITIAL_MS, 1000),
      maxMs: int(process.env.RECONNECT_MAX_MS, 30000),
      factor: int(process.env.RECONNECT_FACTOR, 2),
      jitter: float(process.env.RECONNECT_JITTER, 0.3),
    },
    logLevel: (str(process.env.LOG_LEVEL) as LogLevel) ?? "info",
  };
}
