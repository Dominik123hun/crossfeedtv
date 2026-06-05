import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import WebSocket from "ws";
import type { AppConfig } from "../src/config";
import { Hub, type IngesterFactory } from "../src/hub";
import { logger, setLogLevel } from "../src/logger";
import { createServer, type AppServer } from "../src/server";
import { createStore, type Store } from "../src/store";
import type { Ingester, IngesterState } from "../src/ingesters/base";
import type { NormalizedMessage, Platform } from "../src/types";

setLogLevel("error"); // keep test output quiet

/**
 * A deterministic fake ingester used across the integration tests so the suite
 * never touches the real Twitch/Kick/X network. A shared "bus" lets tests drive
 * ingester state and emit chat on demand.
 */
class FakeIngester implements Ingester {
  constructor(
    readonly platform: Platform,
    readonly channel: string,
    private readonly events: {
      onMessage: (m: NormalizedMessage) => void;
      onState: (s: IngesterState, info?: string) => void;
    },
    private readonly bus: FakeBus,
  ) {}
  start(): void {
    this.bus.register(this.platform, this.channel, this.events);
    this.events.onState("connected");
  }
  stop(): void {
    this.bus.unregister(this.platform, this.channel);
    this.events.onState("stopped");
  }
}

export class FakeBus {
  private readonly handlers = new Map<
    string,
    { onMessage: (m: NormalizedMessage) => void; onState: (s: IngesterState, info?: string) => void }
  >();
  private key(p: Platform, c: string): string {
    return `${p}:${c.toLowerCase()}`;
  }
  register(p: Platform, c: string, h: { onMessage: (m: NormalizedMessage) => void; onState: (s: IngesterState, info?: string) => void }): void {
    this.handlers.set(this.key(p, c), h);
  }
  unregister(p: Platform, c: string): void {
    this.handlers.delete(this.key(p, c));
  }
  /** Emit a chat message as if it came from a real ingester for this channel. */
  emit(p: Platform, c: string, partial: Partial<NormalizedMessage> = {}): void {
    const h = this.handlers.get(this.key(p, c));
    if (!h) return;
    h.onMessage({
      id: randomBytes(6).toString("hex"),
      platform: p,
      channel: c.toLowerCase(),
      author: "tester",
      color: "#9146FF",
      badges: [],
      text: "hello",
      emotes: [],
      timestamp: Date.now(),
      ...partial,
    });
  }
  setState(p: Platform, c: string, state: IngesterState, info?: string): void {
    this.handlers.get(this.key(p, c))?.onState(state, info);
  }
}

function makeFakeFactories(bus: FakeBus): Partial<Record<Platform, IngesterFactory>> {
  const make =
    (platform: Platform): IngesterFactory =>
    (channel, _cfg, _log, events) =>
      new FakeIngester(platform, channel, events, bus);
  return { twitch: make("twitch"), kick: make("kick"), x: make("x") };
}

export interface TestServer {
  base: string;
  wsBase: string;
  port: number;
  store: Store;
  hub: Hub;
  bus: FakeBus;
  dataDir: string;
  close(): Promise<void>;
}

export interface TestServerOptions {
  sessionTtlMs?: number;
}

export async function startServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
  const cfg: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    publicDir: path.resolve(__dirname, "..", "public"),
    defaults: {},
    twitch: { wsUrl: "ws://unused", multiplex: true, maxChannelsPerConn: 50, joinsPerWindow: 18, joinWindowMs: 10000 },
    kick: { mode: "auto" as never, forcePusher: true, apiBase: "http://unused", pusherAppKey: "x", pusherCluster: "us2", pusherVersion: "8", readyTimeoutMs: 1000 } as never,
    x: { mode: "static", browserHeadless: true, tokenTtlMs: 60000 } as never,
    reconnect: { initialMs: 50, maxMs: 200, factor: 2, jitter: 0, connectTimeoutMs: 1000 },
    logLevel: "error",
    dataDir,
    sessionTtlMs: opts.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000,
    cookieSecure: false,
  };
  const bus = new FakeBus();
  const hub = new Hub(cfg, makeFakeFactories(bus));
  hub.start();
  const store = createStore(dataDir);
  const app: AppServer = createServer(hub, cfg, store);
  await app.listen();
  const port = app.port();
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    port,
    store,
    hub,
    bus,
    dataDir,
    async close() {
      try {
        hub.stop();
      } catch {
        /* ignore */
      }
      app.close();
      // Best-effort temp cleanup (only this test's throwaway dir).
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  raw: string;
}

export interface HttpOptions {
  cookie?: string;
  json?: unknown;
  /** Omit the CSRF header (X-Requested-With) to test the guard. */
  noCsrf?: boolean;
  /** Send a raw (possibly invalid) body instead of JSON. */
  rawBody?: string;
}

export function httpReq(
  base: string,
  method: string,
  pathName: string,
  opts: HttpOptions = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + pathName);
    const data = opts.rawBody ?? (opts.json !== undefined ? JSON.stringify(opts.json) : null);
    const headers: Record<string, string> = {};
    if (data !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(data));
    }
    if (method !== "GET" && !opts.noCsrf) headers["x-requested-with"] = "fetch";
    if (opts.cookie) headers["cookie"] = opts.cookie;
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            /* leave as string */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw });
        });
      },
    );
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

export function cookieOf(res: HttpResult): string {
  const sc = res.headers["set-cookie"];
  if (!sc || !sc.length) return "";
  return sc[0]!.split(";")[0]!;
}

/** Open a feed WS and collect frames; resolve a small API to await/inspect them. */
export interface FeedClient {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  waitForType(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  ofType(type: string): Array<Record<string, unknown>>;
  close(): void;
}

export function openFeed(wsBase: string, pathName: string): Promise<FeedClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + pathName);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => {
      try {
        frames.push(JSON.parse(d.toString()));
      } catch {
        /* ignore */
      }
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        frames,
        waitForType(type, timeoutMs = 1500) {
          return new Promise((res, rej) => {
            const existing = frames.find((f) => f.type === type);
            if (existing) return res(existing);
            const onMsg = (d: WebSocket.RawData) => {
              let f: Record<string, unknown>;
              try {
                f = JSON.parse(d.toString());
              } catch {
                return;
              }
              if (f.type === type) {
                ws.off("message", onMsg);
                clearTimeout(t);
                res(f);
              }
            };
            const t = setTimeout(() => {
              ws.off("message", onMsg);
              rej(new Error(`timeout waiting for frame type "${type}"`));
            }, timeoutMs);
            ws.on("message", onMsg);
          });
        },
        ofType(type) {
          return frames.filter((f) => f.type === type);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      }),
    );
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// silence unused import lint for logger (kept for potential debug toggling)
void logger;
