import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { startServer, httpReq, cookieOf, openFeed, sleep, type TestServer } from "./helpers";

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

let n = 0;
async function newUser(channels?: Record<string, string>) {
  const mail = `f${n++}-${Math.random().toString(36).slice(2)}@test.com`;
  const res = await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });
  const cookie = cookieOf(res);
  const user = (res.body as any).user;
  if (channels) await httpReq(srv.base, "PUT", "/api/channels", { cookie, json: channels });
  return { cookie, user, token: user.token };
}

test("token resolves to the user's channels (hello.subscriptions)", async () => {
  const { token } = await newUser({ twitch: "alpha", kick: "beta" });
  const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
  const hello = await feed.waitForType("hello");
  assert.deepEqual((hello.subscriptions as string[]).sort(), ["kick:beta", "twitch:alpha"]);
  feed.close();
});

test("per-user isolation: a token never resolves another user's channels", async () => {
  const a = await newUser({ twitch: "alpha" });
  const b = await newUser({ kick: "bravo" });
  const fa = await openFeed(srv.wsBase, "/feed?token=" + a.token);
  const fb = await openFeed(srv.wsBase, "/feed?token=" + b.token);
  const ha = (await fa.waitForType("hello")).subscriptions as string[];
  const hb = (await fb.waitForType("hello")).subscriptions as string[];
  assert.deepEqual(ha, ["twitch:alpha"]);
  assert.deepEqual(hb, ["kick:bravo"]);
  assert.ok(!hb.includes("twitch:alpha"));
  fa.close();
  fb.close();
});

test("invalid / empty token -> empty feed (no channels)", async () => {
  for (const t of ["deadbeefdeadbeef", "", "%%%"]) {
    const feed = await openFeed(srv.wsBase, "/feed?token=" + t);
    const hello = await feed.waitForType("hello");
    assert.deepEqual(hello.subscriptions, []);
    feed.close();
  }
});

test("status: idle for unset platforms; connected once a channel is set", async () => {
  const { token } = await newUser({ twitch: "alpha" }); // kick + x unset
  const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
  await feed.waitForType("hello");
  await sleep(80);
  const statuses = new Map(feed.ofType("status").map((f) => [f.platform, f.state]));
  assert.equal(statuses.get("kick"), "idle");
  assert.equal(statuses.get("x"), "idle");
  assert.equal(statuses.get("twitch"), "connected", "fake ingester reports connected");
  feed.close();
});

test("live re-subscription: channel change reflects to a connected overlay", async () => {
  const { cookie, token } = await newUser({ twitch: "alpha" });
  const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
  await feed.waitForType("hello");
  const subsSeen: string[] = [];
  feed.frames.filter((f) => f.type === "hello").forEach((f) => subsSeen.push((f.subscriptions as string[]).sort().join(",")));
  await httpReq(srv.base, "PUT", "/api/channels", { cookie, json: { kick: "gamma" } }); // replace twitch with kick
  await sleep(120);
  feed.frames.filter((f) => f.type === "hello").forEach((f) => subsSeen.push((f.subscriptions as string[]).sort().join(",")));
  assert.ok(subsSeen.includes("twitch:alpha"));
  assert.ok(subsSeen.includes("kick:gamma"), "new channel set pushed live");
  feed.close();
});

test("settings: frame on connect, and pushed live on change (no reconnect)", async () => {
  const { cookie, token } = await newUser({ twitch: "alpha" });
  const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
  const initial = await feed.waitForType("settings");
  assert.equal((initial.settings as any).fontSize, 18);

  await httpReq(srv.base, "PUT", "/api/settings", { cookie, json: { fontSize: 30, position: "top-right", show: { kick: false } } });
  await sleep(120);
  const pushed = feed.ofType("settings").pop() as any;
  assert.equal(pushed.settings.fontSize, 30);
  assert.equal(pushed.settings.position, "top-right");
  assert.equal(pushed.settings.show.kick, false);
  feed.close();
});

test("real chat routing isolation: a channel's message only reaches its subscribers", async () => {
  const a = await newUser({ twitch: "alpha" });
  const b = await newUser({ twitch: "bravo" });
  const fa = await openFeed(srv.wsBase, "/feed?token=" + a.token);
  const fb = await openFeed(srv.wsBase, "/feed?token=" + b.token);
  await fa.waitForType("hello");
  await fb.waitForType("hello");

  srv.bus.emit("twitch", "alpha", { text: "for-A" });
  await sleep(80);
  const aChats = fa.ofType("chat").map((f) => (f.msg as any).text);
  const bChats = fb.ofType("chat").map((f) => (f.msg as any).text);
  assert.ok(aChats.includes("for-A"));
  assert.ok(!bChats.includes("for-A"), "cross-user chat leak");
  fa.close();
  fb.close();
});

test("test feed: injected messages reach only the firing user, flagged test:true", async () => {
  const a = await newUser({ twitch: "alpha" });
  const b = await newUser({ twitch: "alpha" }); // same channel name, different user
  const fa = await openFeed(srv.wsBase, "/feed?token=" + a.token);
  const fb = await openFeed(srv.wsBase, "/feed?token=" + b.token);
  await fa.waitForType("hello");
  await fb.waitForType("hello");

  assert.equal((await httpReq(srv.base, "POST", "/api/test", { cookie: a.cookie })).status, 200);
  await sleep(2000); // staggered batch

  const aTest = fa.ofType("chat").filter((f) => (f.msg as any).test === true);
  const bTest = fb.ofType("chat").filter((f) => (f.msg as any).test === true);
  assert.ok(aTest.length >= 3, "firing user receives the batch");
  assert.equal(bTest.length, 0, "test messages must NOT leak to another user");
  const platforms = new Set(aTest.map((f) => (f.msg as any).platform));
  assert.ok(platforms.has("twitch") && platforms.has("kick") && platforms.has("x"), "spans all platforms");
  for (const f of aTest) assert.equal((f.msg as any).test, true, "every test message is flagged");
  fa.close();
  fb.close();
});

test("test messages are NEVER persisted (store holds only users + sessions + tokens)", async () => {
  const a = await newUser({ twitch: "alpha" });
  const fa = await openFeed(srv.wsBase, "/feed?token=" + a.token);
  await fa.waitForType("hello");
  await httpReq(srv.base, "POST", "/api/test", { cookie: a.cookie });
  await sleep(2000);

  const raw = fs.readFileSync(path.join(srv.dataDir, "crossfeed-db.json"), "utf8");
  const db = JSON.parse(raw);
  assert.deepEqual(Object.keys(db).sort(), ["sessions", "tokens", "users"], "store schema unchanged");
  // Test-message authors / flags must not appear anywhere on disk.
  assert.ok(!raw.includes("test_ninja"), "test chat author must not be persisted");
  assert.ok(!raw.includes('"test":true'), "test flag must not be persisted");
  fa.close();
});

test("overlay-initiated test ({type:'test'} over WS) delivers to that user only", async () => {
  const a = await newUser({ twitch: "alpha" });
  const fa = await openFeed(srv.wsBase, "/feed?token=" + a.token);
  await fa.waitForType("hello");
  fa.ws.send(JSON.stringify({ type: "test" }));
  await sleep(2000);
  const aTest = fa.ofType("chat").filter((f) => (f.msg as any).test === true);
  assert.ok(aTest.length >= 3, "WS-triggered test delivered");
  fa.close();
});
