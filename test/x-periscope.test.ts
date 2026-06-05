import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBroadcastId,
  getGuestToken,
  resolveBroadcast,
  getChatAccess,
  chatWsUrl,
  buildAuthFrame,
  buildJoinFrame,
} from "../src/ingesters/x-periscope";
import { normalizeXMessage, sanitizeText } from "../src/ingesters/x-normalize";
import { XIngester } from "../src/ingesters/x";
import { XAccessManager, type XAccessProvider } from "../src/ingesters/x-access";
import type { AppConfig } from "../src/config";
import { logger, setLogLevel } from "../src/logger";
import type { IngesterState } from "../src/ingesters/base";

setLogLevel("error");

/** Build a fake fetch returning a JSON body (or a non-200) without touching the network. */
function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

/** Route a fake fetch by URL substring so the multi-step handshake can be tested offline. */
function route(
  map: Array<{ match: string; body: unknown; ok?: boolean; status?: number }>,
): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const hit = map.find((m) => u.includes(m.match));
    const ok = hit ? hit.ok !== false : false;
    return {
      ok,
      status: hit?.status ?? (ok ? 200 : 404),
      json: async () => hit?.body ?? {},
      text: async () => JSON.stringify(hit?.body ?? {}),
    };
  }) as unknown as typeof fetch;
}

const GUEST = { match: "guest/activate.json", body: { guest_token: "G1" } };

// ── URL → id parsing ─────────────────────────────────────────────────────────
test("parseBroadcastId extracts the id from URLs and bare ids", () => {
  assert.equal(parseBroadcastId("https://x.com/i/broadcasts/1ABCdef12345"), "1ABCdef12345");
  assert.equal(parseBroadcastId("x.com/i/broadcasts/1ABCdef12345"), "1ABCdef12345");
  assert.equal(parseBroadcastId("https://twitter.com/i/broadcasts/1ABCdef12345?foo=bar"), "1ABCdef12345");
  assert.equal(parseBroadcastId("1ABCdef12345"), "1ABCdef12345");
  assert.equal(parseBroadcastId("  1ABCdef12345  "), "1ABCdef12345");
  // Invalid / empty.
  assert.equal(parseBroadcastId(""), undefined);
  assert.equal(parseBroadcastId(undefined), undefined);
  assert.equal(parseBroadcastId("ab"), undefined); // too short
  assert.equal(parseBroadcastId("has spaces"), undefined);
});

// ── Handshake step 0 + 1 + 2 (with a routed fake fetch) ───────────────────────
test("getGuestToken posts to activate.json and returns the guest_token", async () => {
  const t = await getGuestToken({ fetchImpl: route([GUEST]) });
  assert.equal(t, "G1");
  await assert.rejects(
    () => getGuestToken({ fetchImpl: route([{ match: "guest/activate.json", body: {}, ok: false, status: 403 }]) }),
    /guest\/activate HTTP 403/,
  );
});

test("resolveBroadcast reads chat_token from broadcasts/show.json (bearer-only, no mint)", async () => {
  // No guest token needed — resolveBroadcast is a single call.
  const ok = await resolveBroadcast("BID", {
    fetchImpl: route([{ match: "broadcasts/show.json", body: { broadcasts: { BID: { chat_token: "CT123" } } } }]),
  });
  assert.equal(ok.chatToken, "CT123");

  // show.json non-200 -> throws
  await assert.rejects(
    () => resolveBroadcast("BID", { fetchImpl: route([{ match: "broadcasts/show.json", body: {}, ok: false, status: 404 }]) }),
    /broadcasts\/show HTTP 404/,
  );
  // present but no chat_token -> throws
  await assert.rejects(
    () => resolveBroadcast("BID", { fetchImpl: route([{ match: "broadcasts/show.json", body: { broadcasts: { BID: {} } } }]) }),
    /no chat_token/,
  );
  // top-level chat_token shape also works (defensive extractor).
  const ok2 = await resolveBroadcast("BID", {
    fetchImpl: route([{ match: "broadcasts/show.json", body: { chat_token: "CT9" } }]),
  });
  assert.equal(ok2.chatToken, "CT9");
});

test("getChatAccess reads endpoint + access_token; throws when missing", async () => {
  const acc = await getChatAccess("CT123", {
    fetchImpl: fakeFetch({ endpoint: "https://chat.pscp.tv", access_token: "AT456" }),
  });
  assert.equal(acc.endpoint, "https://chat.pscp.tv");
  assert.equal(acc.accessToken, "AT456");

  await assert.rejects(
    () => getChatAccess("CT123", { fetchImpl: fakeFetch({ endpoint: "https://x" }) }),
    /missing endpoint\/access_token/,
  );
});

test("resolveBroadcast hits broadcasts/show.json with the id, forwarding a guest token only when given", async () => {
  let seenUrl = "";
  let seenGuest: string | undefined;
  const spy = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seenUrl = String(url);
    seenGuest = init?.headers?.["x-guest-token"];
    return {
      ok: true,
      status: 200,
      json: async () => ({ broadcasts: { "BID-9": { chat_token: "x" } } }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;

  await resolveBroadcast("BID-9", { fetchImpl: spy, guestToken: "G1" });
  assert.match(seenUrl, /broadcasts\/show\.json\?ids=BID-9&include_events=true$/);
  assert.equal(seenGuest, "G1");

  // Without a guest token, the header is omitted (bearer-only).
  await resolveBroadcast("BID-9", { fetchImpl: spy });
  assert.equal(seenGuest, undefined);
});

// ── WS URL + frames ───────────────────────────────────────────────────────────
test("chatWsUrl appends the live chat path and upgrades to wss", () => {
  assert.equal(chatWsUrl("https://chat.pscp.tv"), "wss://chat.pscp.tv/chatapi/v1/chatnow");
  assert.equal(chatWsUrl("https://chat.pscp.tv/"), "wss://chat.pscp.tv/chatapi/v1/chatnow");
  assert.equal(chatWsUrl("http://local"), "ws://local/chatapi/v1/chatnow");
});

test("buildAuthFrame / buildJoinFrame produce the nested Periscope shape", () => {
  const auth = JSON.parse(buildAuthFrame("AT456"));
  assert.equal(auth.kind, 3);
  assert.deepEqual(JSON.parse(auth.payload), { access_token: "AT456" });

  const join = JSON.parse(buildJoinFrame("BID7"));
  assert.equal(join.kind, 2);
  const innerPayload = JSON.parse(join.payload);
  assert.equal(innerPayload.kind, 1);
  assert.deepEqual(JSON.parse(innerPayload.body), { room: "BID7" });
});

// ── Normalization (chat vs non-chat) + sanitization ───────────────────────────
function chatEnvelope(opts: { username?: string; display?: string; text: string }): Record<string, unknown> {
  const sender = JSON.stringify({ username: opts.username ?? "alice", display_name: opts.display ?? "Alice" });
  const body = JSON.stringify({ body: opts.text });
  const payload = JSON.stringify({ sender, body });
  return { kind: 1, payload };
}

test("normalizeXMessage maps a real chat frame to the normalized schema", () => {
  const msg = normalizeXMessage(chatEnvelope({ text: "hello world" }), "bcast-1");
  assert.ok(msg);
  assert.equal(msg!.platform, "x");
  assert.equal(msg!.channel, "bcast-1");
  assert.equal(msg!.author, "Alice"); // display_name preferred
  assert.equal(msg!.text, "hello world");
  assert.deepEqual(msg!.emotes, []);
  assert.deepEqual(msg!.badges, []);
  assert.match(msg!.color, /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
});

test("normalizeXMessage falls back to username when no display name", () => {
  const sender = JSON.stringify({ username: "bob" });
  const body = JSON.stringify({ body: "hi" });
  const payload = JSON.stringify({ sender, body });
  const msg = normalizeXMessage({ kind: 1, payload }, "c");
  assert.equal(msg!.author, "bob");
});

test("normalizeXMessage returns null for non-chat kinds and malformed frames", () => {
  // kind 2 = join/leave
  assert.equal(normalizeXMessage({ kind: 2, payload: "{}" }, "c"), null);
  // kind 1 but no text in body
  const payload = JSON.stringify({ sender: JSON.stringify({ username: "x" }), body: JSON.stringify({}) });
  assert.equal(normalizeXMessage({ kind: 1, payload }, "c"), null);
  // garbage
  assert.equal(normalizeXMessage({ kind: 1, payload: "not json" }, "c"), null);
  assert.equal(normalizeXMessage(null as never, "c"), null);
  assert.equal(normalizeXMessage({} as never, "c"), null);
});

test("sanitizeText strips control chars, collapses whitespace, and caps length", () => {
  //    \n become spaces, runs collapse, trimmed.
  assert.equal(sanitizeText("a b\n c", 100), "a b c");
  assert.equal(sanitizeText("   spaced   out   ", 100), "spaced out");
  assert.equal(sanitizeText("x".repeat(600), 500).length, 500);
  // Emoji / unicode preserved.
  assert.equal(sanitizeText("hi 🎉", 100), "hi 🎉");
});

test("normalizeXMessage sanitizes untrusted text + author (control chars removed)", () => {
  const msg = normalizeXMessage(
    chatEnvelope({ display: "Eve ", text: "line1\nline2" }),
    "c",
  );
  assert.equal(msg!.text, "line1 line2");
  assert.equal(msg!.author, "Eve");
  // HTML is NOT escaped here (the overlay renders via textContent) — left intact.
  const html = normalizeXMessage(chatEnvelope({ text: "<b>x</b>" }), "c");
  assert.equal(html!.text, "<b>x</b>");
});

// ── Ingester: a failed/expired handshake surfaces error + retries, never crashes ─
test("XIngester reports error then reconnects when the handshake fails (no crash)", async () => {
  const states: IngesterState[] = [];
  const rejecting: XAccessProvider = {
    name: "reject",
    async getAccess() {
      throw new Error("broadcast offline");
    },
    close() {},
  };
  const manager = new XAccessManager(rejecting, 1000, logger.child("test:x"));
  const cfg = {
    reconnect: { initialMs: 10, maxMs: 20, factor: 2, jitter: 0, connectTimeoutMs: 100 },
    x: { subscribeFrame: undefined },
  } as unknown as AppConfig;

  const ing = new XIngester(
    "https://x.com/i/broadcasts/1ABCdef12345",
    cfg,
    logger.child("test:x"),
    { onState: (s) => states.push(s) },
    manager,
  );

  ing.start();
  await new Promise((r) => setTimeout(r, 60)); // let the rejected handshake settle
  ing.stop();

  assert.ok(states.includes("error"), `expected an error state, got ${states.join(",")}`);
  assert.ok(states.includes("reconnecting"), "should schedule a backed-off retry");
  assert.equal(states[states.length - 1], "stopped", "stop() cleans up");
});
