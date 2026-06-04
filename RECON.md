# RECON — capturing the unofficial Kick & X values

Twitch is fully documented and needs nothing here. **Kick** and **X broadcasts**
use undocumented endpoints. This guide shows how to capture the real values from
Chrome DevTools and where to plug them in.

General DevTools setup (used for both):

1. Open Chrome → `F12` (DevTools) → **Network** tab.
2. Click the **WS** filter to show only WebSocket connections.
3. Check **Preserve log** so frames survive navigations.
4. Load the page, then watch the requests appear.

---

## Kick

The backend prefers the `@retconned/kick-js` library and falls back to a
built-in **Pusher** adapter. The Pusher adapter needs two things: the
**chatroom id** for the channel and the **Pusher app key/cluster**. Defaults
ship in [`.env.example`](./.env.example); capture fresh values if Kick changes
them or Cloudflare blocks your server.

### 1. Chatroom id

The backend looks this up automatically at
`https://kick.com/api/v2/channels/<slug>` (see
[`src/ingesters/kick-lookup.ts`](./src/ingesters/kick-lookup.ts)). Cloudflare
sometimes blocks datacenter IPs with a `403`/`503`. To grab the id by hand:

1. Visit `https://kick.com/<channel>` while it's **live**.
2. DevTools → **Network** → filter `channels`.
3. Open the `…/api/v2/channels/<channel>` request → **Response** (or **Preview**).
4. Find `chatroom.id` (e.g. `chatroom: { id: 123456, … }`).

That number is the chatroom id. The Pusher channel the adapter subscribes to is
`chatrooms.<chatroomId>.v2`.

> If Cloudflare blocks your server, run the backend somewhere it's allowed, put a
> proxy in front via `KICK_API_BASE`, or hard-pin the id (see TODO in
> `kick-lookup.ts`).

### 2. Pusher app key / cluster

1. On the live channel page, DevTools → **Network** → **WS** filter.
2. Find the socket to `wss://ws-<cluster>.pusher.com/app/<APP_KEY>?...`.
3. Read the values straight out of the URL:
   - `<cluster>` is in the host, e.g. `ws-us2.pusher.com` → cluster `us2`.
   - `<APP_KEY>` is the path segment after `/app/`.
4. Click the socket → **Messages** tab to confirm the protocol:
   - A `pusher:connection_established` frame on connect.
   - You send `pusher:subscribe` with `{ channel: "chatrooms.<id>.v2" }`.
   - Chat arrives as `App\Events\ChatMessageEvent` frames whose `data` is a
     JSON **string** (the message object the normalizer parses).

Map the captured values to env vars:

| Captured                         | Env var                | Used in                  |
| -------------------------------- | ---------------------- | ------------------------ |
| `ws-<cluster>.pusher.com`        | `KICK_PUSHER_CLUSTER`  | `kick.ts` socket URL     |
| `/app/<APP_KEY>`                 | `KICK_PUSHER_APP_KEY`  | `kick.ts` socket URL     |
| `version=<n>` in the socket URL  | `KICK_PUSHER_VERSION`  | `kick.ts` socket URL     |
| `chatroom.id` from the v2 API    | (looked up at runtime) | `kick-lookup.ts`         |

---

## X (Twitter) broadcasts

> The X broadcast (ex-Periscope) chat protocol is **not** in the documented X
> API. The ingester in [`src/ingesters/x.ts`](./src/ingesters/x.ts) ships with
> the correct STRUCTURE and every unknown value as a clearly named `TODO_`
> constant. Capture the real values here and fill them in (or set the matching
> env vars). _This section is finalized in build step 3._
