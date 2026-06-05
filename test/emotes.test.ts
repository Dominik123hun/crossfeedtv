import { test } from "node:test";
import assert from "node:assert/strict";
import { TwitchEmoteResolver, mergeEmotes } from "../src/emotes";

const fixtures: Record<string, unknown> = {
  "https://7tv.io/v3/emote-sets/global": { emotes: [{ name: "Collide", id: "g7" }, { name: "OnlySeven", id: "g7b" }] },
  "https://api.betterttv.net/3/cached/emotes/global": [{ code: "Collide", id: "gb" }, { code: "OnlyBttv", id: "gb2" }],
  "https://api.frankerfacez.com/v1/room/streamer": { sets: { a: { emoticons: [{ name: "RoomFfz", urls: { "2": "//cdn.ffz/room2x" } }] } } },
  "https://api.betterttv.net/3/cached/users/twitch/123": { channelEmotes: [{ code: "ChanBttv", id: "cb" }], sharedEmotes: [] },
  "https://7tv.io/v3/users/twitch/123": { emote_set: { emotes: [{ name: "Collide", id: "c7" }, { name: "ChanSeven", id: "c7b" }] } },
};

function resolverWith(failGlobalFfz = true) {
  return new TwitchEmoteResolver({
    refreshMs: 999999,
    fetchJson: async (url: string) => {
      if (failGlobalFfz && url.includes("frankerfacez.com/v1/set/global")) throw new Error("FFZ global down");
      if (url in fixtures) return fixtures[url];
      throw new Error("404 " + url);
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("before warm: no emotes (empty, never throws)", () => {
  const r = resolverWith();
  assert.deepEqual(r.match("streamer", "Collide hi"), []);
});

test("precedence (channel 7TV > global) + per-provider URLs + fail-soft", async () => {
  const r = resolverWith(true); // FFZ global throws -> must not break others
  r.warm("streamer", "123");
  await sleep(60);
  const map = new Map(r.match("streamer", "Collide OnlySeven OnlyBttv ChanBttv ChanSeven RoomFfz plain").map((e) => [e.code, e.url]));
  assert.equal(map.get("Collide"), "https://cdn.7tv.app/emote/c7/2x.webp", "channel 7TV wins collision");
  assert.equal(map.get("OnlySeven"), "https://cdn.7tv.app/emote/g7b/2x.webp");
  assert.equal(map.get("OnlyBttv"), "https://cdn.betterttv.net/emote/gb2/2x");
  assert.equal(map.get("ChanBttv"), "https://cdn.betterttv.net/emote/cb/2x");
  assert.equal(map.get("ChanSeven"), "https://cdn.7tv.app/emote/c7b/2x.webp");
  assert.equal(map.get("RoomFfz"), "https://cdn.ffz/room2x", "protocol-relative -> https");
  assert.equal(map.has("plain"), false, "non-emote token not resolved");
  assert.ok(r.size("streamer") >= 5);
});

test("total fetch failure keeps the channel empty (fail-soft, no throw)", async () => {
  const r = new TwitchEmoteResolver({ refreshMs: 999999, fetchJson: async () => { throw new Error("network down"); } });
  r.warm("streamer", "123");
  await sleep(60);
  assert.deepEqual(r.match("streamer", "Collide"), []);
  assert.equal(r.size("streamer"), 0);
});

test("warm without a twitch id still loads global + FFZ-room layers", async () => {
  const r = resolverWith(false); // FFZ global ok this time
  r.warm("streamer"); // no id -> 7TV/BTTV channel skipped
  await sleep(60);
  const map = new Map(r.match("streamer", "OnlySeven OnlyBttv RoomFfz ChanSeven").map((e) => [e.code, e.url]));
  assert.equal(map.get("OnlySeven"), "https://cdn.7tv.app/emote/g7b/2x.webp");
  assert.equal(map.get("OnlyBttv"), "https://cdn.betterttv.net/emote/gb2/2x");
  assert.equal(map.get("RoomFfz"), "https://cdn.ffz/room2x");
  assert.equal(map.has("ChanSeven"), false, "channel 7TV requires an id");
});

test("mergeEmotes: third-party overrides native, native kept otherwise", () => {
  const merged = mergeEmotes(
    [{ code: "Collide", url: "native" }, { code: "Kappa", url: "kappa" }],
    [{ code: "Collide", url: "tpv" }],
  );
  const m = new Map(merged.map((e) => [e.code, e.url]));
  assert.equal(m.get("Collide"), "tpv");
  assert.equal(m.get("Kappa"), "kappa");
});
