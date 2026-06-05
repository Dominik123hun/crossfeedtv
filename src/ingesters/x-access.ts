import type { XConfig, XMode } from "../config";
import type { Logger } from "../logger";
import {
  chatWsUrl,
  getChatAccess,
  getGuestToken,
  isAuthError,
  resolveBroadcast,
  type XApiOpts,
} from "./x-periscope";

/* ───────────────────────────────────────────────────────────────────────────
   X chat ACCESS layer — the scalable part of the design.

   Reading X broadcast chat needs a short-lived { chatWsUrl, accessToken }. The
   expensive, auth-hard, rate-limited work is minting/refreshing those tokens —
   so it's centralized here in ONE shared provider + manager, and every X chat
   ingester is just a cheap raw-WebSocket consumer of the result.

   Providers (pick via X_MODE):
     • static  — captured values (one broadcast)
     • http    — replicate the access XHR yourself
     • browser — optional Puppeteer token-minter: ONE logged-in browser session
                 mints tokens for MANY broadcasts → this is what scales to 20+

   Every X-specific value we don't know is a clearly-named TODO_X_* constant.
   Nothing here is fabricated as if it were real; unconfigured paths fail with a
   clear "see RECON.md" message and the ingester just backs off.
   ─────────────────────────────────────────────────────────────────────────── */

/** Real dynamic import that survives CommonJS down-leveling (for optional puppeteer). */
const dynamicImport: (spec: string) => Promise<any> = new Function(
  "spec",
  "return import(spec);",
) as (spec: string) => Promise<any>;

// TODO(recon): response field paths carrying the socket URL + token.
const TODO_X_ACCESS_WS_FIELD = "endpoint";
const TODO_X_ACCESS_TOKEN_FIELD = "access_token";
// TODO(recon): the live broadcast page URL pattern (browser mode).
const TODO_X_BROADCAST_URL = "https://x.com/i/broadcasts/{broadcastId}";
// TODO(recon): how to recognize the access XHR among page requests (browser mode).
const TODO_X_ACCESS_RESPONSE_MATCHER = /accessChat|chat.*access|broadcasts?.*access/i;

export interface XAccess {
  chatWsUrl: string;
  accessToken: string;
  /** Epoch ms after which the token should be re-minted. */
  expiresAt: number;
}

export interface XAccessProvider {
  readonly name: string;
  getAccess(broadcastId: string): Promise<XAccess>;
  close(): void;
}

/**
 * Shared across all X ingesters: caches access per broadcast, dedupes
 * concurrent requests, and re-mints lazily when forced/expired. The big win at
 * scale is the single shared provider — 20+ ingesters don't each authenticate.
 */
export class XAccessManager {
  private readonly cache = new Map<string, XAccess>();
  private readonly inflight = new Map<string, Promise<XAccess>>();

  constructor(
    private readonly provider: XAccessProvider,
    private readonly ttlMs: number,
    private readonly log: Logger,
  ) {}

  get mode(): string {
    return this.provider.name;
  }

  get(broadcastId: string): Promise<XAccess> {
    const cached = this.cache.get(broadcastId);
    if (cached && cached.expiresAt - Date.now() > 5000) return Promise.resolve(cached);

    const pending = this.inflight.get(broadcastId);
    if (pending) return pending;

    const p = (async () => {
      const access = await this.provider.getAccess(broadcastId);
      if (!access.expiresAt) access.expiresAt = Date.now() + this.ttlMs;
      this.cache.set(broadcastId, access);
      this.log.debug(`minted access for ${broadcastId} via ${this.provider.name}`);
      return access;
    })().finally(() => this.inflight.delete(broadcastId));

    this.inflight.set(broadcastId, p);
    return p;
  }

  /** Drop a cached token so the next get() re-mints (e.g. after an auth-related close). */
  invalidate(broadcastId: string): void {
    this.cache.delete(broadcastId);
  }

  close(): void {
    try {
      this.provider.close();
    } catch {
      /* ignore */
    }
    this.cache.clear();
    this.inflight.clear();
  }
}

// ── Providers ───────────────────────────────────────────────────────────────

/** Captured-from-DevTools values for a single broadcast. */
class StaticAccessProvider implements XAccessProvider {
  readonly name = "static";
  constructor(
    private readonly chatWsUrl: string,
    private readonly accessToken: string,
    private readonly ttlMs: number,
  ) {}
  async getAccess(): Promise<XAccess> {
    return {
      chatWsUrl: this.chatWsUrl,
      accessToken: this.accessToken,
      expiresAt: Date.now() + this.ttlMs,
    };
  }
  close(): void {}
}

/** Replicate the access XHR directly (you supply the endpoint + auth). */
class HttpAccessProvider implements XAccessProvider {
  readonly name = "http";
  constructor(
    private readonly cfg: XConfig,
    private readonly ttlMs: number,
    private readonly log: Logger,
  ) {}

  async getAccess(broadcastId: string): Promise<XAccess> {
    const template = this.cfg.accessUrl;
    if (!template) throw new Error("X http mode: X_ACCESS_URL not set (see RECON.md)");
    const url = template.replace("{broadcastId}", encodeURIComponent(broadcastId));

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.authBearer) headers["Authorization"] = `Bearer ${this.cfg.authBearer}`;
    if (this.cfg.csrfToken) headers["x-csrf-token"] = this.cfg.csrfToken;
    if (this.cfg.authTokenCookie && this.cfg.csrfToken) {
      headers["Cookie"] = `auth_token=${this.cfg.authTokenCookie}; ct0=${this.cfg.csrfToken}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`X access HTTP ${res.status} (see RECON.md)`);
    const json = (await res.json()) as Record<string, unknown>;
    return extractAccess(json, this.ttlMs);
  }
  close(): void {}
}

/**
 * Optional Puppeteer token-minter. One logged-in browser session mints tokens
 * for many broadcasts by opening each broadcast and capturing the access XHR's
 * response — letting the real web client handle auth, guest tokens, CSRF, and
 * token refresh. This is the path that scales to 20+ chats.
 *
 * Requires `puppeteer` installed (it ships transitively with @retconned/kick-js,
 * or `npm i puppeteer`). The X-specific URL/matcher/field names are TODO — fill
 * them from RECON.md. Until then it fails with a clear message.
 */
class BrowserAccessProvider implements XAccessProvider {
  readonly name = "browser";
  private browser?: any;
  private launching?: Promise<any>;

  constructor(
    private readonly cfg: XConfig,
    private readonly ttlMs: number,
    private readonly log: Logger,
  ) {}

  private async ensureBrowser(): Promise<any> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const mod = await dynamicImport("puppeteer").catch(() => {
        throw new Error("X browser mode needs puppeteer installed (`npm i puppeteer`)");
      });
      const puppeteer = mod?.default ?? mod;
      const browser = await puppeteer.launch({
        headless: this.cfg.browserHeadless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      // Authenticate via captured cookies. TODO(recon): confirm cookie domain/names.
      if (this.cfg.authTokenCookie && this.cfg.csrfToken) {
        const page = await browser.newPage();
        await page.setCookie(
          { name: "auth_token", value: this.cfg.authTokenCookie, domain: ".x.com", path: "/", httpOnly: true, secure: true },
          { name: "ct0", value: this.cfg.csrfToken, domain: ".x.com", path: "/", secure: true },
        );
        await page.close();
      } else {
        this.log.warn("X browser mode: no X_AUTH_TOKEN/X_CSRF set — most broadcasts need a login");
      }
      this.browser = browser;
      return browser;
    })();
    return this.launching;
  }

  async getAccess(broadcastId: string): Promise<XAccess> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    try {
      // Capture the access XHR the web client fires when opening the broadcast.
      const accessResponse = page.waitForResponse(
        (r: any) => TODO_X_ACCESS_RESPONSE_MATCHER.test(r.url()),
        { timeout: 20000 },
      );
      await page.goto(
        TODO_X_BROADCAST_URL.replace("{broadcastId}", encodeURIComponent(broadcastId)),
        { waitUntil: "domcontentloaded" },
      );
      const resp = await accessResponse;
      const json = (await resp.json()) as Record<string, unknown>;
      return extractAccess(json, this.ttlMs);
    } finally {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    const browser = this.browser;
    this.browser = undefined;
    this.launching = undefined;
    if (browser) browser.close().catch(() => {});
  }
}

/**
 * Default provider: the real public pscp.tv (Periscope) handshake — no login.
 * resolveBroadcast(id) → getChatAccess(chatToken) → { wss endpoint, access token }.
 * This is what makes a public X broadcast work out of the box (behind X_ENABLED).
 */
class PeriscopeAccessProvider implements XAccessProvider {
  readonly name = "periscope";
  /** One guest token serves resolution for ALL broadcasts; minted once, refreshed lazily. */
  private guestToken?: string;
  private guestMintedAt = 0;
  private static readonly GUEST_TTL_MS = 3 * 60 * 60 * 1000; // ~3h; refresh proactively

  constructor(
    private readonly cfg: XConfig,
    private readonly ttlMs: number,
    private readonly log: Logger,
  ) {}

  private opts(guestToken?: string): XApiOpts {
    return {
      xApiBase: this.cfg.apiBase,
      pscpApiBase: this.cfg.pscpBase,
      bearer: this.cfg.bearer,
      guestToken,
    };
  }

  private async ensureGuestToken(force = false): Promise<string> {
    if (this.cfg.guestToken) return this.cfg.guestToken; // manual override (env)
    const fresh = this.guestToken && Date.now() - this.guestMintedAt < PeriscopeAccessProvider.GUEST_TTL_MS;
    if (!force && fresh) return this.guestToken!;
    this.guestToken = await getGuestToken(this.opts());
    this.guestMintedAt = Date.now();
    this.log.debug("minted shared x guest token");
    return this.guestToken;
  }

  async getAccess(broadcastId: string): Promise<XAccess> {
    try {
      return await this.attempt(broadcastId, false);
    } catch (err) {
      // A stale/expired guest token shows up as 401/403 — refresh once and retry.
      if (isAuthError(err)) {
        this.log.warn("x guest auth rejected — refreshing guest token and retrying");
        return this.attempt(broadcastId, true);
      }
      throw err;
    }
  }

  private async attempt(broadcastId: string, forceGuest: boolean): Promise<XAccess> {
    const guestToken = await this.ensureGuestToken(forceGuest);
    const { chatToken } = await resolveBroadcast(broadcastId, this.opts(guestToken));
    const { endpoint, accessToken } = await getChatAccess(chatToken, this.opts());
    this.log.debug(`periscope access ok for ${broadcastId}`);
    return { chatWsUrl: chatWsUrl(endpoint), accessToken, expiresAt: Date.now() + this.ttlMs };
  }

  close(): void {}
}

/** Returned when nothing is configured — fails with actionable guidance. */
class UnconfiguredProvider implements XAccessProvider {
  readonly name = "unconfigured";
  async getAccess(): Promise<XAccess> {
    throw new Error(
      "X access not configured — set X_CHAT_WS_URL/X_ACCESS_TOKEN (static), " +
        "X_ACCESS_URL/X_AUTH_BEARER (http), or X_AUTH_TOKEN/X_CSRF with X_MODE=browser. See RECON.md.",
    );
  }
  close(): void {}
}

function extractAccess(json: Record<string, unknown>, ttlMs: number): XAccess {
  const chatWsUrl = String(json[TODO_X_ACCESS_WS_FIELD] ?? "");
  const accessToken = String(json[TODO_X_ACCESS_TOKEN_FIELD] ?? "");
  if (!chatWsUrl || !accessToken) {
    throw new Error("X access response missing ws/token fields — verify field names (see RECON.md)");
  }
  return { chatWsUrl, accessToken, expiresAt: Date.now() + ttlMs };
}

function resolveMode(cfg: XConfig): XMode {
  if (cfg.mode !== "auto") return cfg.mode;
  if (cfg.chatWsUrl && cfg.accessToken) return "static";
  if (cfg.accessUrl) return "http";
  if (cfg.authTokenCookie && cfg.csrfToken) return "browser";
  // Default: the real public Periscope handshake (no creds needed for public broadcasts).
  return "periscope";
}

export function createXAccessProvider(cfg: XConfig, log: Logger): XAccessProvider {
  const mode = resolveMode(cfg);
  switch (mode) {
    case "static":
      return cfg.chatWsUrl && cfg.accessToken
        ? new StaticAccessProvider(cfg.chatWsUrl, cfg.accessToken, cfg.tokenTtlMs)
        : new UnconfiguredProvider();
    case "http":
      return new HttpAccessProvider(cfg, cfg.tokenTtlMs, log);
    case "browser":
      return new BrowserAccessProvider(cfg, cfg.tokenTtlMs, log);
    case "periscope":
      return new PeriscopeAccessProvider(cfg, cfg.tokenTtlMs, log);
    default:
      return new PeriscopeAccessProvider(cfg, cfg.tokenTtlMs, log);
  }
}
