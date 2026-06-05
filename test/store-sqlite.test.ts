import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createSqliteStore } from "../src/store-sqlite";
import { DEFAULT_OVERLAY_SETTINGS } from "../src/types";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-sqlite-"));
  return { store: createSqliteStore(dir), dir };
}

test("sqlite: createUser sets defaults (empty channels, secure token, default settings)", () => {
  const { store } = tmpStore();
  const u = store.createUser("a@test.com", "hash", "salt");
  assert.deepEqual(u.channels, {});
  assert.match(u.token, /^[0-9a-f]+$/);
  assert.ok(u.token.length >= 32);
  assert.equal(u.settings.fontSize, 18);
  assert.equal(u.settings.position, "bottom-left");
  assert.deepEqual(u.settings.show, { twitch: true, kick: true, x: true });
});

test("sqlite: lookups by email / id / token", () => {
  const { store } = tmpStore();
  const u = store.createUser("b@test.com", "h", "s");
  assert.equal(store.getUserByEmail("b@test.com")?.id, u.id);
  assert.equal(store.getUserById(u.id)?.email, "b@test.com");
  assert.equal(store.getUserByToken(u.token)?.id, u.id);
  assert.equal(store.getUserByEmail("missing@test.com"), undefined);
  assert.equal(store.getUserByToken("deadbeef"), undefined);
});

test("sqlite: tokens are unique across users", () => {
  const { store } = tmpStore();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const u = store.createUser(`u${i}@test.com`, "h", "s");
    assert.ok(!seen.has(u.token), "token collision");
    seen.add(u.token);
  }
});

test("sqlite: rotateToken invalidates the old token", () => {
  const { store } = tmpStore();
  const u = store.createUser("c@test.com", "h", "s");
  const old = u.token;
  const rotated = store.rotateToken(u.id)!;
  assert.notEqual(rotated.token, old);
  assert.equal(store.getUserByToken(old), undefined);
  assert.equal(store.getUserByToken(rotated.token)?.id, u.id);
});

test("sqlite: updateChannels (defined-only) and updateSettings persist", () => {
  const { store } = tmpStore();
  const u = store.createUser("d@test.com", "h", "s");
  store.updateChannels(u.id, { twitch: "xqc", kick: undefined, x: undefined });
  const after = store.getUserById(u.id)!;
  assert.equal(after.channels.twitch, "xqc");
  assert.equal("kick" in after.channels, false, "undefined platforms should not be stored");
  store.updateSettings(u.id, { ...u.settings, fontSize: 30, position: "top-right" });
  assert.equal(store.getUserById(u.id)?.settings.fontSize, 30);
  assert.equal(store.getUserById(u.id)?.settings.position, "top-right");
});

test("sqlite: deleteUser removes the user and cascades its sessions", () => {
  const { store } = tmpStore();
  const u = store.createUser("e@test.com", "h", "s");
  const s = store.createSession(u.id, 10000);
  store.deleteUser(u.id);
  assert.equal(store.getUserById(u.id), undefined);
  assert.equal(store.getUserByEmail("e@test.com"), undefined);
  assert.equal(store.getUserByToken(u.token), undefined);
  assert.equal(store.getSession(s.id), undefined, "sessions must cascade on delete");
});

test("sqlite: sessions create/get/delete and expiry", () => {
  const { store } = tmpStore();
  const u = store.createUser("f@test.com", "h", "s");
  const live = store.createSession(u.id, 10000);
  assert.equal(store.getSession(live.id)?.userId, u.id);
  store.deleteSession(live.id);
  assert.equal(store.getSession(live.id), undefined);
  const expired = store.createSession(u.id, -1);
  assert.equal(store.getSession(expired.id), undefined, "expired session must not resolve");
});

test("sqlite: persistence survives reopening the store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-sqlite-"));
  const s1 = createSqliteStore(dir);
  const u = s1.createUser("g@test.com", "h", "s");
  s1.updateChannels(u.id, { twitch: "abc", kick: undefined, x: undefined });

  const s2 = createSqliteStore(dir);
  const reloaded = s2.getUserById(u.id)!;
  assert.equal(reloaded.email, "g@test.com");
  assert.equal(reloaded.channels.twitch, "abc");
  assert.equal(reloaded.settings.fontSize, 18);
});

test("sqlite: imports an existing crossfeed-db.json on first open (once)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-sqlite-"));
  // Seed a legacy JSON store file by hand.
  const legacyUser = {
    id: "legacy-id",
    email: "old@test.com",
    passwordHash: "ph",
    salt: "sl",
    createdAt: 1700000000000,
    channels: { twitch: "legacytv" },
    token: "a".repeat(48),
    settings: { ...DEFAULT_OVERLAY_SETTINGS },
  };
  fs.writeFileSync(
    path.join(dir, "crossfeed-db.json"),
    JSON.stringify({ users: { "legacy-id": legacyUser }, sessions: {} }),
  );

  const s1 = createSqliteStore(dir);
  const imported = s1.getUserByEmail("old@test.com");
  assert.ok(imported, "legacy user should be imported");
  assert.equal(imported!.channels.twitch, "legacytv");
  assert.equal(s1.getUserByToken("a".repeat(48))?.id, "legacy-id");

  // Reopening must NOT re-import (and must not duplicate or clobber new data).
  const s2 = createSqliteStore(dir);
  const fresh = s2.createUser("new@test.com", "h", "s");
  const s3 = createSqliteStore(dir);
  assert.equal(s3.getUserByEmail("new@test.com")?.id, fresh.id);
  assert.equal(s3.getUserByEmail("old@test.com")?.id, "legacy-id");
});
