import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createStore } from "../src/store";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-store-"));
  return { store: createStore(dir), dir };
}

test("createUser sets defaults: empty channels, secure token, default settings", () => {
  const { store } = tmpStore();
  const u = store.createUser("a@test.com", "hash", "salt");
  assert.deepEqual(u.channels, {});
  assert.match(u.token, /^[0-9a-f]+$/);
  assert.ok(u.token.length >= 32, "token should be long (unguessable)");
  assert.equal(u.settings.fontSize, 18);
  assert.equal(u.settings.bgOpacity, 0);
  assert.equal(u.settings.position, "bottom-left");
  assert.deepEqual(u.settings.show, { twitch: true, kick: true, x: true });
  assert.equal(u.settings.statusIndicator, false);
});

test("lookups by email / id / token", () => {
  const { store } = tmpStore();
  const u = store.createUser("b@test.com", "h", "s");
  assert.equal(store.getUserByEmail("b@test.com")?.id, u.id);
  assert.equal(store.getUserById(u.id)?.email, "b@test.com");
  assert.equal(store.getUserByToken(u.token)?.id, u.id);
  assert.equal(store.getUserByEmail("missing@test.com"), undefined);
  assert.equal(store.getUserByToken("deadbeef"), undefined);
});

test("tokens are unique across users", () => {
  const { store } = tmpStore();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const u = store.createUser(`u${i}@test.com`, "h", "s");
    assert.ok(!seen.has(u.token), "token collision");
    seen.add(u.token);
  }
});

test("rotateToken invalidates the old token server-side", () => {
  const { store } = tmpStore();
  const u = store.createUser("c@test.com", "h", "s");
  const old = u.token;
  const rotated = store.rotateToken(u.id)!;
  assert.notEqual(rotated.token, old);
  assert.equal(store.getUserByToken(old), undefined, "old token must not resolve");
  assert.equal(store.getUserByToken(rotated.token)?.id, u.id);
});

test("updateChannels and updateSettings persist", () => {
  const { store } = tmpStore();
  const u = store.createUser("d@test.com", "h", "s");
  store.updateChannels(u.id, { twitch: "xqc", kick: undefined, x: undefined });
  assert.equal(store.getUserById(u.id)?.channels.twitch, "xqc");
  store.updateSettings(u.id, { ...u.settings, fontSize: 30, position: "top-right" });
  assert.equal(store.getUserById(u.id)?.settings.fontSize, 30);
  assert.equal(store.getUserById(u.id)?.settings.position, "top-right");
});

test("deleteUser removes the user and its sessions", () => {
  const { store } = tmpStore();
  const u = store.createUser("e@test.com", "h", "s");
  const s = store.createSession(u.id, 10000);
  store.deleteUser(u.id);
  assert.equal(store.getUserById(u.id), undefined);
  assert.equal(store.getUserByEmail("e@test.com"), undefined);
  assert.equal(store.getUserByToken(u.token), undefined);
  assert.equal(store.getSession(s.id), undefined, "sessions must be cleared on delete");
});

test("sessions: create/get/delete and expiry", () => {
  const { store } = tmpStore();
  const u = store.createUser("f@test.com", "h", "s");
  const live = store.createSession(u.id, 10000);
  assert.equal(store.getSession(live.id)?.userId, u.id);
  store.deleteSession(live.id);
  assert.equal(store.getSession(live.id), undefined);

  const expired = store.createSession(u.id, -1); // already past
  assert.equal(store.getSession(expired.id), undefined, "expired session must not resolve");
});

test("persistence survives reopening the store (and migrates missing settings)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-store-"));
  const s1 = createStore(dir);
  const u = s1.createUser("g@test.com", "h", "s");
  // Simulate a legacy record without settings on disk.
  const file = path.join(dir, "crossfeed-db.json");
  const db = JSON.parse(fs.readFileSync(file, "utf8"));
  delete db.users[u.id].settings;
  fs.writeFileSync(file, JSON.stringify(db));

  const s2 = createStore(dir);
  const reloaded = s2.getUserById(u.id)!;
  assert.equal(reloaded.email, "g@test.com");
  assert.ok(reloaded.settings, "missing settings should be migrated to defaults");
  assert.equal(reloaded.settings.fontSize, 18);
});
