import pino from "pino";

// Structured logger used across server code (loaders, actions, webhook handlers).
// Outputs JSON on Vercel — Vercel's Function Logs UI parses it and lets you filter
// by fields like { shop, topic, eventId }. Locally we use pino-pretty (dev only).
//
// Usage:
//   import { logger } from "../logger.server";
//   logger.info({ shop, topic, entityId }, "webhook received");
//   logger.error({ err, shop }, "webhook failed");
//
// Always pass structured fields as the FIRST argument and the human-readable
// message as the SECOND — never string-interpolate context into the message.

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  // Drop pid/hostname — noisy on serverless, every invocation is a fresh container.
  base: undefined,
  // Emit { "level": "info", ... } instead of numeric level codes.
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In local dev, pretty-print if pino-pretty is installed; in prod stay JSON.
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
});

// Convenience helper to attach a stable per-request context.
// Example: const log = logger.child({ shop, topic }); log.info("…");
export type Logger = typeof logger;
