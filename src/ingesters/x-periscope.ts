import WebSocket from "ws";

/* ───────────────────────────────────────────────────────────────────────────
   X (Twitter) broadcast chat — the real pscp.tv (Periscope) handshake.

   X has NO official broadcast-chat API; broadcasts still run on the legacy
   Periscope backend. The three steps below replicate what x.com's web player
   does for a PUBLIC broadcast (no login):

     1. resolveBroadcast(id)      GET  accessVideoPublic  → chat_token
     2. getChatAccess(chatToken)  GET  accessChatPublic   → { endpoint, access_token }
     3. connectChat({ wsUrl, accessToken, broadcastId })  → open WS, send auth+join

   Endpoints, field names, the wss path, and the auth/join frame shapes below are
   VERIFIED against:
     • IgnatBeresnev/periscope-chat-downloader  (accessVideoPublic→chat_token,
       accessChatPublic→{endpoint, access_token})
     • jferas/ScopeSpeaker                       (live wss path + auth/join frames)
   Anything still unconfirmed is a clearly named TODO(recon); see RECON.md.
   ─────────────────────────────────────────────────────────────────────────── */

/** Public Periscope API base (verified: periscope-chat-downloader). Overridable via X_API_BASE. */
export const PSCP_API_BASE = "https://proxsee.pscp.tv/api/v2";

/** Verified response field names (periscope-chat-downloader DTO @SerialName). */
const FIELD_CHAT_TOKEN = "chat_token";
const FIELD_ENDPOINT = "endpoint";
const FIELD_ACCESS_TOKEN = "access_token";

/** Live chat path appended to the access `endpoint`, then https→wss (ScopeSpeaker). */
const CHAT_WS_PATH = "/chatapi/v1/chatnow";

export interface PeriscopeOpts {
  /** Override the API base (X_API_BASE). */
  apiBase?: string;
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * TODO(recon): some non-public broadcasts require a guest/auth token. The
   * PUBLIC path needs none; when set we forward it as a bearer. Confirm the
   * exact header/param from DevTools for gated broadcasts (see RECON.md).
   */
  guestToken?: string;
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
  // Bare id: no slash, no scheme.
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

async function getJson(
  url: string,
  opts: PeriscopeOpts,
  what: string,
): Promise<Record<string, unknown>> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  // TODO(recon): confirm the exact auth header for gated broadcasts.
  if (opts.guestToken) headers["authorization"] = `Bearer ${opts.guestToken}`;
  const res = await f(url, { headers, signal: opts.signal });
  if (!res.ok) {
    throw new Error(`${what} HTTP ${res.status} (broadcast offline/not public? see RECON.md)`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Step 1: resolve a broadcast by id → its chat token. */
export async function resolveBroadcast(
  broadcastId: string,
  opts: PeriscopeOpts = {},
): Promise<BroadcastInfo> {
  const base = opts.apiBase ?? PSCP_API_BASE;
  const url = `${base}/accessVideoPublic?broadcast_id=${encodeURIComponent(broadcastId)}&replay_redirect=false`;
  const json = await getJson(url, opts, "accessVideoPublic");
  const chatToken = typeof json[FIELD_CHAT_TOKEN] === "string" ? (json[FIELD_CHAT_TOKEN] as string) : "";
  if (!chatToken) throw new Error("accessVideoPublic: no chat_token in response (see RECON.md)");
  return { chatToken };
}

/** Step 2: exchange the chat token for the chat socket endpoint + access token. */
export async function getChatAccess(chatToken: string, opts: PeriscopeOpts = {}): Promise<ChatAccess> {
  const base = opts.apiBase ?? PSCP_API_BASE;
  const url = `${base}/accessChatPublic?chat_token=${encodeURIComponent(chatToken)}`;
  const json = await getJson(url, opts, "accessChatPublic");
  const endpoint = typeof json[FIELD_ENDPOINT] === "string" ? (json[FIELD_ENDPOINT] as string) : "";
  const accessToken = typeof json[FIELD_ACCESS_TOKEN] === "string" ? (json[FIELD_ACCESS_TOKEN] as string) : "";
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

/**
 * First frame after the socket opens — authorize with the access token.
 * Shape verified against ScopeSpeaker: { kind:3, payload:"<json string>" }.
 */
export function buildAuthFrame(accessToken: string): string {
  return JSON.stringify({ kind: 3, payload: JSON.stringify({ access_token: accessToken }) });
}

/**
 * Second frame — join the broadcast's chat room. ScopeSpeaker sends
 * { kind:2, payload: stringify({ kind:1, body: stringify({ room:<id> }) }) }.
 */
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
  /** Optional single-frame override (X_SUBSCRIBE_FRAME) instead of auth+join. */
  subscribeFrameOverride?: string;
  onOpen?: () => void;
  onMessage?: (raw: string) => void;
  onError?: (err: Error) => void;
  onClose?: (code: number) => void;
}

/**
 * Step 3: open the chat WebSocket and perform the on-open handshake. Returns the
 * socket so the caller (XIngester) owns its lifecycle. Pure transport — parsing
 * happens in x-normalize.
 */
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
