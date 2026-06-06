import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer, httpReq, cookieOf, openFeed, type TestServer } from "./helpers";

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

async function userWithX(broadcast: string): Promise<string> {
  const su = await httpReq(srv.base, "POST", "/api/signup", {
    json: { email: `xi${Math.random().toString(36).slice(2)}@t.com`, password: "password123" },
  });
  const cookie = cookieOf(su);
  const token = (su.body as { user: { token: string } }).user.token;
  await httpReq(srv.base, "PUT", "/api/channels", { json: { x: broadcast }, cookie });
  return token;
}

function openIngest(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.wsBase + "/x-ingest?token=" + encodeURIComponent(token));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("x-ingest: a scraped message reaches the user's overlay feed", async () => {
  const token = await userWithX("mybroadcast");
  const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
  await feed.waitForType("hello");

  const ingest = await openIngest(token);
  ingest.send(JSON.stringify({ author: "@alice", text: "hi from x" }));

  const chat = await feed.waitForType("chat");
  const msg = chat.msg as { platform: string; channel: string; author: string; text: string };
  assert.equal(msg.platform, "x");
  assert.equal(msg.channel, "mybroadcast");
  assert.equal(msg.author, "@alice");
  assert.equal(msg.text, "hi from x");

  ingest.close();
  feed.close();
});

test("x-ingest: accepts a batch and sanitizes text", async () => {
  const token = await userWithX("bcast2");
  const feed = await openFeed(srv.wsBase, "/feed?token=" + token);
  await feed.waitForType("hello");

  const ingest = await openIngest(token);
  // Second item is empty → dropped; first → injected with newline collapsed.
  ingest.send(JSON.stringify({ batch: [{ author: "bob", text: "line1\nline2" }, { author: "", text: "  " }] }));

  const chat = await feed.waitForType("chat");
  const msg = chat.msg as { author: string; text: string };
  assert.equal(msg.author, "bob");
  assert.equal(msg.text, "line1 line2");

  ingest.close();
  feed.close();
});

test("x-ingest: an invalid token is rejected (socket closes)", async () => {
  const closed = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(srv.wsBase + "/x-ingest?token=deadbeef");
    ws.on("close", () => resolve(true));
    ws.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 1500);
  });
  assert.equal(closed, true);
});
