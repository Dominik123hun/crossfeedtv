import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseIngester, type IngesterState } from "../src/ingesters/base";
import type { ReconnectConfig } from "../src/config";
import { logger, setLogLevel } from "../src/logger";
import type { NormalizedMessage, Platform } from "../src/types";

setLogLevel("error");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A BaseIngester whose transport is driven by the test (no real sockets). */
class TestIngester extends BaseIngester {
  readonly platform: Platform = "twitch";
  connects = 0;
  disconnects = 0;
  protected doConnect(): void {
    this.connects++;
  }
  protected doDisconnect(): void {
    this.disconnects++;
  }
  // drive the protected lifecycle hooks from the test
  open(): void {
    this.onConnected();
  }
  drop(info?: string): void {
    this.onClosed(info);
  }
  send(m: NormalizedMessage): void {
    this.emit(m);
  }
}

const cfg = (over: Partial<ReconnectConfig> = {}): ReconnectConfig => ({
  initialMs: 20,
  maxMs: 80,
  factor: 2,
  jitter: 0,
  connectTimeoutMs: 5000,
  ...over,
});

const sample: NormalizedMessage = {
  id: "1",
  platform: "twitch",
  channel: "c",
  author: "a",
  color: "#fff",
  badges: [],
  text: "hi",
  emotes: [],
  timestamp: 0,
};

test("connect -> connected, then reconnects after a drop, then stop cancels", async () => {
  const states: IngesterState[] = [];
  const ing = new TestIngester("c", cfg(), logger.child("t"), {
    onState: (s) => states.push(s),
  });

  ing.start();
  assert.equal(ing.connects, 1);
  assert.equal(ing.state, "connecting");

  ing.open();
  assert.equal(ing.state, "connected");

  ing.drop("boom");
  assert.equal(ing.state, "reconnecting");
  await sleep(50); // > initialMs (20)
  assert.ok(ing.connects >= 2, "should have reconnected after backoff");

  ing.stop();
  assert.equal(ing.state, "stopped");
  const after = ing.connects;
  await sleep(60);
  assert.equal(ing.connects, after, "no reconnects after stop()");
  assert.ok(states.includes("connected") && states.includes("reconnecting"));
});

test("connect watchdog tears down a hung connect that never reaches connected", async () => {
  const ing = new TestIngester("c", cfg({ initialMs: 1000, connectTimeoutMs: 40 }), logger.child("t"), {});
  ing.start();
  assert.equal(ing.disconnects, 0);
  await sleep(70); // watchdog (40ms) should fire since open() was never called
  assert.ok(ing.disconnects >= 1, "watchdog should tear down the hung connect");
  assert.equal(ing.state, "reconnecting");
  ing.stop();
});

test("throwing event handlers are isolated (never propagate out of the ingester)", () => {
  const ing = new TestIngester("c", cfg({ connectTimeoutMs: 5000 }), logger.child("t"), {
    onMessage: () => {
      throw new Error("onMessage boom");
    },
    onState: () => {
      throw new Error("onState boom");
    },
  });
  assert.doesNotThrow(() => ing.start(), "onState throw must not escape");
  assert.doesNotThrow(() => ing.open());
  assert.doesNotThrow(() => ing.send(sample), "onMessage throw must not escape emit()");
  ing.stop();
});

test("double start is a no-op; stop before start is safe", () => {
  const ing = new TestIngester("c", cfg(), logger.child("t"), {});
  ing.stop(); // before start
  ing.start();
  ing.start(); // second start should not re-open
  assert.equal(ing.connects, 1);
  ing.stop();
});
