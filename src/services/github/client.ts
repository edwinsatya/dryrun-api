/**
 * The single fetch wrapper every GitHub request goes through.
 *
 * Server-only. GITHUB_TOKEN must never leak into a client bundle — this module
 * is imported exclusively by queries.ts, which is itself only reachable from
 * server components and route handlers.
 */

import type { ProfileError } from "../../types/candidate.js";

const API = "https://api.github.com";

export interface RateLimit {
  /** requests left in the current window, null when GitHub omitted the header */
  remaining: number | null;
  /** unix seconds at which the window resets */
  reset: number | null;
}

export type GitHubResult<T> =
  | { ok: true; data: T; rateLimit: RateLimit }
  | { ok: false; error: ProfileError; rateLimit: RateLimit };

interface RequestOptions {
  /** overrides the default vnd.github+json, e.g. the raw README media type */
  accept?: string;
  /** parse the body as text instead of JSON */
  raw?: boolean;
}

function readRateLimit(headers: Headers): RateLimit {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  return {
    remaining: remaining === null ? null : Number(remaining),
    reset: reset === null ? null : Number(reset),
  };
}

function toError(status: number, rateLimit: RateLimit): ProfileError {
  if (status === 404) {
    return { code: "USER_NOT_FOUND", message: "Not found on GitHub." };
  }

  // 403 and 429 both carry rate limiting; only treat it as such when the
  // window is actually exhausted, otherwise it is an ordinary upstream refusal.
  if ((status === 403 || status === 429) && rateLimit.remaining === 0) {
    return {
      code: "RATE_LIMITED",
      message: "GitHub request limit reached.",
      ...(rateLimit.reset !== null ? { retryAt: rateLimit.reset } : {}),
    };
  }

  return {
    code: "UPSTREAM_ERROR",
    message: `GitHub responded with ${status}.`,
  };
}

export async function githubFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<GitHubResult<T>> {
  const token = process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: options.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers });
  } catch {
    // DNS failure, timeout, offline — indistinguishable from GitHub being down.
    return {
      ok: false,
      error: { code: "UPSTREAM_ERROR", message: "Could not reach GitHub." },
      rateLimit: { remaining: null, reset: null },
    };
  }

  const rateLimit = readRateLimit(response.headers);

  if (!response.ok) {
    return { ok: false, error: toError(response.status, rateLimit), rateLimit };
  }

  const data = (options.raw
    ? await response.text()
    : await response.json()) as T;

  return { ok: true, data, rateLimit };
}
