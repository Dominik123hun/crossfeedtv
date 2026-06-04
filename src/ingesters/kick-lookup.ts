/**
 * Kick channel -> chatroom-id lookup.
 *
 * This is the one piece of the Pusher fallback that touches Kick's
 * Cloudflare-protected, UNDOCUMENTED API. It is isolated behind this single
 * function so the rest of the adapter stays clean and testable.
 *
 * ── TODO / RECON (see RECON.md) ─────────────────────────────────────────────
 * The endpoint below is the publicly observed v2 channel API. Cloudflare may
 * answer with 403/503 from datacenter IPs (including most servers). If that
 * happens you have two options, documented in RECON.md:
 *   1. Run the backend somewhere Cloudflare allows, or front it with a proxy.
 *   2. Capture the chatroom id once from DevTools and pin it via env/config.
 * Verify the response shape (json.chatroom.id) hasn't changed if this breaks.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface KickChannelInfo {
  chatroomId: number;
  /** The Pusher channel name to subscribe to. */
  chatroomChannel: string;
}

const BROWSER_HEADERS: Record<string, string> = {
  // A browser-like UA reduces (but does not eliminate) Cloudflare blocks.
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

export async function lookupKickChatroom(
  slug: string,
  apiBase: string,
  timeoutMs = 10000,
): Promise<KickChannelInfo> {
  const url = `${apiBase.replace(/\/+$/, "")}/api/v2/channels/${encodeURIComponent(slug.toLowerCase())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`channel lookup HTTP ${res.status} (Cloudflare may be blocking; see RECON.md)`);
    }
    const json = (await res.json()) as { chatroom?: { id?: number } };
    const chatroomId = json?.chatroom?.id;
    if (typeof chatroomId !== "number") {
      throw new Error("channel lookup ok but chatroom.id missing (API shape changed? see RECON.md)");
    }
    return { chatroomId, chatroomChannel: `chatrooms.${chatroomId}.v2` };
  } finally {
    clearTimeout(timer);
  }
}
