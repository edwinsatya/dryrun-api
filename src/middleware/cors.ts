/**
 * CORS.
 *
 * New problem created by the split: the frontend is a different origin now, so
 * every request the browser makes to this server is cross-origin and gets
 * preflighted.
 *
 * Not `*`. The allowed origin is read from FRONTEND_ORIGIN, with localhost
 * added while NODE_ENV is anything other than "production" so dev does not
 * need the variable set at all. An unlisted origin is refused rather than
 * silently reflected.
 */

import cors, { type CorsOptions } from "cors";

const LOCAL_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

function allowedOrigins(): string[] {
  const configured = (process.env.FRONTEND_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter((origin) => origin.length > 0);

  const development = process.env.NODE_ENV !== "production";
  const origins = development ? [...configured, ...LOCAL_ORIGINS] : configured;

  // Set, because FRONTEND_ORIGIN is usually localhost:3000 in dev too.
  return [...new Set(origins)];
}

const options: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: curl, the keepalive cron, a same-origin health check.
    // Nothing to widen, so nothing to refuse.
    if (!origin) return callback(null, true);

    const allowed = allowedOrigins();
    if (allowed.includes(origin.replace(/\/$/, ""))) {
      return callback(null, true);
    }

    return callback(new Error(`Origin ${origin} is not allowed.`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86_400,
};

export const corsMiddleware = cors(options);

/** Logged once at boot — a silently wrong origin is a confusing failure. */
export function describeCors(): string {
  return allowedOrigins().join(", ") || "(none configured)";
}
