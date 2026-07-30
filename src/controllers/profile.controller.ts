/**
 * GET /api/profile/:username
 *
 * The error boundary that matters most. Four states have to survive the trip
 * to a different origin and come back out of lib/api.ts as the same four
 * things the UI already renders:
 *
 *   USER_NOT_FOUND   404   →  <NotFound />
 *   RATE_LIMITED     429   →  <RateLimited retryAt={…} />   retryAt must survive
 *   NO_PUBLIC_REPOS  422   →  <NoRepos />
 *   UPSTREAM_ERROR   502   →  <UpstreamError />
 *
 * The body is the unmodified `ProfileResponse` the service returns, so the
 * code and `retryAt` travel in the payload and the status is a second,
 * redundant signal. Redundant on purpose: the client reads the body, so a
 * proxy rewriting the status cannot silently collapse two of these into one.
 */

import type { Request, Response } from "express";

import { fetchProfile } from "../services/github/queries.js";
import type {
  ProfileErrorCode,
  ProfileResponse,
} from "../types/candidate.js";

const STATUS: Record<ProfileErrorCode, number> = {
  USER_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  NO_PUBLIC_REPOS: 422,
  UPSTREAM_ERROR: 502,
};

export async function getProfile(
  request: Request,
  response: Response,
): Promise<void> {
  const username = String(request.params.username ?? "").trim();

  if (!username) {
    const body: ProfileResponse = {
      ok: false,
      error: { code: "USER_NOT_FOUND", message: "No username given." },
    };
    response.status(404).json(body);
    return;
  }

  const result: ProfileResponse = await fetchProfile(username);

  if (result.ok) {
    response.status(200).json(result);
    return;
  }

  // RATE_LIMITED carries `retryAt`, a unix timestamp the UI counts down from.
  // It rides inside result.error untouched; Retry-After is the same number in
  // the form the platform understands.
  if (result.error.code === "RATE_LIMITED" && result.error.retryAt) {
    const seconds = Math.max(
      0,
      Math.ceil(result.error.retryAt - Date.now() / 1000),
    );
    response.setHeader("Retry-After", String(seconds));
  }

  response.status(STATUS[result.error.code]).json(result);
}
