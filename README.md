# dryrun-api

The Express backend for Dryrun. It reads GitHub, builds a `CandidateProfile`,
makes every LLM call, and signs every file upload. The Next app in `../dryrun`
is frontend only and holds no keys.

**API:** <https://dryrun-api.touchsimpledev.site> · **App:** <https://dryrun.touchsimpledev.site>

## Running it

```bash
npm install
cp .env.example .env      # then fill it in — see Environment
npm run dev               # tsx watch, port 4000
```

```bash
npm run typecheck         # tsc over src/ and api/
npm run build && npm start
```

Start this before the frontend. `GET /health` is the fastest way to know it is
alive, which provider is answering, and whether the external store is reachable.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Both providers probed directly, plus store liveness. |
| `GET` | `/api/profile/:username` | The whole profile. Cached one hour. |
| `POST` | `/api/interview/question` | `{ username, index, history, params, rerun? }` |
| `POST` | `/api/interview/score` | `{ username, index, question, answer, params }` |
| `POST` | `/api/interview/followup` | `{ username, index, question, answer, assessment, turns, message, params }` |
| `POST` | `/api/interview/summary` | `{ username, results, params }` |
| `POST` | `/api/chat` | Assistant reply. Rate limited. |
| `POST` | `/api/chat/upload/sign` | A signed ticket for one direct upload. Rate limited. |
| `POST` | `/api/chat/upload/complete` | Turns an uploaded URL into text. Rate limited. |
| `GET` | `/api/chat/budget` | Vision requests used against the daily cap. |

`username` travels in the body on the interview routes rather than in the path.
That is the only request-shape change from the Next route handlers these
replaced; the response envelopes are identical.

The interview routes are deliberately **not** rate limited: reaching them costs
a GitHub username that must resolve to a real profile, and the flow is eight
questions long. The assistant has no such shape — one POST with a string in it,
from anyone — so the limit lives on that surface only.

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
api/index.ts        the Vercel entry point — exports createApp()
src/
├─ server.ts        LOCAL ONLY: port binding, graceful shutdown
├─ app.ts           middleware chain, route mounting
├─ routes/          paths only, no logic
├─ controllers/     request in, service call, status out
├─ services/
│  ├─ github/       profile reads and analysis
│  ├─ llm/          the provider chain — timeout, retry, breaker, fallover
│  ├─ interview/    the four scored calls
│  ├─ chat/         the assistant: prompts, context, vision
│  └─ upload/       signatures, transcription, document extraction
├─ middleware/      cors, rateLimit, errorHandler, requestLogger
├─ utils/
│  ├─ redis.ts      Upstash over REST, degrades rather than throws
│  └─ cache.ts      two-layer profile cache
└─ types/           candidate.ts (source of truth), api.ts (wire shapes)
```

**Nothing in `services/` imports express.** That is the rule that made the
split cheap in the first place — the whole directory arrived from the Next
app's `lib/` almost unchanged, because it never knew what was calling it. Keep
it that way: a controller translates to HTTP, a service does not.

## Providers

**Groq is primary, Gemini is the fallback.** That order is not about quality —
it is about quota, and the numbers are not close:

| | Model | Free-tier ceiling |
| --- | --- | --- |
| Groq (primary) | `openai/gpt-oss-120b` | 1,000 requests/day, 8,000 TPM |
| Gemini (fallback) | `gemini-3-flash-preview` | **20 requests/day per model** |

One eight-question interview is 17+ model calls. A Gemini-first chain therefore
spends its entire day on a single session, and every visitor after that lands on
a degraded app. Gemini stays as the fallback, where 20 high-quality calls a day
are worth having.

`PROVIDER_ORDER` in `services/llm/types.ts` is the single source of truth for
the order, and `/health` reads it too — so "primary" there means the same thing
it means in the chain. Note that `DEFAULT_INTERVIEW_PARAMS.provider` also has to
agree with it: `jsonCall` sends the provider explicitly, so that default is what
actually decides the order for an interview.

### The chain

One logical call is bounded three ways, because an unbounded chain is how one
misbehaving model once turned a single question into 71 seconds of waiting.

| | Value | Why |
| --- | --- | --- |
| Attempts | primary 2 (one retry), fallback 1 | A model that cannot answer twice will not answer on the third try. |
| Per attempt | 20s | Sized to fit the platform, not the model — see Deployment. |
| Whole chain | 38s | Three attempts at 20s is the whole function; this caps the total. |
| Fallback reserve | 12s | Withheld while any provider is untried, so a slow primary cannot spend the fallback's turn. |
| Minimum attempt | 5s | Below this a call cannot finish, so starting one only delays reaching someone who could answer. |
| Circuit breaker | 2 consecutive failures | Per scope, 1h TTL, closed by any success. |

The reserve exists because of a measured failure: two 21s attempts consumed the
whole budget and the request failed outright, while the fallback that would have
answered it in 2s was never called.

Every model call logs one line, and every fallover logs another:

```
[llm] groq openai/gpt-oss-120b 922ms attempts=1 finish=stop tokens=234/1234
[llm] groq (…) failed after 1 attempt(s) — RATE_LIMITED: … — falling back to gemini (…)
[llm] circuit open for groq (…) on scope "octocat" — 2 consecutive failures
```

That logging is deliberate. A silently absorbed primary failure is the dangerous
case: from outside, a dead primary looks exactly like success. `finishReason` is
carried for the same reason — a reply truncated at the token ceiling and a reply
the model chose to end are the same string to everything downstream.

## External state

Everything that has to outlive a single request lives in **Upstash Redis**, over
its REST API. Under serverless there is no long-lived process, so anything held
in memory silently stops working — and two of these fail *open*, meaning the
system looks healthy while the guard is gone.

| What | Key | TTL |
| --- | --- | --- |
| Profile cache | `profile:<login>` | 1h, or 30s on failure |
| Circuit breaker | `breaker:<scope>:<provider>` | 1h |
| Per-IP rate limit | `ratelimit:<ip>` | 10m window |
| Daily vision cap | `vision:daily` | 24h |

REST rather than a TCP client on purpose: a serverless invocation has no stable
lifetime to hold a pooled connection across, and a socket that outlives its
container is a leak nobody sees until the connection limit is reached.

**`utils/redis.ts` degrades rather than throws.** A read that cannot reach Redis
reports a miss; a write is dropped. Callers then do the safe thing for their own
case — refetch the profile, treat the circuit as closed, let the request through
— and the degradation is logged once, so an unenforced period is visible in the
logs rather than inferred.

Two things stay in memory on purpose. The memoised `thinkingConfig` rejection
and the cached Gemini SDK client are performance memos, not guards: their worst
case is one wasted round-trip per container, and moving them would put a network
hop in front of every call to save one per container.

### The profile cache is two layers

```
dedupe()   one fetch per username while it is in flight in this process
Redis      the resolved profile, shared across invocations
GitHub     only when neither answered
```

The in-process layer holds a **promise**, which is exactly why it cannot be
Redis — a promise is a handle on work happening in this process, and there is no
serialisation of it another invocation could await. Without it, a burst of
concurrent requests multiplies GitHub calls inside a single invocation.

It matters more than it looks. A profile costs exactly 12 GitHub requests
(1 user + 1 repo list + 5 READMEs + 5 manifests), and every interview call
re-derives the profile from the username. Without the cache a single
eight-question session would spend well over a hundred requests.

## The assistant

A separate surface from the interview, and the separation is enforced rather
than intended. The two system prompts share no prose: an assistant that drifts
into asking interview questions, or an interviewer that turns helpful mid-
assessment, is not recoverable from inside a session.

The assistant reads context and answers. It never scores, never asks interview
questions, and never writes into the session.

**Profile context is fetched server-side.** The request carries a username and
nothing else about the profile — there is no field for one to arrive in — so a
caller who posts a fabricated profile finds it ignored. The one thing taken from
the client is the active question, because it lives in React state and nowhere
on the server; that is safe because it is inert, and reaches no score, session
or stored state.

| Cap | Value | Why |
| --- | --- | --- |
| History | 12 turns | Six exchanges resolves pronouns and "what did I just ask"; beyond that the profile matters more than turn eleven. |
| Reply | 700 tokens | Room for a considered answer without inviting an essay. |
| Rate limit | 30 per 10 min per IP | Uploads share this budget — an upload costs a transcription or vision call *and* the chat call after it. |
| Vision | 60/day, server-wide | ~6% of the model's daily requests. |

### Vision

Images are read by Groq `qwen/qwen3.6-27b`, on its own quota. Measured, that
model's 8,000 TPM bucket is **separate** from the interview's — spending it does
not move `gpt-oss-120b`'s remaining tokens, so chat vision cannot starve the
scored path.

Two measurements shaped this and are worth not re-deriving:

- **Image token cost is flat.** 256², 512², 1024² and 1536² all cost exactly
  1,301 prompt tokens. Resolution and token cost are unrelated — the provider
  normalises before tokenising. Downscaling buys bandwidth, not tokens.
- **`max_tokens` is reserved up front.** Asking for 2,048 costs 2,048 whether
  used or not, which makes the completion ceiling the real TPM lever. It is 600.

Qwen is a reasoning model and, left alone, spent 571 of a 600-token budget inside
`<think>`, never closed the tag, and returned pure reasoning — indistinguishable
from a model that saw nothing. `reasoning_effort: "none"` fixes it; the tag
stripping remains as a backstop.

`services/chat/vision.ts` sits outside the provider chain and **never throws**.
Every failure returns a sentence the widget can render, so a vision failure
degrades the assistant alone and text chat carries on.

## Uploads

Files never pass through this server. A Vercel function accepts at most **4.5MB
of request body**, which is below two of the three size limits, so the browser
uploads directly to Cloudinary under a signature this API issues.

```
POST /api/chat/upload/sign       → a ticket: url + signed fields
browser → Cloudinary             the only slow step
POST /api/chat/upload/complete   → transcript, extracted text, or description
```

| Kind | Limit | How it becomes text |
| --- | --- | --- |
| Image | 8MB | Cloudinary resizes to 1280px, re-encodes to WebP, strips metadata; qwen describes it. |
| Audio | 20MB | Groq's transcription endpoint takes a `url` and fetches it itself — no bytes here at all. |
| Document | 10MB | Fetched server-side, magic-byte checked, extracted with `unpdf`. Capped at 12,000 characters with an explicit truncation marker. |

The image transformation is part of the signature, including
`fl_strip_profile` — stated explicitly rather than relying on Cloudinary
defaulting to it, because a default can change without a deploy. It replaced a
`sharp` pipeline entirely; the re-encode is also what drops EXIF, so GPS
coordinates in a phone photo never reach storage or a model.

### What direct upload costs, stated plainly

The server no longer holds the bytes of an image or an audio file, so it can no
longer read their magic bytes — the check that caught a GIF renamed `.png`.
Three layers replace it, and they are **not** equivalent:

1. The signature constrains the upload (`folder`, `allowed_formats`,
   `resource_type`, and the image transformation). Change one and the signature
   stops matching; Cloudinary refuses at its edge.
2. What Cloudinary *reports* is re-checked here — never what the client claims.
3. **Documents keep full magic-byte checking**, because extraction fetches the
   bytes anyway. That is deliberate: extracted text is fed to a model as
   material, so a document is where a disguised file is most useful to an
   attacker.

Images and audio therefore move from "verified by us" to "verified by
Cloudinary, re-checked from its metadata". The alternative — routing everything
through the function — would cap audio at 4.5MB and lose long recordings
entirely.

`isOwnUpload()` is the most important check in that path: it restricts what
`/upload/complete` will fetch to this account's Cloudinary host *and* the
expected folder. Without it the endpoint would fetch any URL a caller sent,
using the function's network position.

Note that `max_file_size` is **not** in the signature. Cloudinary strips it
before computing the signature, so including it breaks every upload with
"Invalid Signature". Size is enforced client-side before uploading and
server-side afterwards, and a rejected upload is deleted.

## Deployment

Vercel, as a **single catch-all function**. `routes/index.ts` already composes
every path onto one router and `createApp()` already builds the app without
binding a port, so the serverless boundary lands exactly where the local one
did. `src/server.ts` is local-only and never loads in production.

`vercel.json` sets `maxDuration: 60` explicitly. **This is not optional.** The
Hobby default is 10s: at that ceiling the function is killed mid-flight and the
client gets a platform timeout instead of the readable error envelope every
failure path here exists to produce. The 20s/38s chain caps are chosen to fit
inside 60s on either plan.

`FRONTEND_ORIGIN` must be set to the deployed frontend — `https://dryrun.touchsimpledev.site` —
or every browser request is refused by CORS while `/health` in a terminal looks
perfectly fine.

There is no keepalive cron. Vercel has no sleeping dyno to keep warm, and
pinging `/health` on a schedule would spend two real provider calls per ping
against a 20/day Gemini quota.

## Environment

Every secret in the project lives here; see `.env.example`. `.env*` is
gitignored except the example.

| Variable | |
| --- | --- |
| `PORT` | local only; Vercel ignores it |
| `FRONTEND_ORIGIN` | CORS allowlist. `localhost:3000` is added automatically outside production. |
| `GITHUB_TOKEN` | public repo read only |
| `GROQ_API_KEY` | **primary** provider |
| `GEMINI_API_KEY` | fallback provider |
| `GROQ_MODEL`, `GEMINI_MODEL` | optional overrides; preview models get withdrawn at short notice |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | signs upload tickets; the secret never leaves this process |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | external state; see above |

CORS is restricted to `FRONTEND_ORIGIN`, never `*`. The allowed origins are
printed at boot.

## Shared types

`src/types/candidate.ts` is the **source of truth** for `CandidateProfile`. It is
mirrored by hand at `dryrun/src/lib/types/candidate.ts`, minus its header note.
Four smaller files are mirrored the same way:

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
temperature the model did not actually get, or — as happened once — a provider
order that only one half believes in.
