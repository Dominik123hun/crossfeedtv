/**
 * Tiny dependency-free leveled logger with scoped child loggers.
 *
 *   const log = logger.child("twitch:xqc");
 *   log.info("connected");  // -> 2026-06-04T… INFO  [twitch:xqc] connected
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  if (level in ORDER) threshold = ORDER[level];
}

export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  child: (scope: string) => Logger;
}

function prefix(scope: string | undefined, level: LogLevel): string {
  const ts = new Date().toISOString();
  const lvl = level.toUpperCase().padEnd(5);
  return scope ? `${ts} ${lvl} [${scope}]` : `${ts} ${lvl}`;
}

function make(scope?: string): Logger {
  const emit = (level: LogLevel, args: unknown[]): void => {
    if (ORDER[level] > threshold) return;
    const line = prefix(scope, level);
    const sink =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    sink(line, ...args);
  };
  return {
    error: (...a) => emit("error", a),
    warn: (...a) => emit("warn", a),
    info: (...a) => emit("info", a),
    debug: (...a) => emit("debug", a),
    child: (s) => make(scope ? `${scope}:${s}` : s),
  };
}

export const logger: Logger = make();
