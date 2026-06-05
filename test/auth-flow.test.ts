import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, httpReq, cookieOf, type TestServer } from "./helpers";

let srv: TestServer;
before(async () => {
  // Verification REQUIRED — exercises the login gate + verify/reset flows.
  srv = await startServer({ requireEmailVerification: true });
});
after(async () => {
  await srv.close();
});

let n = 0;
const email = () => `flow${n++}-${Math.random().toString(36).slice(2)}@test.com`;

/** Pull the ?token= value out of the most recent email's link. */
function tokenFromLastEmail(): string {
  const last = srv.sentEmails[srv.sentEmails.length - 1]!;
  const m = last.text.match(/[?&]token=([0-9a-f]+)/);
  assert.ok(m, "email should contain a token link");
  return m![1]!;
}

test("signup requires verification: no session, sends a verify email", async () => {
  const mail = email();
  const r = await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });
  assert.equal(r.status, 200);
  assert.equal((r.body as any).needsVerification, true);
  assert.equal(cookieOf(r), "", "must NOT start a session before verification");
  const last = srv.sentEmails[srv.sentEmails.length - 1]!;
  assert.equal(last.to, mail);
  assert.match(last.subject, /verify/i);
});

test("login is blocked until the email is verified, then allowed", async () => {
  const mail = email();
  await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });

  const blocked = await httpReq(srv.base, "POST", "/api/login", { json: { email: mail, password: "password123" } });
  assert.equal(blocked.status, 403);
  assert.equal((blocked.body as any).needsVerification, true);
  assert.equal(cookieOf(blocked), "");

  // Click the verification link (GET → redirect to /login?verified=1).
  const token = tokenFromLastEmail();
  const verify = await httpReq(srv.base, "GET", "/verify?token=" + token);
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.location, "/login?verified=1");

  const ok = await httpReq(srv.base, "POST", "/api/login", { json: { email: mail, password: "password123" } });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as any).user.emailVerified, true);
  assert.ok(cookieOf(ok), "verified login should start a session");
});

test("a verification token is single-use", async () => {
  const mail = email();
  await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });
  const token = tokenFromLastEmail();
  const first = await httpReq(srv.base, "GET", "/verify?token=" + token);
  assert.equal(first.headers.location, "/login?verified=1");
  const second = await httpReq(srv.base, "GET", "/verify?token=" + token);
  assert.equal(second.headers.location, "/login?verify_error=1", "token must not work twice");
});

test("resend verification emails again (and never leaks unknown addresses)", async () => {
  const mail = email();
  await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });
  const before = srv.sentEmails.length;
  const r = await httpReq(srv.base, "POST", "/api/verify/resend", { json: { email: mail } });
  assert.equal(r.status, 200);
  assert.equal(srv.sentEmails.length, before + 1);

  // Unknown address: still 200, but no email sent.
  const before2 = srv.sentEmails.length;
  const unknown = await httpReq(srv.base, "POST", "/api/verify/resend", { json: { email: "nobody@test.com" } });
  assert.equal(unknown.status, 200);
  assert.equal(srv.sentEmails.length, before2);
});

test("password reset: email link → set new password → old password rejected", async () => {
  const mail = email();
  await httpReq(srv.base, "POST", "/api/signup", { json: { email: mail, password: "password123" } });
  // Verify so we can log in afterwards.
  await httpReq(srv.base, "GET", "/verify?token=" + tokenFromLastEmail());

  // Forgot → always 200, sends a reset link.
  const forgot = await httpReq(srv.base, "POST", "/api/password/forgot", { json: { email: mail } });
  assert.equal(forgot.status, 200);
  const resetToken = tokenFromLastEmail();

  // Reset with the token.
  const reset = await httpReq(srv.base, "POST", "/api/password/reset", {
    json: { token: resetToken, password: "newpassword456" },
  });
  assert.equal(reset.status, 200);

  // New password works; old one doesn't.
  const newOk = await httpReq(srv.base, "POST", "/api/login", { json: { email: mail, password: "newpassword456" } });
  assert.equal(newOk.status, 200);
  const oldNo = await httpReq(srv.base, "POST", "/api/login", { json: { email: mail, password: "password123" } });
  assert.equal(oldNo.status, 401);
});

test("password reset rejects an invalid/short request", async () => {
  const bad = await httpReq(srv.base, "POST", "/api/password/reset", { json: { token: "deadbeef", password: "longenough1" } });
  assert.equal(bad.status, 400);
  // forgot doesn't leak: unknown address still returns 200.
  const unknown = await httpReq(srv.base, "POST", "/api/password/forgot", { json: { email: "ghost@test.com" } });
  assert.equal(unknown.status, 200);
});

test("forgot/reset GET routes serve the auth page", async () => {
  for (const p of ["/forgot", "/reset?token=abc"]) {
    const r = await httpReq(srv.base, "GET", p, { headers: { accept: "text/html" } });
    assert.equal(r.status, 200);
    assert.match(r.raw, /Crossfeed/);
  }
});
