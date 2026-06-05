import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import {
  verifyKickSignature,
  normalizeOfficialKickEvent,
  handleKickWebhook,
  type KickOfficialConfig,
} from "../src/ingesters/kick-official";
import { startServer, httpReq, cookieOf, openFeed, sleep } from "./helpers";

// Generate a throwaway RSA keypair to stand in for Kick's event-signing keys.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function sign(messageId: string, timestamp: string, rawBody: string): string {
  const content = `${messageId}.${timestamp}.${rawBody}`;
  return crypto.sign("sha256", Buffer.from(content, "utf8"), privateKey).toString("base64");
}

const sampleEvent = {
  message_id: "m-1",
  broadcaster: { channel_slug: "MyChannel" },
  sender: { username: "Fan", identity: { username_color: "#53FC18", badges: [{ type: "moderator" }] } },
  content: "gg [emote:1:EZ]",
  created_at: "2026-06-05T00:00:00.000Z",
};

test("verifyKickSignature: accepts a valid signature, rejects tampering/bad key", () => {
  const id = "m-1";
  const ts = "1717545600";
  const body = JSON.stringify(sampleEvent);
  const sig = sign(id, ts, body);

  assert.equal(verifyKickSignature({ publicKeyPem: pubPem, messageId: id, timestamp: ts, rawBody: body, signatureB64: sig }), true);
  // tampered body
  assert.equal(verifyKickSignature({ publicKeyPem: pubPem, messageId: id, timestamp: ts, rawBody: body + "x", signatureB64: sig }), false);
  // wrong timestamp
  assert.equal(verifyKickSignature({ publicKeyPem: pubPem, messageId: id, timestamp: "9999", rawBody: body, signatureB64: sig }), false);
  // missing signature / key
  assert.equal(verifyKickSignature({ publicKeyPem: pubPem, messageId: id, timestamp: ts, rawBody: body, signatureB64: "" }), false);
  assert.equal(verifyKickSignature({ publicKeyPem: "", messageId: id, timestamp: ts, rawBody: body, signatureB64: sig }), false);
  // garbage signature does not throw
  assert.equal(verifyKickSignature({ publicKeyPem: pubPem, messageId: id, timestamp: ts, rawBody: body, signatureB64: "!!!notb64" }), false);
});

test("normalizeOfficialKickEvent: maps to NormalizedMessage (emotes/badges/color)", () => {
  const parsed = normalizeOfficialKickEvent(sampleEvent)!;
  assert.equal(parsed.channel, "mychannel");
  assert.equal(parsed.msg.platform, "kick");
  assert.equal(parsed.msg.author, "Fan");
  assert.equal(parsed.msg.color, "#53FC18");
  assert.deepEqual(parsed.msg.badges, ["moderator"]);
  assert.equal(parsed.msg.text, "gg EZ");
  assert.equal(parsed.msg.emotes[0]?.code, "EZ");
  // missing broadcaster -> null
  assert.equal(normalizeOfficialKickEvent({ content: "hi" }), null);
});

const cfg = (over: Partial<KickOfficialConfig> = {}): KickOfficialConfig => ({
  enabled: true,
  webhookPath: "/webhooks/kick",
  eventPublicKeyPem: pubPem,
  ...over,
});

test("handleKickWebhook: valid signed chat event -> routable message", () => {
  const body = JSON.stringify(sampleEvent);
  const id = "m-1";
  const ts = "1717545600";
  const headers = {
    "kick-event-message-id": id,
    "kick-event-message-timestamp": ts,
    "kick-event-signature": sign(id, ts, body),
    "kick-event-type": "chat.message.sent",
  };
  const r = handleKickWebhook(cfg(), headers, body);
  assert.equal(r.status, 200);
  assert.equal(r.channel, "mychannel");
  assert.equal(r.msg?.text, "gg EZ");
});

test("handleKickWebhook: bad signature -> 403; not configured -> 503", () => {
  const body = JSON.stringify(sampleEvent);
  const headers = {
    "kick-event-message-id": "m-1",
    "kick-event-message-timestamp": "1717545600",
    "kick-event-signature": "AAAA",
    "kick-event-type": "chat.message.sent",
  };
  assert.equal(handleKickWebhook(cfg(), headers, body).status, 403, "bad signature rejected");
  assert.equal(handleKickWebhook(cfg({ eventPublicKeyPem: undefined }), headers, body).status, 503, "no key -> not configured");
});

test("handleKickWebhook: signed non-chat event is acked (200) and ignored", () => {
  const body = JSON.stringify({ some: "other" });
  const id = "m-2";
  const ts = "1717545600";
  const headers = {
    "kick-event-message-id": id,
    "kick-event-message-timestamp": ts,
    "kick-event-signature": sign(id, ts, body),
    "kick-event-type": "channel.followed",
  };
  const r = handleKickWebhook(cfg(), headers, body);
  assert.equal(r.status, 200);
  assert.equal(r.msg, undefined, "non-chat event produces no message");
});

test("OFF by default: the webhook route is not mounted (404)", async () => {
  const srv = await startServer(); // kickOfficial disabled
  try {
    const r = await httpReq(srv.base, "POST", "/webhooks/kick", { json: { x: 1 } });
    assert.equal(r.status, 404, "webhook must be inert unless enabled");
  } finally {
    await srv.close();
  }
});

test("ENABLED end-to-end: a signed chat webhook routes to the user's live feed", async () => {
  const srv = await startServer({ kickOfficialEnabled: true, kickEventPublicKeyPem: pubPem });
  try {
    const su = await httpReq(srv.base, "POST", "/api/signup", { json: { email: "ko@test.com", password: "password123" } });
    const cookie = cookieOf(su);
    const token = (su.body as any).user.token;
    await httpReq(srv.base, "PUT", "/api/channels", { cookie, json: { kick: "mychannel" } });

    const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
    await feed.waitForType("hello");

    const body = JSON.stringify(sampleEvent);
    const id = "m-e2e";
    const ts = "1717545600";
    const r = await httpReq(srv.base, "POST", "/webhooks/kick", {
      rawBody: body,
      headers: {
        "kick-event-message-id": id,
        "kick-event-message-timestamp": ts,
        "kick-event-signature": sign(id, ts, body),
        "kick-event-type": "chat.message.sent",
      },
    });
    assert.equal(r.status, 200, "webhook accepted");
    await sleep(120);
    const chats = feed.ofType("chat").map((f) => (f.msg as any).text);
    assert.ok(chats.includes("gg EZ"), "official webhook chat reached the subscribed feed");
    feed.close();
  } finally {
    await srv.close();
  }
});
