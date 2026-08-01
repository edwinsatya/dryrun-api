/**
 * GET /health
 *
 * Two jobs: the keepalive cron pings it to keep a free-tier dyno warm, and it
 * is the pre-demo check. Both need the same thing — the truth about each
 * provider individually.
 *
 * That distinction is the whole point. A dead primary is invisible from the
 * outside: the fallback answers, the page renders, and a session runs on the
 * wrong provider with nothing looking wrong. checkProviders() calls each one
 * directly, no retries and no fallover, so a green light here means green.
 */

import type { Request, Response } from "express";

import { checkProviders } from "../services/llm/health.js";
import { inFlightCount } from "../utils/cache.js";
import { redisHealth } from "../utils/redis.js";
import type { HealthResponse } from "../types/api.js";

export async function getHealth(
  _request: Request,
  response: Response,
): Promise<void> {
  const [providers, store] = await Promise.all([
    checkProviders(),
    redisHealth(),
  ]);
  const primary = providers[0];

  const body: HealthResponse = {
    // Healthy means the primary answered. The fallback covering for it is
    // survivable, but it is not health.
    ok: primary?.ok ?? false,
    degraded: !primary?.ok && providers.some((p) => p.ok),
    containerAgeSeconds: Math.round(process.uptime()),
    store,
    inFlight: inFlightCount(),
    providers,
  };

  // 503 only when nothing can answer at all — a degraded server is still one
  // an interview can run against, and the cron should not page for it.
  response.status(providers.some((p) => p.ok) ? 200 : 503).json(body);
}
