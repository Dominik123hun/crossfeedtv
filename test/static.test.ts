import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, httpReq, type TestServer } from "./helpers";

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

const HTML = { headers: { accept: "text/html" } };

test("404: navigations get the branded HTML page", async () => {
  const r = await httpReq(srv.base, "GET", "/does-not-exist", HTML);
  assert.equal(r.status, 404);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  assert.match(r.raw, /Page not found/);
});

test("404: asset-style requests get a lightweight plain-text body", async () => {
  // No Accept: text/html → the client is fetching a resource, not navigating.
  const r = await httpReq(srv.base, "GET", "/assets/nope.webp");
  assert.equal(r.status, 404);
  assert.match(String(r.headers["content-type"]), /text\/plain/);
  assert.equal(r.raw, "Not found");
});

test("robots.txt is served as text and disallows the app surfaces", async () => {
  const r = await httpReq(srv.base, "GET", "/robots.txt");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/plain/);
  assert.match(r.raw, /Disallow: \/dashboard/);
  assert.match(r.raw, /Disallow: \/api\//);
});

test("web manifest is served with the manifest content-type", async () => {
  const r = await httpReq(srv.base, "GET", "/site.webmanifest");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /application\/manifest\+json/);
  assert.equal((r.body as { name?: string }).name, "Crossfeed");
});

test("webp assets are served with the image/webp content-type", async () => {
  const r = await httpReq(srv.base, "GET", "/assets/glyph.webp");
  assert.equal(r.status, 200);
  assert.equal(String(r.headers["content-type"]), "image/webp");
});
