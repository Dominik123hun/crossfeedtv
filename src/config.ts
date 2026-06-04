import * as path from "path";
import type { LogLevel } from "./logger";

export interface ReconnectConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Jitter as a fraction of the computed delay (0.3 = +/-30%). */
  jitter: number;
}

export interface AppConfig {
  host: string;
  port: number;
  publicDir: string;
  defaults: { twitch?: string; kick?: string; x?: string };
  twitchWsUrl: string;
  reconnect: ReconnectConfig;
  logLevel: LogLevel;
}

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
    reconnect: {
      initialMs: int(process.env.RECONNECT_INITIAL_MS, 1000),
      maxMs: int(process.env.RECONNECT_MAX_MS, 30000),
      factor: int(process.env.RECONNECT_FACTOR, 2),
      jitter: float(process.env.RECONNECT_JITTER, 0.3),
    },
    logLevel: (str(process.env.LOG_LEVEL) as LogLevel) ?? "info",
  };
}
