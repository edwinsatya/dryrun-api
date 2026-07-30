# dryrun-api

The Express backend for Dryrun. It reads GitHub, builds a `CandidateProfile`,
and makes every LLM call. The Next app in `../dryrun` is frontend only and holds
no keys.

## Running it

```bash
npm install
cp .env.example .env      # then fill in the three keys
npm run dev               # tsx watch, port 4000
```

```bash
npm run build && npm start   # tsc to dist/, then node
```

Start this before the frontend. `GET /health` is the fastest way to know it is
alive and that both providers are answering.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Both LLM providers, probed directly. Keepalive + pre-demo check. |
| `GET` | `/api/profile/:username` | The whole profile. Cached one hour. |
| `POST` | `/api/interview/question` | `{ username, index, history, params, rerun? }` |
| `POST` | `/api/interview/score` | `{ username, index, question, answer, params }` |
| `POST` | `/api/interview/followup` | `{ username, index, question, answer, assessment, turns, message, params }` |
| `POST` | `/api/interview/summary` | `{ username, results, params }` |

`username` travels in the body on the interview routes rather than in the path.
That is the only request-shape change from the Next route handlers these
replaced; the response envelopes are identical.

### Profile error states

Four, and the frontend renders a different screen for each. The code is in the
body and the status is a second, redundant signal.

| Code | Status | Carries |
| --- | --- | --- |
| `USER_NOT_FOUND` | 404 | |
| `RATE_LIMITED` | 429 | `retryAt` (unix seconds) + `Retry-After` |
| `NO_PUBLIC_REPOS` | 422 | |
| `UPSTREAM_ERROR` | 502 | |

## Layout

```
src/
├─ server.ts        port binding, graceful shutdown
├─ app.ts           middleware chain, route mounting
├─ routes/          paths only, no logic
├─ controllers/     request in, service call, status out
├─ services/        business logic — github, llm, interview
├─ middleware/      cors, errorHandler, requestLogger
├─ utils/cache.ts   in-memory TTL cache
└─ types/           candidate.ts (source of truth), api.ts (wire shapes)
```

**Nothing in `services/` imports express.** That is the rule that made the split
cheap in the first place — the whole directory arrived from the Next app's
`lib/` almost unchanged, because it never knew what was calling it. Keep it that
way: a controller translates to HTTP, a service does not.

## Caching

`utils/cache.ts` is a `Map` with timestamps and a one-hour TTL, keyed by
username. It replaces Next's `'use cache'`, which does not exist here.

It matters more than it looks. A profile costs exactly 12 GitHub requests
(1 user + 1 repo list + 5 READMEs + 5 manifests), and every interview call
re-derives the profile from the username. Without the cache a single
eight-question session would spend well over a hundred requests.

A failure is held for 30 seconds, not an hour — a rate limit that expires on
GitHub's clock must not be pinned by ours. The promise is cached rather than the
resolved value, so concurrent first requests for the same username collapse into
one fetch.

No Redis. One process, one hour, a handful of usernames.

## Shared types

`src/types/candidate.ts` is the **source of truth** for `CandidateProfile`. It is
mirrored by hand at `dryrun/src/lib/types/candidate.ts`, minus its header note.
Three smaller files are mirrored the same way:

| Source of truth here | Mirror in `dryrun/` |
| --- | --- |
| `src/types/candidate.ts` | `src/lib/types/candidate.ts` |
| `src/services/interview/params.ts` | `src/lib/interview/params.ts` |
| `src/services/interview/types.ts` | `src/lib/interview/types.ts` (partial) |
| `src/services/llm/types.ts` | `src/lib/llm/types.ts` (partial) |
| `src/services/github/analyze.ts` | `src/lib/display.ts` (display helpers only) |

**Edit here first, then copy across.** No npm package and no git submodule: at
two repositories and one developer, a publish step per type change costs more
than the copies do. Revisit at three repositories.

`params.ts` is the copy to be careful with, because both halves execute it — the
panel clamps a value before writing it to the URL, and the controller clamps it
again on arrival. Drift there shows up as a prompt inspector reporting a
temperature the model did not actually get.

## Environment

Every secret in the project lives here; see `.env.example`. `.env*` is
gitignored except the example.

| Variable | |
| --- | --- |
| `PORT` | default 4000 |
| `FRONTEND_ORIGIN` | CORS allowlist. `localhost:3000` is added automatically outside production. |
| `GITHUB_TOKEN` | public repo read only |
| `GEMINI_API_KEY` | primary provider |
| `GROQ_API_KEY` | fallback provider |
| `GEMINI_MODEL`, `GROQ_MODEL` | optional overrides; preview models get withdrawn at short notice |

CORS is restricted to `FRONTEND_ORIGIN`, never `*`. The allowed origins are
printed at boot.

## Providers

Gemini is primary, Groq is the fallback. Each gets three attempts with
exponential backoff before the request falls through to the other, and both the
fallover and the provider that finally answered are logged:

```
[llm] groq (openai/gpt-oss-120b) failed after 3 attempts — RATE_LIMITED: … — falling back to gemini (…)
[llm] answered by fallback gemini (…); groq did not respond
```

That logging is deliberate. A silently absorbed primary failure is the dangerous
case: from outside, a dead Gemini looks exactly like success. The answering
provider also travels back to the client on every response, so the UI can say
which model actually spoke.

`GET /health` probes each provider directly, with no retries and no fallover, so
its answer is the truth about that one provider. `ok` means the primary
answered; `degraded` means only the fallback did. It returns 503 only when
neither can answer.
