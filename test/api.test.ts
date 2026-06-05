import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, httpReq, cookieOf, sleep, type TestServer } from "./helpers";

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

let n = 0;
const email = () => `u${n++}-${Math.random().toString(36).slice(2)}@test.com`;

async function signup(mail = email()) {
  const res = await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });
  return { res, cookie: cookieOf(res), user: (res.body as any).user, mail };
}

// ── Static pages ─────────────────────────────────────────────────────────────
test("pages: landing / overlay / dashboard / login are served", async () => {
  for (const [p, needle] of [
    ["/", "Every chat"],
    ["/overlay", "CrossFeed.tv Overlay"],
    ["/dashboard", "Your dashboard"],
    ["/login", "Crossfeed"],
  ] as const) {
    const r = await httpReq(srv.base, "GET", p);
    assert.equal(r.status, 200, `${p} status`);
    assert.ok(r.raw.includes(needle), `${p} should contain "${needle}"`);
  }
});

// ── Signup / login ───────────────────────────────────────────────────────────
test("signup returns a session cookie + safe public user with defaults", async () => {
  const { res, cookie, user } = await signup();
  assert.equal(res.status, 200);
  assert.ok(cookie.startsWith("cf_sess="));
  assert.ok(user.token && user.overlayPath.includes(user.token));
  assert.equal(user.settings.fontSize, 18);
  assert.equal((user as any).passwordHash, undefined, "never leak the hash");
  assert.equal((user as any).salt, undefined);
});

test("signup validation: bad email, short password, duplicate", async () => {
  assert.equal((await httpReq(srv.base, "POST", "/api/signup", { json: { email: "nope", password: "password123" } })).status, 400);
  assert.equal((await httpReq(srv.base, "POST", "/api/signup", { json: { email: email(), password: "short" } })).status, 400);
  const mail = email();
  await signup(mail);
  assert.equal((await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } })).status, 409);
});

test("login: wrong password 401, right 200; email is case-insensitive", async () => {
  const { mail } = await signup();
  assert.equal((await httpReq(srv.base, "POST", "/api/login", { json: { email: mail, password: "wrongpass1" } })).status, 401);
  assert.equal((await httpReq(srv.base, "POST", "/api/login", { json: { email: mail.toUpperCase(), password: "password123" } })).status, 200);
});

// ── Session gating ───────────────────────────────────────────────────────────
test("me: 401 without cookie, 200 with; logout invalidates", async () => {
  assert.equal((await httpReq(srv.base, "GET", "/api/me")).status, 401);
  const { cookie } = await signup();
  assert.equal((await httpReq(srv.base, "GET", "/api/me", { cookie })).status, 200);
  assert.equal((await httpReq(srv.base, "POST", "/api/logout", { cookie })).status, 200);
  assert.equal((await httpReq(srv.base, "GET", "/api/me", { cookie })).status, 401, "session invalid after logout");
});

test("garbage / empty session cookie -> 401, never 500", async () => {
  for (const cookie of ["cf_sess=", "cf_sess=deadbeef", "cf_sess=%%%notvalid%%%", "other=1"]) {
    assert.equal((await httpReq(srv.base, "GET", "/api/me", { cookie })).status, 401, cookie);
  }
});

test("session expiry: an expired session no longer authenticates", async () => {
  const short = await startServer({ sessionTtlMs: 60 });
  try {
    const r = await httpReq(short.base, "POST", "/api/signup", { json: { email: email(), password: "password123" } });
    const cookie = cookieOf(r);
    assert.equal((await httpReq(short.base, "GET", "/api/me", { cookie })).status, 200);
    await sleep(90);
    assert.equal((await httpReq(short.base, "GET", "/api/me", { cookie })).status, 401, "expired session must 401");
  } finally {
    await short.close();
  }
});

// ── CSRF ─────────────────────────────────────────────────────────────────────
test("CSRF: state-changing endpoints require X-Requested-With", async () => {
  const { cookie } = await signup();
  for (const [method, p, json] of [
    ["POST", "/api/logout", undefined],
    ["PUT", "/api/channels", { twitch: "x" }],
    ["PUT", "/api/settings", { fontSize: 20 }],
    ["POST", "/api/test", undefined],
    ["POST", "/api/token/rotate", undefined],
    ["DELETE", "/api/account", undefined],
  ] as const) {
    const r = await httpReq(srv.base, method, p, { cookie, json, noCsrf: true });
    assert.equal(r.status, 403, `${method} ${p} should be CSRF-blocked`);
  }
});

// ── Body handling ────────────────────────────────────────────────────────────
test("malformed JSON -> 400, oversized body -> 413", async () => {
  assert.equal((await httpReq(srv.base, "POST", "/api/signup", { rawBody: "{not json" })).status, 400);
  const big = "x".repeat(70 * 1024);
  assert.equal((await httpReq(srv.base, "POST", "/api/signup", { rawBody: JSON.stringify({ email: "a@b.co", password: big }) })).status, 413);
});

// ── Channels ─────────────────────────────────────────────────────────────────
test("channels: requires auth; sanitizes handles; rejects junk", async () => {
  assert.equal((await httpReq(srv.base, "PUT", "/api/channels", { json: { twitch: "x" } })).status, 401);
  const { cookie } = await signup();
  const r = await httpReq(srv.base, "PUT", "/api/channels", { cookie, json: { twitch: "#XQC", kick: "@slug", x: "  " } });
  assert.equal(r.status, 200);
  const ch = (r.body as any).user.channels;
  assert.equal(ch.twitch, "XQC", "strip leading #");
  assert.equal(ch.kick, "slug", "strip leading @");
  assert.equal(ch.x, undefined, "blank -> undefined");

  // junk with illegal chars is dropped (undefined), not stored
  const r2 = await httpReq(srv.base, "PUT", "/api/channels", { cookie, json: { twitch: "bad name!" } });
  assert.equal((r2.body as any).user.channels.twitch, undefined);
});

// ── Settings ─────────────────────────────────────────────────────────────────
test("settings: clamps numbers, ignores bad enums, requires auth", async () => {
  assert.equal((await httpReq(srv.base, "PUT", "/api/settings", { json: { fontSize: 20 } })).status, 401);
  const { cookie } = await signup();
  const r = await httpReq(srv.base, "PUT", "/api/settings", {
    cookie,
    json: { fontSize: 9999, bgOpacity: 5, position: "nonsense", show: { twitch: false } },
  });
  const s = (r.body as any).user.settings;
  assert.equal(s.fontSize, 96, "clamp high");
  assert.equal(s.bgOpacity, 1, "clamp opacity");
  assert.equal(s.position, "bottom-left", "bad enum -> keep default");
  assert.equal(s.show.twitch, false);
  assert.equal(s.show.kick, true, "unspecified toggle keeps current");
});

// ── Test feed + token rotation + delete ──────────────────────────────────────
test("test feed: 200 then debounced 429; requires auth", async () => {
  assert.equal((await httpReq(srv.base, "POST", "/api/test")).status, 401);
  const { cookie } = await signup();
  assert.equal((await httpReq(srv.base, "POST", "/api/test", { cookie })).status, 200);
  assert.equal((await httpReq(srv.base, "POST", "/api/test", { cookie })).status, 429, "debounced");
});

test("auth rate limiting: too many signup/login attempts -> 429", async () => {
  const limited = await startServer({ authRateMax: 3, authRateWindowMs: 60000 });
  try {
    // 3 allowed, 4th blocked (validation failures still count as attempts).
    for (let i = 0; i < 3; i++) {
      const r = await httpReq(limited.base, "POST", "/api/login", { json: { email: email(), password: "x" } });
      assert.equal(r.status, 401, `attempt ${i} should be processed (bad creds)`);
    }
    const blocked = await httpReq(limited.base, "POST", "/api/login", { json: { email: email(), password: "x" } });
    assert.equal(blocked.status, 429, "4th attempt should be rate-limited");
    // signup shares the same per-IP limiter
    assert.equal((await httpReq(limited.base, "POST", "/api/signup", { json: { email: email(), password: "password123" } })).status, 429);
  } finally {
    await limited.close();
  }
});

test("token rotate invalidates old token; delete removes account", async () => {
  const { cookie, user } = await signup();
  const old = user.token;
  const rotated = (await httpReq(srv.base, "POST", "/api/token/rotate", { cookie })).body as any;
  assert.notEqual(rotated.user.token, old);
  assert.equal(srv.store.getUserByToken(old), undefined, "old token gone server-side");

  assert.equal((await httpReq(srv.base, "DELETE", "/api/account", { cookie })).status, 200);
  assert.equal((await httpReq(srv.base, "GET", "/api/me", { cookie })).status, 401);
  assert.equal(srv.store.getUserByToken(rotated.user.token), undefined, "deleted user's token cannot resolve");
});
