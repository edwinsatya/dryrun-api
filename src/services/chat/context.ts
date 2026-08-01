/**
 * The assistant's view of a candidate, assembled here and never accepted from
 * the client.
 *
 * This is the security boundary of the feature. The request carries a username
 * and nothing else about the profile; the summary, the stack and the evidence
 * ledger are all re-derived from the same cached profile service the interview
 * uses. A caller who posts a fabricated profile alongside their username finds
 * it ignored, because there is no field on the request for it to arrive in.
 *
 * The cost of doing it this way is nil in practice: fetchProfile is memoised
 * for an hour, so by the time anyone opens the assistant on a profile page the
 * profile is already in memory.
 */

import { buildSessionPlan } from "../interview/plan.js";
import { fetchProfile } from "../github/queries.js";

export interface EvidenceLine {
  topic: string;
  why: string;
}

export interface StackLine {
  name: string;
  evidence: string;
}

/** The live question, when the widget is open during an interview. */
export interface ActiveQuestion {
  index: number;
  topic: string;
  question: string;
  /** the locked configuration, already rendered for reading */
  config: string;
}

export interface ProfileContext {
  profile: {
    login: string;
    summary: string;
    stack: StackLine[];
    evidence: EvidenceLine[];
  };
  active: ActiveQuestion | null;
}

/** How many topics and technologies reach the prompt. */
const MAX_STACK = 12;

/**
 * The profile context for a username, or null when there is no such profile.
 *
 * Null rather than throwing: a chat request naming an unknown user should get
 * a reply that says so, not an error envelope. The assistant is allowed to be
 * unhelpful; it is not allowed to fail the page.
 */
export async function loadProfileContext(
  username: string,
  active: ActiveQuestion | null,
): Promise<ProfileContext | null> {
  const result = await fetchProfile(username);
  if (!result.ok) return null;

  const profile = result.data;
  const plan = buildSessionPlan(profile);

  return {
    profile: {
      login: profile.identity.login,
      summary: profile.summary,
      stack: profile.stack.slice(0, MAX_STACK).map((tech) => ({
        name: tech.name,
        // The first piece of evidence is the strongest; the rest repeat it.
        evidence: tech.evidence[0]
          ? `${tech.evidence[0].reason} (${tech.evidence[0].repo})`
          : `seen in ${tech.repoCount} repositor${tech.repoCount === 1 ? "y" : "ies"}`,
      })),
      evidence: plan.map((topic) => ({
        topic: topic.topic,
        why: topic.evidence[0]
          ? `${topic.evidence[0].reason} (${topic.evidence[0].repo})`
          : `drawn from ${topic.sourceRef}`,
      })),
    },
    active,
  };
}
