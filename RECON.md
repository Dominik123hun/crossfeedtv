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

The X broadcast (ex-Periscope) chat protocol is **not** in the documented X API.
The ingester in [`src/ingesters/x.ts`](./src/ingesters/x.ts) ships with the
correct **structure** — `getAccess() → { chatWsUrl, accessToken }` then
`connectChat()` (open socket → subscribe → parse) — and every unknown value as a
clearly named `TODO_X_*` constant. Your job is to capture the real values and
either edit those constants or set the matching env vars. **Nothing here is a
real endpoint or token.**

### Step A — open a live broadcast with DevTools recording

1. In Chrome, open a **currently-live** broadcast on `x.com` (a Space/broadcast
   with chat). Keep the tab focused so chat loads.
2. Open DevTools (`F12`) **before/at** load → **Network** → enable **Preserve log**.

### Step B — find the chat WebSocket (→ `chatWsUrl`)

1. **Network** → **WS** filter.
2. Look for a socket that is clearly chat (not analytics): its **Messages** tab
   shows a steady stream of chat-shaped frames as people type.
3. Copy its full `wss://…` URL → this is **`chatWsUrl`** (`X_CHAT_WS_URL`).

### Step C — find the access XHR just before it (→ `accessToken` + URL)

1. In **Network**, sort by time and look at the **XHR/Fetch** requests that fire
   **immediately before** that WS opens. One of them grants chat access.
2. Open it → **Response/Preview**. You're looking for a JSON body containing:
   - a **socket/endpoint URL** field → maps to `chatWsUrl`
   - an **access token** field → maps to `accessToken`
3. Note its **Request URL** (→ `X_ACCESS_URL`, with the broadcast id swapped for
   `{broadcastId}`) and the **Authorization: Bearer …** request header
   (→ `X_AUTH_BEARER`).

### Step D — read the subscribe + message frames

1. Back on the WS **Messages** tab, find the **first client→server** frame after
   connect — that's the **subscribe** frame.
2. Find an incoming **chat** frame and note which fields hold the text, author,
   color, id, and timestamp (frames may be **double-encoded** — a JSON string
   inside a `payload`/`body` field; the normalizer already tries to unwrap one
   level).

### Step E — plug the values in

Fastest path (no code edit): set env vars and let the ingester skip `getAccess`:

| Captured (DevTools)             | Env var          | Used in       |
| ------------------------------- | ---------------- | ------------- |
| chat `wss://…` URL              | `X_CHAT_WS_URL`  | `x.ts`        |
| access token from the XHR body  | `X_ACCESS_TOKEN` | `x.ts`        |
| broadcast id (from the URL)     | `X_BROADCAST_ID` | `config`      |

Or let the backend fetch access itself:

| Captured (DevTools)                       | Env var         | Used in |
| ----------------------------------------- | --------------- | ------- |
| access XHR URL (id → `{broadcastId}`)     | `X_ACCESS_URL`  | `x.ts`  |
| `Authorization: Bearer …` request header  | `X_AUTH_BEARER` | `x.ts`  |

Then fine-tune these constants in [`src/ingesters/x.ts`](./src/ingesters/x.ts)
and [`src/ingesters/x-normalize.ts`](./src/ingesters/x-normalize.ts) to match the
exact response/frame shapes you saw:

| Constant                      | Meaning                                            |
| ----------------------------- | -------------------------------------------------- |
| `TODO_X_ACCESS_URL`           | access XHR URL (if not using `X_ACCESS_URL`)       |
| `TODO_X_ACCESS_WS_FIELD`      | response field holding the socket URL              |
| `TODO_X_ACCESS_TOKEN_FIELD`   | response field holding the access token            |
| `TODO_X_SUBSCRIBE_FRAME`      | the client→server subscribe frame shape            |
| `TODO_X_FIELD.*`              | chat-frame field names (text/author/color/id/ts)   |
