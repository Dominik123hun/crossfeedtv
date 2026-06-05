import type { IncomingMessage, ServerResponse } from "http";
import type { AppConfig } from "./config";
import type { Hub } from "./hub";
import type { Store, User, UserChannels } from "./store";
import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from "./types";
import {
  clearSessionCookie,
  currentUser,
  hashPassword,
  isSecureRequest,
  sessionIdFrom,
  setSessionCookie,
  verifyPassword,
} from "./auth";
import { logger } from "./logger";

const log = logger.child("api");
const MAX_BODY = 64 * 1024;

export interface ApiDeps {
  store: Store;
  hub: Hub;
  cfg: AppConfig;
}

export interface Api {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
}

export function createApi(deps: ApiDeps): Api {
  return { handle: (req, res, url) => route(req, res, url, deps) };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiDeps,
): Promise<void> {
  const { store, hub, cfg } = deps;
  const secure = isSecureRequest(req, cfg.cookieSecure);
  const method = req.method ?? "GET";
  const p = url.pathname;

  try {
    // CSRF guard: SameSite=Lax already stops cross-site cookies on these methods;
    // additionally require a header that a cross-site <form> post cannot set.
    if (method !== "GET" && !req.headers["x-requested-with"]) {
      return json(res, 403, { error: "Missing X-Requested-With header." });
    }

    if (p === "/api/signup" && method === "POST") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? "");
      if (!isEmail(email)) return json(res, 400, { error: "Enter a valid email address." });
      if (password.length < 8)
        return json(res, 400, { error: "Password must be at least 8 characters." });
      if (store.getUserByEmail(email))
        return json(res, 409, { error: "That email is already registered. Try logging in." });
      const { hash, salt } = hashPassword(password);
      const user = store.createUser(email, hash, salt);
      startSession(res, store, user.id, cfg, secure);
      log.info(`signup ${email}`);
      return json(res, 200, { user: publicUser(user) });
    }

    if (p === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? "");
      const user = store.getUserByEmail(email);
      if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
        return json(res, 401, { error: "Incorrect email or password." });
      }
      startSession(res, store, user.id, cfg, secure);
      log.info(`login ${email}`);
      return json(res, 200, { user: publicUser(user) });
    }

    if (p === "/api/logout" && method === "POST") {
      const sid = sessionIdFrom(req);
      if (sid) store.deleteSession(sid);
      clearSessionCookie(res, secure);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/me" && method === "GET") {
      const user = currentUser(req, store);
      if (!user) return json(res, 401, { error: "Not authenticated." });
      return json(res, 200, { user: publicUser(user) });
    }

    if (p === "/api/channels" && method === "PUT") {
      const user = currentUser(req, store);
      if (!user) return json(res, 401, { error: "Not authenticated." });
      const body = await readJson(req);
      const channels: UserChannels = {
        twitch: sanitizeChannel(body.twitch),
        kick: sanitizeChannel(body.kick),
        x: sanitizeChannel(body.x),
      };
      const updated = store.updateChannels(user.id, channels) ?? user;
      hub.resubscribe(user.id, updated.channels);
      return json(res, 200, { user: publicUser(updated) });
    }

    if (p === "/api/settings" && method === "PUT") {
      const user = currentUser(req, store);
      if (!user) return json(res, 401, { error: "Not authenticated." });
      const body = await readJson(req);
      const settings = sanitizeSettings(body, user.settings ?? DEFAULT_OVERLAY_SETTINGS);
      const updated = store.updateSettings(user.id, settings) ?? user;
      hub.pushSettings(user.id, settings);
      return json(res, 200, { user: publicUser(updated) });
    }

    if (p === "/api/test" && method === "POST") {
      const user = currentUser(req, store);
      if (!user) return json(res, 401, { error: "Not authenticated." });
      const started = hub.triggerTestForUser(user.id);
      if (!started) return json(res, 429, { error: "A test is already running — give it a moment." });
      return json(res, 200, { ok: true });
    }

    if (p === "/api/token/rotate" && method === "POST") {
      const user = currentUser(req, store);
      if (!user) return json(res, 401, { error: "Not authenticated." });
      const updated = store.rotateToken(user.id) ?? user;
      return json(res, 200, { user: publicUser(updated) });
    }

    if (p === "/api/account" && method === "DELETE") {
      const user = currentUser(req, store);
      if (!user) return json(res, 401, { error: "Not authenticated." });
      hub.disconnectUser(user.id);
      store.deleteUser(user.id);
      clearSessionCookie(res, secure);
      log.info(`account deleted ${user.email}`);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "Not found." });
  } catch (err) {
    if (err instanceof Error && err.message === "body too large") {
      // Close the connection: the (rejected) request body may still be draining.
      res.writeHead(413, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      res.end('{"error":"Request too large."}');
      return;
    }
    if (err instanceof Error && err.message === "invalid json") {
      return json(res, 400, { error: "Invalid JSON." });
    }
    log.warn("api error", err);
    return json(res, 500, { error: "Something went wrong." });
  }
}

function startSession(
  res: ServerResponse,
  store: Store,
  userId: string,
  cfg: AppConfig,
  secure: boolean,
): void {
  const session = store.createSession(userId, cfg.sessionTtlMs);
  setSessionCookie(res, session.id, cfg.sessionTtlMs, secure);
}

/** Shape returned to the client — never includes the password hash/salt. */
function publicUser(user: User): {
  email: string;
  channels: UserChannels;
  token: string;
  overlayPath: string;
  settings: OverlaySettings;
} {
  return {
    email: user.email,
    channels: user.channels,
    token: user.token,
    overlayPath: `/overlay?token=${user.token}`,
    settings: user.settings ?? DEFAULT_OVERLAY_SETTINGS,
  };
}

/** Validate/clamp overlay settings, falling back to the user's current values. */
function sanitizeSettings(body: Record<string, unknown>, current: OverlaySettings): OverlaySettings {
  const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const positions = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;
  const pos = positions.includes(body.position as never)
    ? (body.position as OverlaySettings["position"])
    : current.position;
  const show = (body.show ?? {}) as Record<string, unknown>;
  const showBool = (key: keyof OverlaySettings["show"]): boolean =>
    typeof show[key] === "boolean" ? (show[key] as boolean) : current.show[key];
  return {
    fontSize: Math.round(num(body.fontSize, 8, 96, current.fontSize)),
    bgOpacity: num(body.bgOpacity, 0, 1, current.bgOpacity),
    position: pos,
    show: { twitch: showBool("twitch"), kick: showBool("kick"), x: showBool("x") },
    statusIndicator:
      typeof body.statusIndicator === "boolean" ? body.statusIndicator : current.statusIndicator,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return; // stop buffering, but let the stream drain so we can still respond
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        reject(new Error("body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (over) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

/** Sanitize a channel/handle: strip a leading # or @, keep safe chars, or undefined. */
function sanitizeChannel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/^[#@]+/, "").slice(0, 80);
  if (!cleaned) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(cleaned) ? cleaned : undefined;
}
