import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, type WebSocket } from "ws";
import { createApi } from "./api";
import type { AppConfig } from "./config";
import type { FeedSubscription, Hub } from "./hub";
import { logger } from "./logger";
import type { Store } from "./store";

/** Interval between liveness pings to connected overlay clients. */
const HEARTBEAT_MS = 30000;

type Heartbeatable = WebSocket & { isAlive?: boolean };

/** Clean URL → static HTML file. The functional overlay stays separate from the marketing/app pages. */
const PAGES: Record<string, string> = {
  "/": "/landing.html",
  "/overlay": "/overlay.html",
  "/dashboard": "/dashboard.html",
  "/login": "/auth.html",
  "/signup": "/auth.html",
};

/** Resolve which channels a /feed client should receive: by token (multi-tenant) or raw params (direct/demo). */
function resolveFeed(url: URL, store: Store): FeedSubscription {
  const token = (url.searchParams.get("token") ?? "").trim();
  if (token) {
    const user = store.getUserByToken(token);
    return user
      ? { channels: user.channels, userId: user.id, settings: user.settings }
      : { channels: {} };
  }
  const pick = (k: string): string | undefined => {
    const v = url.searchParams.get(k);
    return v && v.trim() ? v.trim() : undefined;
  };
  return { channels: { twitch: pick("twitch"), kick: pick("kick"), x: pick("x") } };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export interface AppServer {
  listen(): Promise<void>;
  close(): void;
  /** The actual bound TCP port (useful with port 0 / ephemeral ports in tests). */
  port(): number;
}

/**
 * Serves the static overlay over HTTP and exposes the fan-out WebSocket at
 * /feed. The overlay being same-origin means it can open the feed socket with
 * zero extra config.
 */
export function createServer(hub: Hub, cfg: AppConfig, store: Store): AppServer {
  const log = logger.child("http");
  const resolvedRoot = path.resolve(cfg.publicDir);
  const api = createApi({ store, hub, cfg });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      void api.handle(req, res, url).catch((err) => {
        log.warn("api handler rejected", err);
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"Something went wrong."}');
        } catch {
          /* response already sent */
        }
      });
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hub.snapshot(), null, 2));
      return;
    }

    const pathname = PAGES[url.pathname] ?? decodeURIComponent(url.pathname);
    serveStatic(resolvedRoot, pathname, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/feed") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws, req) => {
    // Heartbeat: mark alive on pong; the interval below reaps dead sockets.
    (ws as Heartbeatable).isAlive = true;
    ws.on("pong", () => {
      (ws as Heartbeatable).isAlive = true;
    });
    const url = new URL(req.url || "/", "http://localhost");
    hub.addClient(ws, resolveFeed(url, store));
  });

  // Ping every client periodically; terminate any that missed the last pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as Heartbeatable;
      if (w.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      w.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));

  return {
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(cfg.port, cfg.host, () => {
          log.info(`HTTP + WS listening on http://${cfg.host}:${cfg.port}`);
          log.info(`landing: http://localhost:${cfg.port}/  ·  dashboard: /dashboard  ·  overlay: /overlay?token=…`);
          resolve();
        });
      });
    },
    close() {
      try {
        wss.close();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
    port() {
      const addr = server.address();
      return addr && typeof addr === "object" ? addr.port : cfg.port;
    },
  };
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse): void {
  // Prevent path traversal: normalize then ensure the result stays under root.
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safe);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath)
      .on("error", () => res.end())
      .pipe(res);
  });
}
