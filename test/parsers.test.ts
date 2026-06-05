import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIrcLine } from "../src/ingesters/twitch-irc";
import { normalizeTwitchMessage, parseTwitchEmotes } from "../src/ingesters/twitch-normalize";
import { normalizeKickMessage, parseKickContent } from "../src/ingesters/kick-normalize";
import { normalizeXMessage } from "../src/ingesters/x-normalize";

test("parseIrcLine: tags, prefix, command, params, trailing", () => {
  const line =
    "@color=#1E90FF;display-name=Bob;emotes=25:0-4 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :Kappa hi";
  const m = parseIrcLine(line);
  assert.equal(m.command, "PRIVMSG");
  assert.equal(m.tags["display-name"], "Bob");
  assert.equal(m.tags["color"], "#1E90FF");
  assert.equal(m.nick, "bob");
  assert.deepEqual(m.params, ["#chan"]);
  assert.equal(m.trailing, "Kappa hi");
});

test("parseIrcLine: tag unescaping (\\s \\: \\\\)", () => {
  const m = parseIrcLine("@system-msg=hi\\sthere\\:ok\\\\done :x PRIVMSG #c :y");
  assert.equal(m.tags["system-msg"], "hi there;ok\\done");
});

test("parseIrcLine: PING fast path", () => {
  const m = parseIrcLine("PING :tmi.twitch.tv");
  assert.equal(m.command, "PING");
  assert.equal(m.trailing, "tmi.twitch.tv");
});

test("parseTwitchEmotes: code-point positions + dedupe", () => {
  // "Kappa hello Kappa" -> Kappa at 0-4 and 12-16
  const emotes = parseTwitchEmotes("25:0-4,12-16", "Kappa hello Kappa");
  assert.equal(emotes.length, 1);
  assert.equal(emotes[0]!.code, "Kappa");
  assert.match(emotes[0]!.url, /emoticons\/v2\/25\//);
});

test("normalizeTwitchMessage: badges, color, fallback color, id, ts", () => {
  const m = parseIrcLine(
    "@badges=broadcaster/1,subscriber/12;color=#1E90FF;display-name=Bob;id=abc;tmi-sent-ts=1700000000000 :bob!bob@bob PRIVMSG #chan :hello",
  );
  const n = normalizeTwitchMessage(m, "chan")!;
  assert.equal(n.platform, "twitch");
  assert.equal(n.author, "Bob");
  assert.equal(n.color, "#1E90FF");
  assert.deepEqual(n.badges, ["broadcaster", "subscriber"]);
  assert.equal(n.id, "abc");
  assert.equal(n.timestamp, 1700000000000);

  // no color -> deterministic fallback
  const n2 = normalizeTwitchMessage(parseIrcLine("@display-name=NoColor :x!x@x PRIVMSG #c :hi"), "c")!;
  assert.match(n2.color, /^#[0-9A-Fa-f]{6}$/);
});

test("normalizeTwitchMessage: non-PRIVMSG returns null", () => {
  assert.equal(normalizeTwitchMessage(parseIrcLine(":tmi.twitch.tv ROOMSTATE #c"), "c"), null);
});

test("parseKickContent: [emote:id:name] -> CDN url + cleaned text, deduped", () => {
  const { text, emotes } = parseKickContent("gg [emote:37226:EZ] nice [emote:37226:EZ]");
  assert.equal(text, "gg EZ nice EZ");
  assert.equal(emotes.length, 1);
  assert.equal(emotes[0]!.code, "EZ");
  assert.match(emotes[0]!.url, /files\.kick\.com\/emotes\/37226/);
});

test("normalizeKickMessage: badges/color/author, tolerant of missing identity", () => {
  const n = normalizeKickMessage(
    { id: "k1", created_at: "2026-06-04T21:00:00.000Z", content: "hi", sender: { username: "K", identity: { color: "#53FC18", badges: [{ type: "moderator" }] } } },
    "xqc",
  )!;
  assert.equal(n.platform, "kick");
  assert.equal(n.author, "K");
  assert.equal(n.color, "#53FC18");
  assert.deepEqual(n.badges, ["moderator"]);

  const n2 = normalizeKickMessage({ id: 2, content: "x", sender: { username: "Bob" } }, "c")!;
  assert.equal(n2.author, "Bob");
  assert.match(n2.color, /^#[0-9A-Fa-f]{6}$/);
});

test("normalizeXMessage: flat, double-encoded, control frame", () => {
  const flat = normalizeXMessage({ uuid: "x1", username: "u", display_name: "U", color: "#1DA1F2", body: "hi", timestamp: 1780000000000 }, "bc")!;
  assert.equal(flat.platform, "x");
  assert.equal(flat.author, "U");
  assert.equal(flat.text, "hi");

  const nested = normalizeXMessage({ payload: JSON.stringify({ uuid: "x2", username: "n", body: "nested" }) }, "bc")!;
  assert.equal(nested.author, "n");
  assert.equal(nested.text, "nested");

  assert.equal(normalizeXMessage({ kind: 2, ping: true }, "bc"), null, "control frame -> null");
});
