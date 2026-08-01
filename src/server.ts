/**
 * LOCAL DEVELOPMENT ONLY. Not the production entry point.
 *
 * In production this file is never loaded: Vercel imports api/index.ts, which
 * calls the same createApp() and exports the app without binding a port. This
 * one exists so `npm run dev` still gives a long-running server on :4000.
 *
 * Everything below the app construction — the port bind, the signal handlers,
 * the forced-exit timer — is local-only scaffolding and is marked as such
 * individually. A reader should not have to infer which half of this file runs
 * in production, because the answer is none of it.
 *
 * dotenv is imported before anything else, because the service modules read
 * process.env at call time and a half-loaded environment is the kind of bug
 * that only shows up as a provider mysteriously having no key. On Vercel the
 * same variables arrive from the platform and there is no .env to read.
 */

import "dotenv/config";

import { createApp } from "./app.js";
import { describeCors } from "./middleware/cors.js";

const PORT = Number(process.env.PORT ?? 4000);

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[api] dryrun-api listening on http://localhost:${PORT}`);
  console.log(`[api] cors origins: ${describeCors()}`);

  // Named, not valued. Which keys are missing is the first thing to check when
  // a provider is dead, and printing it at boot beats discovering it mid-demo.
  const missing = [
    "GITHUB_TOKEN",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
  ].filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    console.warn(`[api] not set: ${missing.join(", ")} — see .env.example`);
  }
});

/**
 * Graceful shutdown — LOCAL ONLY.
 *
 * An interview call can be twenty seconds of model latency and a retry deep;
 * killing the process underneath one loses an answer the candidate already
 * typed. Stop accepting, let the in-flight ones land.
 *
 * None of this runs on Vercel. There is no long-lived process to signal: the
 * platform freezes the container between invocations and reclaims it without
 * SIGTERM, so an in-flight request is bounded by maxDuration rather than by
 * anything this could do about it. Left in place because `npm run dev` is a
 * real process and Ctrl-C on it should still be tidy.
 */
function shutdown(signal: string): void {
  console.log(`[api] ${signal} received, closing`);

  server.close(() => {
    console.log("[api] closed");
    process.exit(0);
  });

  // Nothing here should take ten seconds. If it does, something is wedged and
  // hanging forever is worse than dropping it.
  setTimeout(() => {
    console.error("[api] forced exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
