import type { IncomingMessage, ServerResponse } from "http";
import type { AppConfig } from "./config";
import type { EmailSender } from "./email";
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
import { RateLimiter } from "./rate-limit";
import { parseBroadcastId } from "./ingesters/x-periscope";

const log = logger.child("api");
const MAX_BODY = 64 * 1024;

/** Verification links stay valid for a day; password-reset links for an hour. */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/** Endpoints that are rate-limited per IP (brute force / spam mitigation). */
const RATE_LIMITED = new Set([
  "/api/signup",
  "/api/login",
  "/api/password/forgot",
  "/api/password/reset",
  "/api/verify/resend",
]);

export interface ApiDeps {
  store: Store;
  hub: Hub;
  cfg: AppConfig;
  email: EmailSender;
}

export interface Api {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
}

export function createApi(deps: ApiDeps): Api {
  // Per-IP rate limit for auth endpoints (brute-force / signup-spam mitigation).
  const authLimiter = new RateLimiter(deps.cfg.auth.rateMax, deps.cfg.auth.rateWindowMs);
  const prune = setInterval(() => authLimiter.prune(), 10 * 60 * 1000);
  prune.unref?.();
  return { handle: (req, res, url) => route(req, res, url, deps, authLimiter) };
}

/** Best-effort client IP (honors the proxy's X-Forwarded-For first hop). */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const fwd = Array.isArray(xff) ? xff[0] : xff;
  const first = (fwd ?? "").split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiDeps,
  authLimiter: RateLimiter,
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

    // Rate-limit auth attempts per IP (brute force / signup spam).
    if (RATE_LIMITED.has(p) && method === "POST") {
      if (!authLimiter.allow(clientIp(req))) {
        return json(res, 429, { error: "Too many attempts. Please wait a bit and try again." });
      }
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
      log.info(`signup ${email}`);
      await sendVerification(deps, req, user.id, email);
      if (cfg.requireEmailVerification) {
        // No session until they verify — the client shows a "check your email" state.
        return json(res, 200, { needsVerification: true, email });
      }
      startSession(res, store, user.id, cfg, secure);
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
      if (cfg.requireEmailVerification && !user.emailVerified) {
        return json(res, 403, {
          error: "Please verify your email first — check your inbox for the link.",
          needsVerification: true,
        });
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

    if (p === "/api/verify/resend" && method === "POST") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const user = store.getUserByEmail(email);
      if (user && !user.emailVerified) {
        await sendVerification(deps, req, user.id, user.email);
      }
      // Always 200 — never reveal whether an address is registered.
      return json(res, 200, { ok: true });
    }

    if (p === "/api/password/forgot" && method === "POST") {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const user = store.getUserByEmail(email);
      if (user) {
        const tok = store.createToken(user.id, "reset", RESET_TTL_MS);
        const link = `${baseUrl(req, cfg)}/reset?token=${tok.token}`;
        await deliver(deps, {
          to: user.email,
          subject: "Reset your Crossfeed password",
          text: `Reset your password with this link (valid for 1 hour):\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
          html: resetHtml(link),
        }, link);
      }
      return json(res, 200, { ok: true });
    }

    if (p === "/api/password/reset" && method === "POST") {
      const body = await readJson(req);
      const token = String(body.token ?? "").trim();
      const password = String(body.password ?? "");
      if (password.length < 8)
        return json(res, 400, { error: "Password must be at least 8 characters." });
      const userId = token ? store.useToken(token, "reset") : undefined;
      if (!userId) return json(res, 400, { error: "This reset link is invalid or has expired." });
      const { hash, salt } = hashPassword(password);
      store.updatePassword(userId, hash, salt);
      // A successful reset proves email ownership; verify and log out other sessions.
      store.setEmailVerified(userId, true);
      store.deleteSessionsForUser(userId);
      log.info(`password reset for user ${userId}`);
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
        // X accepts a bare broadcast id OR an x.com/i/broadcasts/<id> URL.
        x: parseBroadcastId(typeof body.x === "string" ? body.x : undefined),
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

/** Absolute base URL for links in emails — configured value wins, else the request's origin. */
function baseUrl(req: IncomingMessage, cfg: AppConfig): string {
  if (cfg.appBaseUrl) return cfg.appBaseUrl;
  const xf = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(xf) ? xf[0] : xf)?.split(",")[0]?.trim() || "http";
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

/** Mint a verification token and email the link. Never throws into the request. */
async function sendVerification(
  deps: ApiDeps,
  req: IncomingMessage,
  userId: string,
  email: string,
): Promise<void> {
  const tok = deps.store.createToken(userId, "verify", VERIFY_TTL_MS);
  const link = `${baseUrl(req, deps.cfg)}/verify?token=${tok.token}`;
  await deliver(
    deps,
    {
      to: email,
      subject: "Verify your Crossfeed email",
      text: `Welcome to Crossfeed! Confirm your email with this link (valid for 24 hours):\n\n${link}\n\nIf you didn't create this account, you can ignore this email.`,
      html: verifyHtml(link),
    },
    link,
  );
}

/** Send an email; on failure log the error and the link so it's never lost. */
async function deliver(deps: ApiDeps, msg: { to: string; subject: string; text: string; html?: string }, link: string): Promise<void> {
  try {
    await deps.email.send(msg);
  } catch (err) {
    log.warn(`email send failed (${deps.email.name}); link for ${msg.to}: ${link}`, err);
  }
}

function verifyHtml(link: string): string {
  return emailShell(
    "Verify your email",
    "Confirm your email address to finish setting up your Crossfeed account.",
    "Verify email",
    link,
  );
}

function resetHtml(link: string): string {
  return emailShell(
    "Reset your password",
    "Click below to choose a new password. This link is valid for one hour.",
    "Reset password",
    link,
  );
}

/** Minimal, inline-styled, dark email template (email clients ignore external CSS). */
function emailShell(heading: string, body: string, cta: string, link: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0a0a0c;padding:32px 16px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#f3f4f6">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:480px;background:#0f0f13;border:1px solid #232329;border-radius:12px;padding:28px">
      <tr><td style="font-size:18px;font-weight:700;letter-spacing:-0.01em;padding-bottom:6px">Crossfeed</td></tr>
      <tr><td style="font-size:20px;font-weight:700;padding:8px 0 6px">${heading}</td></tr>
      <tr><td style="font-size:15px;line-height:1.6;color:#a0a7b4;padding-bottom:22px">${body}</td></tr>
      <tr><td><a href="${link}" style="display:inline-block;background:#9146ff;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px">${cta}</a></td></tr>
      <tr><td style="font-size:12px;color:#7c8493;line-height:1.6;padding-top:22px;word-break:break-all">Or paste this link into your browser:<br/>${link}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/** Shape returned to the client — never includes the password hash/salt. */
function publicUser(user: User): {
  email: string;
  channels: UserChannels;
  token: string;
  overlayPath: string;
  settings: OverlaySettings;
  emailVerified: boolean;
} {
  return {
    email: user.email,
    channels: user.channels,
    token: user.token,
    overlayPath: `/overlay?token=${user.token}`,
    settings: user.settings ?? DEFAULT_OVERLAY_SETTINGS,
    emailVerified: user.emailVerified,
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
