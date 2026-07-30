/**
 * Shared plumbing for the interview services.
 *
 * Controllers take a username, not a profile. The profile is re-derived from
 * the cached GitHub queries and the plan is rebuilt by the pure planner, so the
 * eight topics a call works from are the same eight the client is showing —
 * without trusting the client to send them back.
 *
 * Nothing here knows about HTTP. The SessionError this throws is turned into a
 * status code in controllers/interview.controller.ts, which is the only place
 * that imports express.
 */

import { buildSessionPlan, type PlannedTopic } from "./plan.js";
import type { InterviewError } from "./types.js";
import { fetchProfile } from "../github/queries.js";
import type { CandidateProfile } from "../../types/candidate.js";

export class SessionError extends Error {
  readonly error: InterviewError;
  constructor(error: InterviewError) {
    super(error.message);
    this.name = "SessionError";
    this.error = error;
  }
}

export interface LoadedSession {
  profile: CandidateProfile;
  plan: PlannedTopic[];
}

export async function loadSession(username: string): Promise<LoadedSession> {
  const result = await fetchProfile(username);

  if (!result.ok) {
    throw new SessionError({
      code: result.error.code === "RATE_LIMITED" ? "RATE_LIMITED" : "USER_NOT_FOUND",
      message:
        result.error.code === "RATE_LIMITED"
          ? "GitHub request limit reached."
          : `No profile could be built for ${username}.`,
    });
  }

  return { profile: result.data, plan: buildSessionPlan(result.data) };
}

/** Resolves a 0-based question index against the plan. */
export function topicAt(plan: PlannedTopic[], index: unknown): PlannedTopic {
  const parsed = typeof index === "number" ? index : Number.NaN;
  const topic = Number.isInteger(parsed) ? plan[parsed] : undefined;

  if (!topic) {
    throw new SessionError({
      code: "UPSTREAM_ERROR",
      message: "That question is not part of this session.",
    });
  }

  return topic;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SessionError({
      code: "UPSTREAM_ERROR",
      message: `Missing "${field}".`,
    });
  }
  return value.trim();
}
