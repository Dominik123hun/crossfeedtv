/* ───────────────────────────────────────────────────────────────────────────
   X handshake probe — verify the (beta, unofficial) Periscope chat handshake for
   one broadcast without enabling the feature or opening OBS.

     npm run x:probe -- <broadcastId | x.com/i/broadcasts/… URL>

   It runs guest-token → broadcasts/show.json → accessChatPublic and prints each
   step (or the exact failure + which step). Respects X_API_BASE / X_PSCP_BASE /
   X_BEARER / X_GUEST_TOKEN. This is the fastest way to confirm whether a broadcast
   is reachable and whether the chat_token field/host need a RECON.md tweak.
   ─────────────────────────────────────────────────────────────────────────── */
import { loadConfig } from "./config";
import {
  chatWsUrl,
  getChatAccess,
  getGuestToken,
  parseBroadcastId,
  resolveBroadcast,
  type XApiOpts,
} from "./ingesters/x-periscope";

const short = (s: string): string => (s.length > 10 ? s.slice(0, 8) + "…" : s);

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: npm run x:probe -- <broadcastId | x.com/i/broadcasts/… URL>");
    process.exit(1);
  }
  const id = parseBroadcastId(arg);
  if (!id) {
    console.error(`Could not parse a broadcast id from: ${arg}`);
    process.exit(1);
  }

  const x = loadConfig().x;
  const opts: XApiOpts = {
    xApiBase: x.apiBase,
    guestApiBase: x.guestApiBase,
    pscpApiBase: x.pscpBase,
    bearer: x.bearer,
    guestToken: x.guestToken,
    authToken: x.authTokenCookie,
    csrf: x.csrfToken,
  };
  const authed = !!(x.authTokenCookie && x.csrfToken);
  console.log(`auth mode: ${authed ? "logged-in (X_AUTH_TOKEN/X_CSRF)" : "anonymous (guest/bearer)"}`);

  console.log(`broadcast id: ${id}`);
  try {
    let guest = opts.guestToken ?? "";
    if (!authed && !guest) {
      // Anonymous: try the (deprecated, best-effort) guest token.
      try {
        guest = await getGuestToken(opts);
        console.log(`✓ guest token        ${short(guest)}`);
      } catch (e) {
        console.log(`· guest token        unavailable (${(e as Error).message}) — bearer-only`);
      }
    }
    const { chatToken } = await resolveBroadcast(id, { ...opts, guestToken: guest });
    console.log(`✓ chat_token         ${short(chatToken)}`);
    const { endpoint, accessToken } = await getChatAccess(chatToken, opts);
    console.log(`✓ chat endpoint      ${endpoint}`);
    console.log(`✓ access_token       ${short(accessToken)}`);
    console.log(`→ chat socket        ${chatWsUrl(endpoint)}`);
    console.log("\nHandshake OK ✓  (if live chat still doesn't flow, the WS auth/join frames are the last unknown — see RECON.md)");
  } catch (err) {
    console.error(`\n✗ FAILED: ${(err as Error).message}`);
    console.error("→ See RECON.md to capture/confirm the failing step in Chrome DevTools.");
    process.exit(2);
  }
}

void main();
