import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer } from "ws";
import type { AppConfig } from "./config";
import type { Hub } from "./hub";
import { logger } from "./logger";

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
}

/**
 * Serves the static overlay over HTTP and exposes the fan-out WebSocket at
 * /feed. The overlay being same-origin means it can open the feed socket with
 * zero extra config.
 */
export function createServer(hub: Hub, cfg: AppConfig): AppServer {
  const log = logger.child("http");
  const resolvedRoot = path.resolve(cfg.publicDir);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hub.snapshot(), null, 2));
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/overlay.html";
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

  wss.on("connection", (ws, req) => hub.addClient(ws, req));

  return {
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(cfg.port, cfg.host, () => {
          log.info(`HTTP + WS listening on http://${cfg.host}:${cfg.port}`);
          log.info(`overlay: http://localhost:${cfg.port}/overlay.html?twitch=<channel>`);
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
