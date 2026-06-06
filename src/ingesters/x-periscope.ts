import WebSocket from "ws";

/* ───────────────────────────────────────────────────────────────────────────
   X (Twitter) broadcast chat — modern resolution + the Periscope chat socket.

   X has NO official broadcast-chat API. A current x.com broadcast resolves like
   the web/guest clients do (verified against offish/twitter-x-broadcast-downloader
   for the resolve host, and periscope-chat-downloader + ScopeSpeaker for chat):

     0. getGuestToken()           POST api.x.com/1.1/guest/activate.json   -> guest_token
     1. resolveBroadcast(id)      GET  api.x.com/1.1/broadcasts/show.json  -> chat_token
                                       ?ids=<id>&include_events=true (bearer + x-guest-token)
     2. getChatAccess(chatToken)  GET  proxsee.pscp.tv/.../accessChatPublic -> { endpoint, access_token }
     3. connectChat({...})        wss://{endpoint}/chatapi/v1/chatnow, send auth+join

   The legacy public `accessVideoPublic` path 404s for modern broadcasts — that's
   why resolution goes through api.x.com with a guest token. Values that still
   need a live capture to confirm are marked TODO(recon); see RECON.md.
   ─────────────────────────────────────────────────────────────────────────── */

/** x.com API base for broadcast resolution (broadcasts/show.json). Override: X_API_BASE. */
export const X_API_BASE = "https://api.x.com/1.1";
/** Guest-token host — activate.json has long lived on api.twitter.com. Override: X_GUEST_API_BASE. */
export const GUEST_API_BASE = "https://api.twitter.com/1.1";
/** Periscope API base for chat access. Override: X_PSCP_BASE. */
export const PSCP_API_BASE = "https://proxsee.pscp.tv/api/v2";

/**
 * Public web "guest" bearer shipped by x.com's web client (NOT a secret, not
 * user-specific — the same token guest API clients like yt-dlp/snscrape use).
 * TODO(recon): X may rotate it; override with X_BEARER if guest auth starts 401ing.
 */
const DEFAULT_WEB_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/** Live chat path appended to the access `endpoint`, then https→wss (ScopeSpeaker). */
const CHAT_WS_PATH = "/chatapi/v1/chatnow";

export interface XApiOpts {
  /** api.x.com base for broadcasts/show. */
  xApiBase?: string;
  /** Host for the guest-token activate.json (api.twitter.com). */
  guestApiBase?: string;
  /** Periscope base for accessChatPublic. */
  pscpApiBase?: string;
  /** Web bearer (override X_BEARER). */
  bearer?: string;
  /** A pre-minted guest token (skips activate.json when provided). */
  guestToken?: string;
  /** Logged-in session: the `auth_token` cookie (X_AUTH_TOKEN). */
  authToken?: string;
  /** Logged-in session: the `ct0` CSRF cookie (X_CSRF). */
  csrf?: string;
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface BroadcastInfo {
  chatToken: string;
}
export interface ChatAccess {
  endpoint: string;
  accessToken: string;
}

/**
 * Parse a broadcast id out of an x.com/i/broadcasts/{id} URL (or twitter.com /
 * pscp.tv variants), or accept a bare id. Returns undefined if nothing valid.
 */
export function parseBroadcastId(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;
  if (!s.includes("/") && !s.includes(":") && !/\s/.test(s)) return cleanId(s);
  try {
    const url = new URL(s.includes("://") ? s : `https://${s}`);
    const m = url.pathname.match(/broadcasts\/([^/?#]+)/i);
    if (m) return cleanId(m[1]!);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length) return cleanId(parts[parts.length - 1]!);
  } catch {
    /* not a URL */
  }
  return undefined;
}

function cleanId(id: string): string | undefined {
  const c = id.trim();
  return /^[A-Za-z0-9_-]{4,}$/.test(c) ? c : undefined;
}

/** Step 0: mint a guest token from the public bearer (best-effort; deprecated endpoint). */
export async function getGuestToken(opts: XApiOpts = {}): Promise<string> {
  const base = opts.guestApiBase ?? GUEST_API_BASE;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${base}/guest/activate.json`, {
    method: "POST",
    headers: { authorization: opts.bearer ?? DEFAULT_WEB_BEARER },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`guest/activate HTTP ${res.status} (bearer rotated? see RECON.md)`);
  const json = (await res.json()) as Record<string, unknown>;
  const token = typeof json["guest_token"] === "string" ? (json["guest_token"] as string) : "";
  if (!token) throw new Error("guest/activate: no guest_token in response (see RECON.md)");
  return token;
}

/**
 * Step 1: resolve a broadcast id → its chat token. Sends a guest token only if
 * one is supplied (it's optional/best-effort — see the provider); the public
 * bearer alone is enough for many public broadcasts.
 */
export async function resolveBroadcast(broadcastId: string, opts: XApiOpts = {}): Promise<BroadcastInfo> {
  const base = opts.xApiBase ?? X_API_BASE;
  const url = `${base}/broadcasts/show.json?ids=${encodeURIComponent(broadcastId)}&include_events=true`;
  const f = opts.fetchImpl ?? fetch;
  // broadcasts/show.json is PUBLIC — the reference client (offish) hits it with no
  // auth at all, and an unexpected bearer makes it 404. So send a bare request by
  // default; only authenticate when a logged-in session (cookies) or guest token
  // is explicitly supplied, for gated broadcasts.
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.authToken && opts.csrf) {
    headers["authorization"] = opts.bearer ?? DEFAULT_WEB_BEARER;
    headers["x-csrf-token"] = opts.csrf;
    headers["cookie"] = `auth_token=${opts.authToken}; ct0=${opts.csrf}`;
  } else if (opts.guestToken) {
    headers["authorization"] = opts.bearer ?? DEFAULT_WEB_BEARER;
    headers["x-guest-token"] = opts.guestToken;
  }
  const res = await f(url, { headers, signal: opts.signal });
  if (!res.ok) {
    const hint = opts.authToken
      ? "auth invalid/expired or broadcast offline"
      : "broadcast offline/not public, or gated (try X_AUTH_TOKEN/X_CSRF)";
    throw new Error(`broadcasts/show HTTP ${res.status} (${hint} — see RECON.md)`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const chatToken = extractChatToken(json, broadcastId);
  if (!chatToken) throw new Error("broadcasts/show: no chat_token found (confirm the field — see RECON.md)");
  return { chatToken };
}

/** TODO(recon): exact location of chat_token in broadcasts/show.json — search defensively. */
function extractChatToken(json: Record<string, unknown>, id: string): string {
  const broadcasts = json["broadcasts"];
  if (broadcasts && typeof broadcasts === "object") {
    const b = (broadcasts as Record<string, unknown>)[id];
    const t = b && typeof b === "object" ? (b as Record<string, unknown>)["chat_token"] : undefined;
    if (typeof t === "string" && t) return t;
  }
  if (typeof json["chat_token"] === "string" && json["chat_token"]) return json["chat_token"] as string;
  return deepFindString(json, "chat_token") ?? "";
}

function deepFindString(obj: unknown, key: string, depth = 0): string | undefined {
  if (depth > 6 || obj == null || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key && typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const found = deepFindString(v, key, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Step 2: exchange the chat token for the chat socket endpoint + access token. */
export async function getChatAccess(chatToken: string, opts: XApiOpts = {}): Promise<ChatAccess> {
  const base = opts.pscpApiBase ?? PSCP_API_BASE;
  const url = `${base}/accessChatPublic?chat_token=${encodeURIComponent(chatToken)}`;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, { headers: { accept: "application/json" }, signal: opts.signal });
  if (!res.ok) throw new Error(`accessChatPublic HTTP ${res.status} (see RECON.md)`);
  const json = (await res.json()) as Record<string, unknown>;
  const endpoint = typeof json["endpoint"] === "string" ? (json["endpoint"] as string) : "";
  const accessToken = typeof json["access_token"] === "string" ? (json["access_token"] as string) : "";
  if (!endpoint || !accessToken) {
    throw new Error("accessChatPublic: missing endpoint/access_token (see RECON.md)");
  }
  return { endpoint, accessToken };
}

/** Build the live chat WebSocket URL from the access `endpoint` (ScopeSpeaker). */
export function chatWsUrl(endpoint: string): string {
  let url = endpoint.replace(/\/+$/, "") + CHAT_WS_PATH;
  if (url.startsWith("https:")) url = "wss:" + url.slice("https:".length);
  else if (url.startsWith("http:")) url = "ws:" + url.slice("http:".length);
  return url;
}

/** First frame after open — authorize with the access token (ScopeSpeaker: kind 3). */
export function buildAuthFrame(accessToken: string): string {
  return JSON.stringify({ kind: 3, payload: JSON.stringify({ access_token: accessToken }) });
}

/** Second frame — join the broadcast's chat room (ScopeSpeaker: kind 2). */
export function buildJoinFrame(broadcastId: string): string {
  return JSON.stringify({
    kind: 2,
    payload: JSON.stringify({ kind: 1, body: JSON.stringify({ room: broadcastId }) }),
  });
}

export interface ChatConn {
  wsUrl: string;
  accessToken: string;
  broadcastId: string;
  subscribeFrameOverride?: string;
  onOpen?: () => void;
  onMessage?: (raw: string) => void;
  onError?: (err: Error) => void;
  onClose?: (code: number) => void;
}

/** Step 3: open the chat WebSocket and perform the on-open handshake. */
export function connectChat(conn: ChatConn): WebSocket {
  const ws = new WebSocket(conn.wsUrl);
  ws.on("open", () => {
    try {
      if (conn.subscribeFrameOverride) {
        ws.send(conn.subscribeFrameOverride);
      } else {
        ws.send(buildAuthFrame(conn.accessToken));
        ws.send(buildJoinFrame(conn.broadcastId));
      }
    } catch {
      /* socket may have closed between open and send */
    }
    conn.onOpen?.();
  });
  ws.on("message", (data: WebSocket.RawData) => conn.onMessage?.(data.toString()));
  ws.on("error", (err: Error) => conn.onError?.(err));
  ws.on("close", (code: number) => conn.onClose?.(code));
  return ws;
}
