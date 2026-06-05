import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = Object.keys(vars);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("dataDir precedence: DATA_DIR > RAILWAY_VOLUME_MOUNT_PATH > default", () => {
  withEnv({ DATA_DIR: "/explicit/data", RAILWAY_VOLUME_MOUNT_PATH: "/railway/vol" }, () => {
    assert.equal(loadConfig().dataDir, "/explicit/data");
  });
  withEnv({ DATA_DIR: undefined, RAILWAY_VOLUME_MOUNT_PATH: "/railway/vol" }, () => {
    assert.equal(loadConfig().dataDir, "/railway/vol", "falls back to the Railway volume mount");
  });
  withEnv({ DATA_DIR: undefined, RAILWAY_VOLUME_MOUNT_PATH: undefined }, () => {
    assert.match(loadConfig().dataDir, /[/\\]data$/, "defaults to ./data");
  });
});
