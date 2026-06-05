import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "http";
import {
  hashPassword,
  verifyPassword,
  parseCookies,
  isSecureRequest,
  setSessionCookie,
  clearSessionCookie,
  sessionIdFrom,
} from "../src/auth";

test("hashPassword + verifyPassword round-trips and rejects wrong password", () => {
  const { hash, salt } = hashPassword("correct horse battery");
  assert.ok(hash.length >= 64, "hash should be long");
  assert.equal(verifyPassword("correct horse battery", salt, hash), true);
  assert.equal(verifyPassword("wrong", salt, hash), false);
});

test("same password yields different hashes (unique salt)", () => {
  const a = hashPassword("samepass");
  const b = hashPassword("samepass");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test("verifyPassword tolerates malformed stored hash", () => {
  assert.equal(verifyPassword("x", "salt", "not-hex-zzz"), false);
  assert.equal(verifyPassword("x", "salt", ""), false);
});

test("parseCookies handles multiple, spacing, and missing", () => {
  const mk = (cookie?: string) => ({ headers: { cookie } }) as unknown as IncomingMessage;
  assert.deepEqual(parseCookies(mk("a=1; b=2")), { a: "1", b: "2" });
  assert.deepEqual(parseCookies(mk("cf_sess=abc")), { cf_sess: "abc" });
  assert.deepEqual(parseCookies(mk(undefined)), {});
  assert.equal(sessionIdFrom(mk("cf_sess=xyz; other=1")), "xyz");
});

test("isSecureRequest infers from x-forwarded-proto and honors override", () => {
  const mk = (proto?: string) => ({ headers: proto ? { "x-forwarded-proto": proto } : {} }) as unknown as IncomingMessage;
  assert.equal(isSecureRequest(mk("https")), true);
  assert.equal(isSecureRequest(mk("http")), false);
  assert.equal(isSecureRequest(mk("https,http")), true); // first hop
  assert.equal(isSecureRequest(mk(undefined)), false);
  assert.equal(isSecureRequest(mk("http"), true), true); // override wins
  assert.equal(isSecureRequest(mk("https"), false), false);
});

function fakeRes() {
  const headers: Record<string, string | string[]> = {};
  return {
    setHeader: (k: string, v: string | string[]) => (headers[k] = v),
    getHeader: (k: string) => headers[k],
    _headers: headers,
  } as unknown as ServerResponse & { _headers: Record<string, string | string[]> };
}

test("session cookie is HttpOnly + SameSite=Lax, Secure only when secure", () => {
  const res = fakeRes();
  setSessionCookie(res, "sid123", 1000, true);
  const cookie = String(res._headers["Set-Cookie"]);
  assert.match(cookie, /cf_sess=sid123/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  const res2 = fakeRes();
  setSessionCookie(res2, "sid", 1000, false);
  assert.doesNotMatch(String(res2._headers["Set-Cookie"]), /Secure/);
});

test("clearSessionCookie expires the cookie", () => {
  const res = fakeRes();
  clearSessionCookie(res, false);
  assert.match(String(res._headers["Set-Cookie"]), /Max-Age=0/);
});
