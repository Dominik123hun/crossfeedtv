import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { Platform } from "../types";
import { BaseIngester, type IngesterEvents } from "./base";
import { normalizeXMessage, type RawXMessage } from "./x-normalize";
import { parseBroadcastId } from "./x-periscope";

/* ───────────────────────────────────────────────────────────────────────────
   X broadcast chat via a REAL headless browser (option #1).

   Instead of replicating X's locked-down API with fetch (which gets fingerprinted
   and 404'd), we drive a headless Chromium that loads the actual broadcast page.
   X's own JavaScript performs the guest/auth handshake and opens the chat
   WebSocket; we attach a CDP session and read the chat frames straight off the
   wire (Network.webSocketFrameReceived), then reuse normalizeXMessage.

   This passes the bot checks raw requests fail, and it needs no token plumbing.
   Tradeoffs: heavy (Chromium), and it should run where X isn't IP-blocking you
   (a residential box / your machine), not necessarily a datacenter. Enabled with
   X_MODE=browser; requires puppeteer (`npm i puppeteer`). Optional X_AUTH_TOKEN/
   X_CSRF cookies cover gated broadcasts.
   ─────────────────────────────────────────────────────────────────────────── */

/** Real dynamic import that survives CommonJS down-leveling (optional puppeteer). */
const dynamicImport: (spec: string) => Promise<any> = new Function(
  "spec",
  "return import(spec);",
) as (spec: string) => Promise<any>;

/** Drop chat frames above this rate per ingester (beta safety net). */
const MAX_MSGS_PER_SEC = 60;

// One shared Chromium for the whole process; each ingester owns one page (scales).
let sharedBrowser: any;
let launching: Promise<any> | undefined;

async function getBrowser(cfg: AppConfig, log: Logger): Promise<any> {
  if (sharedBrowser) return sharedBrowser;
  if (launching) return launching;
  launching = (async () => {
    const mod = await dynamicImport("puppeteer").catch(() => {
      throw new Error("X browser mode needs puppeteer installed (`npm i puppeteer`)");
    });
    const puppeteer = mod?.default ?? mod;
    const browser = await puppeteer.launch({
      headless: cfg.x.browserHeadless,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    browser.on("disconnected", () => {
      if (sharedBrowser === browser) sharedBrowser = undefined;
    });
    sharedBrowser = browser;
    log.info("launched shared X headless browser");
    return browser;
  })().finally(() => {
    launching = undefined;
  });
  return launching;
}

/** Close the shared browser on shutdown. */
export function closeSharedXBrowser(): void {
  const b = sharedBrowser;
  sharedBrowser = undefined;
  if (b) {
    try {
      b.close().catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

export class XBrowserIngester extends BaseIngester {
  readonly platform: Platform = "x";

  private readonly broadcastId: string;
  private readonly cfg: AppConfig;
  private page?: any;
  /** Bumped on every (re)connect/disconnect to ignore stale async work. */
  private seq = 0;
  private windowStart = 0;
  private inWindow = 0;

  constructor(channel: string, cfg: AppConfig, log: Logger, events: IngesterEvents) {
    super(channel, cfg.reconnect, log, events);
    this.cfg = cfg;
    this.broadcastId = parseBroadcastId(channel) ?? channel;
  }

  protected doConnect(): void {
    const my = ++this.seq;
    this.launch(my).catch((err: { message?: string }) => {
      if (my !== this.seq) return;
      const detail = err?.message || String(err);
      this.onError(detail);
      this.onClosed(detail);
    });
  }

  private async launch(my: number): Promise<void> {
    const browser = await getBrowser(this.cfg, this.log);
    if (my !== this.seq) return;
    const page = await browser.newPage();
    if (my !== this.seq) {
      page.close().catch(() => {});
      return;
    }
    this.page = page;

    // We only want the chat socket — don't download the broadcast video/images.
    try {
      await page.setRequestInterception(true);
      page.on("request", (req: any) => {
        const t = req.resourceType();
        if (t === "media" || t === "image" || t === "font") req.abort().catch(() => {});
        else req.continue().catch(() => {});
      });
    } catch {
      /* interception is an optimization; ignore if unavailable */
    }

    // Optional logged-in session (gated broadcasts). Public broadcasts need none.
    if (this.cfg.x.authTokenCookie && this.cfg.x.csrfToken) {
      try {
        await page.setCookie(
          { name: "auth_token", value: this.cfg.x.authTokenCookie, domain: ".x.com", path: "/", httpOnly: true, secure: true },
          { name: "ct0", value: this.cfg.x.csrfToken, domain: ".x.com", path: "/", secure: true },
        );
      } catch {
        /* ignore */
      }
    }

    const cdp = await page.target().createCDPSession();
    await cdp.send("Network.enable");
    let connected = false;
    const markConnected = (): void => {
      if (!connected && my === this.seq) {
        connected = true;
        this.onConnected();
      }
    };

    cdp.on("Network.webSocketCreated", (e: { url?: string }) => {
      if (/chat|periscope|pscp/i.test(e?.url || "")) markConnected();
    });
    cdp.on("Network.webSocketFrameReceived", (e: { response?: { payloadData?: string } }) => {
      if (my !== this.seq) return;
      const raw = e?.response?.payloadData;
      if (!raw) return;
      markConnected(); // frames flowing == we're live
      this.handleFrame(raw);
    });

    page.on("close", () => {
      if (my === this.seq) this.onClosed("page closed");
    });

    // If the broadcast is offline / no chat socket appears, the BaseIngester
    // connect watchdog forces a backed-off retry.
    await page.goto(`https://x.com/i/broadcasts/${encodeURIComponent(this.broadcastId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }

  protected doDisconnect(): void {
    this.seq++;
    const page = this.page;
    this.page = undefined;
    if (page) {
      try {
        page.removeAllListeners?.();
        page.close().catch(() => {});
      } catch {
        /* best effort */
      }
    }
  }

  private handleFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // control/binary frame
    }
    const msg = normalizeXMessage(parsed as RawXMessage, this.broadcastId);
    if (!msg) return; // non-chat frame
    if (this.overBurstLimit()) return;
    this.emit(msg);
  }

  private overBurstLimit(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    this.inWindow += 1;
    return this.inWindow > MAX_MSGS_PER_SEC;
  }
}
