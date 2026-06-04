import { loadConfig } from "./config";
import { Hub } from "./hub";
import { closeSharedResources, INGESTER_FACTORIES } from "./ingesters";
import { logger, setLogLevel } from "./logger";
import { createServer } from "./server";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const log = logger.child("main");

  log.info("CrossFeed.tv starting…");
  log.info(
    `default channels — twitch=${cfg.defaults.twitch ?? "-"} kick=${cfg.defaults.kick ?? "-"} x=${cfg.defaults.x ?? "-"}`,
  );

  const hub = new Hub(cfg, INGESTER_FACTORIES);
  hub.start();

  const app = createServer(hub, cfg);
  await app.listen();

  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, shutting down`);
    try {
      hub.stop();
    } catch {
      /* ignore */
    }
    try {
      closeSharedResources();
    } catch {
      /* ignore */
    }
    app.close();
    setTimeout(() => process.exit(0), 250);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Isolation backstop: never let a stray async error from one ingester crash
  // the whole feed.
  process.on("uncaughtException", (err) => log.error("uncaughtException", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection", err));
}

main().catch((err) => {
  logger.error("fatal startup error", err);
  process.exit(1);
});
