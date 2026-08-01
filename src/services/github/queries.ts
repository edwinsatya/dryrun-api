/**
 * Cached GitHub reads.
 *
 * Budget: exactly 12 requests per profile —
 *   1 user + 1 repo list + 5 READMEs + 5 package.json files.
 *
 * /languages is deliberately never called; language totals are aggregated from
 * the `language` field already present in the repo list response.
 *
 * Caching moved from Next's `'use cache'` to utils/cache.ts on the split. Two
 * things carried over from the cacheLife() calls that used to be here:
 *
 *   - the cache is keyed on the username and holds the whole assembled
 *     profile, so a repeat read inside the hour costs nothing at all rather
 *     than costing whichever of the twelve requests happened to expire first;
 *   - a failure is never pinned for an hour. A rate limit or an outage is a
 *     temporary condition, and caching one would outlast the thing it
 *     describes.
 *
 * The promise is cached rather than the resolved value, so eight interview
 * calls racing on a cold cache still spend one profile's worth of requests.
 */

import { githubFetch, type GitHubResult } from "./client.js";
import {
  analyze,
  selectDeepReadRepos,
  type GitHubRepo,
  type GitHubUser,
  type RepoDeepRead,
} from "./analyze.js";
import type { ProfileResponse } from "../../types/candidate.js";
import { dedupe, getCached, ONE_HOUR_MS, setCached } from "../../utils/cache.js";

/** README characters kept as prompt material. */
const README_LIMIT = 500;

/** How long a failed profile is held. Long enough to absorb a reload, no more. */
const FAILURE_TTL_MS = 30_000;

export async function getUser(login: string): Promise<GitHubResult<GitHubUser>> {
  return githubFetch<GitHubUser>(`/users/${encodeURIComponent(login)}`);
}

export async function getRepos(
  login: string,
): Promise<GitHubResult<GitHubRepo[]>> {
  return githubFetch<GitHubRepo[]>(
    `/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed`,
  );
}

/**
 * Raw README text, truncated. Returns null when the repo has no README —
 * a 404 here is normal and must not fail the profile.
 */
export async function getReadme(
  owner: string,
  repo: string,
): Promise<string | null> {
  const result = await githubFetch<string>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    { accept: "application/vnd.github.raw", raw: true },
  );

  if (!result.ok) return null;

  const text = result.data.trim();
  return text.length > README_LIMIT ? text.slice(0, README_LIMIT) : text;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * dependencies + devDependencies flattened into one list.
 * Returns null when the repo has no package.json — normal for non-JS repos.
 */
export async function getPackageJson(
  owner: string,
  repo: string,
): Promise<string[] | null> {
  const result = await githubFetch<ContentsResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/package.json`,
  );

  if (!result.ok) return null;

  const { content, encoding } = result.data;
  // Files above 1 MB come back with an empty body and encoding "none".
  if (!content || encoding !== "base64") return null;

  try {
    const decoded = Buffer.from(content, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as PackageJsonShape;
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
  } catch {
    // Malformed or non-JSON package.json — treat as absent.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Requests spent on one profile: user + repo list + 2 per deep-read repo. */
export function requestCost(deepReadCount: number): number {
  return 2 + deepReadCount * 2;
}

/**
 * The whole profile, in at most 12 requests.
 *
 * READMEs and manifests are settled independently: a repo without a
 * package.json is normal, and one miss never fails the profile.
 */
async function loadProfile(login: string): Promise<ProfileResponse> {
  const user = await getUser(login);
  if (!user.ok) return { ok: false, error: user.error };

  const repos = await getRepos(login);
  if (!repos.ok) return { ok: false, error: repos.error };

  if (repos.data.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_PUBLIC_REPOS",
        message: "This account has no public repositories.",
      },
    };
  }

  const selected = selectDeepReadRepos(repos.data);

  const deepReads: RepoDeepRead[] = await Promise.all(
    selected.map(async (repo): Promise<RepoDeepRead> => {
      const [readme, pkg] = await Promise.allSettled([
        getReadme(login, repo.name),
        getPackageJson(login, repo.name),
      ]);

      return {
        name: repo.name,
        readme: readme.status === "fulfilled" ? readme.value : null,
        dependencies: pkg.status === "fulfilled" ? pkg.value : null,
      };
    }),
  );

  return {
    ok: true,
    data: analyze({ user: user.data, repos: repos.data, deepReads }),
  };
}

/** GitHub logins are case-insensitive, so the cache key must be too. */
function cacheKey(login: string): string {
  return `profile:${login.trim().toLowerCase()}`;
}

/**
 * The cached entry point. Every caller goes through this — the profile route,
 * and every interview route by way of loadSession().
 *
 * Both cache layers are here, in this order:
 *
 *   dedupe()   one fetch per key while it is in flight in this process
 *   Redis      the resolved profile, shared across invocations
 *   GitHub     only when neither of the above answered
 *
 * The Redis read sits inside dedupe rather than before it so that concurrent
 * callers share the round-trip to Redis too, not only the fetch to GitHub.
 *
 * A store that is down is indistinguishable from a miss by design, so this
 * degrades to exactly the behaviour it had before any cache existed: it calls
 * GitHub. redis.ts logs the degradation once, so the cost is visible.
 */
export function fetchProfile(login: string): Promise<ProfileResponse> {
  const key = cacheKey(login);

  return dedupe(key, async () => {
    const hit = await getCached<ProfileResponse>(key);
    if (hit) return hit;

    const result = await loadProfile(login);

    // Shorten the hour to seconds if the profile did not build. Nothing here
    // is worth remembering: not a 404 on a name that may be a typo, and
    // certainly not a rate limit that expires on GitHub's clock, not ours.
    await setCached(key, result, result.ok ? ONE_HOUR_MS : FAILURE_TTL_MS);

    return result;
  });
}
