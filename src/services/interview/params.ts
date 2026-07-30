/**
 * The parameter set that reaches the model.
 *
 * Client-safe on purpose: pure data and pure functions, no API keys, no prompt
 * text. The panel imports it to render controls, the route handlers import it
 * to re-validate whatever the panel sent, and both agree on the defaults.
 *
 * There is no storage here. A configuration lives in the URL query string and
 * nowhere else, so the address bar is the whole of the state — shareable,
 * refreshable, and impossible to leave stale in a corner of localStorage.
 */

import type { Provider } from "../llm/types.js";

export type Persona = "lead" | "hr" | "founder" | "panel";
export type Difficulty = "junior" | "mid" | "senior";
export type Strictness = "lenient" | "balanced" | "harsh";
export type Language = "en" | "id";

export interface InterviewParams {
  temperature: number;
  topP: number;
  maxTokens: number;
  persona: Persona;
  difficulty: Difficulty;
  strictness: Strictness;
  language: Language;
  /** which provider to ask first; the other is still the fallback */
  provider: Provider;
}

export const DEFAULT_INTERVIEW_PARAMS: InterviewParams = {
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 1000,
  persona: "lead",
  difficulty: "mid",
  strictness: "balanced",
  language: "en",
  provider: "gemini",
};

// ---------------------------------------------------------------------------
// Ranges and options
// ---------------------------------------------------------------------------

export interface NumericSpec {
  min: number;
  max: number;
  step: number;
  /** decimal places to render in the value column */
  places: number;
}

export const TEMPERATURE: NumericSpec = { min: 0, max: 1, step: 0.05, places: 2 };
export const TOP_P: NumericSpec = { min: 0, max: 1, step: 0.05, places: 2 };
export const MAX_TOKENS: NumericSpec = { min: 256, max: 2048, step: 128, places: 0 };

export interface Option<T extends string> {
  id: T;
  label: string;
}

export const PERSONAS: readonly Option<Persona>[] = [
  { id: "lead", label: "Technical lead" },
  { id: "hr", label: "Friendly HR screener" },
  { id: "founder", label: "Startup founder" },
  { id: "panel", label: "Formal panel" },
];

export const DIFFICULTIES: readonly Option<Difficulty>[] = [
  { id: "junior", label: "Junior" },
  { id: "mid", label: "Mid" },
  { id: "senior", label: "Senior" },
];

export const STRICTNESSES: readonly Option<Strictness>[] = [
  { id: "lenient", label: "Lenient" },
  { id: "balanced", label: "Balanced" },
  { id: "harsh", label: "Harsh" },
];

export const LANGUAGES: readonly Option<Language>[] = [
  { id: "en", label: "English" },
  { id: "id", label: "Bahasa Indonesia" },
];

export const PROVIDERS: readonly Option<Provider>[] = [
  { id: "gemini", label: "Gemini" },
  { id: "groq", label: "Groq" },
];

/**
 * One line per parameter, written for someone who has never called an LLM API.
 * These are the teaching surface — they say what the knob does to the output,
 * not what the field is called in the request body.
 *
 * One line means one line: each stays inside the measure it is set at, so the
 * panel reads as a table of rows rather than eight stacked paragraphs. Say the
 * thing that changes, not everything that is true.
 */
export const NOTES: Record<keyof InterviewParams, string> = {
  temperature:
    "How far the model may stray from its likeliest next word. Near 0 it repeats; near 1 it invents.",
  topP:
    "How far down the likelihood list it may reach at all. Lower cuts off the long tail entirely.",
  maxTokens:
    "The ceiling on reply length, in tokens of roughly ¾ a word. Too low truncates rather than shortens.",
  persona:
    "Swaps the system prompt — changing what gets probed and what gets conceded, not only the tone.",
  difficulty:
    "The experience level questions are pitched at, and what counts there as a complete answer.",
  strictness:
    "How generous the scoring is. It moves the 0–10 bands themselves, not just the wording.",
  language:
    "The language the model writes in. Repository and dependency names stay untranslated.",
  provider:
    "Which service answers. A different model gives a different reply — and the answer says which.",
};

// ---------------------------------------------------------------------------
// Coercion
//
// Never trust a value from outside this module: the panel writes them into a
// URL a candidate can hand-edit, and the routes read them off a request body.
// Every path lands in `build`, which clamps rather than rejects.
// ---------------------------------------------------------------------------

/**
 * Range and precision are enforced here; the step is not.
 *
 * The step belongs to the slider, which is the only thing that moves in
 * increments — 1000 max tokens is not on a 128 grid that starts at 256, and
 * snapping here would silently rewrite the stated default to 1024 the first
 * time anything read it. Rounding to the displayed precision is enough: it
 * keeps the value column and the request in agreement, whatever a hand-edited
 * URL asked for.
 */
function toNumber(raw: unknown, spec: NumericSpec, fallback: number): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseFloat(raw)
        : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;

  const clamped = Math.min(spec.max, Math.max(spec.min, parsed));
  const factor = 10 ** spec.places;
  return Math.round(clamped * factor) / factor;
}

function toOption<T extends string>(
  raw: unknown,
  options: readonly Option<T>[],
  fallback: T,
): T {
  if (typeof raw !== "string") return fallback;
  const match = options.find((option) => option.id === raw);
  return match ? match.id : fallback;
}

/** Every field, clamped, from a bag of unknowns. */
function build(get: (key: keyof InterviewParams) => unknown): InterviewParams {
  const d = DEFAULT_INTERVIEW_PARAMS;
  return {
    temperature: toNumber(get("temperature"), TEMPERATURE, d.temperature),
    topP: toNumber(get("topP"), TOP_P, d.topP),
    maxTokens: toNumber(get("maxTokens"), MAX_TOKENS, d.maxTokens),
    persona: toOption(get("persona"), PERSONAS, d.persona),
    difficulty: toOption(get("difficulty"), DIFFICULTIES, d.difficulty),
    strictness: toOption(get("strictness"), STRICTNESSES, d.strictness),
    language: toOption(get("language"), LANGUAGES, d.language),
    provider: toOption(get("provider"), PROVIDERS, d.provider),
  };
}

/** Short, stable query keys — these end up in shared links. */
const QUERY_KEYS: Record<keyof InterviewParams, string> = {
  temperature: "temp",
  topP: "topp",
  maxTokens: "max",
  persona: "persona",
  difficulty: "level",
  strictness: "strict",
  language: "lang",
  provider: "provider",
};

/** Anything with URLSearchParams' read half, including the read-only one. */
interface QuerySource {
  get(key: string): string | null;
}

export function parseInterviewParams(source: QuerySource): InterviewParams {
  return build((key) => source.get(QUERY_KEYS[key]));
}

/** From a JSON request body, where the keys are the interface's own. */
export function coerceInterviewParams(value: unknown): InterviewParams {
  const raw = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;
  return build((key) => raw[key]);
}

/**
 * Writes the full set into an existing query, in place.
 *
 * The full set, always — a shared link that omits its defaults reproduces a
 * configuration only for as long as those defaults never change. Values are
 * written at their displayed precision so the address bar and the value column
 * cannot disagree.
 */
export function writeInterviewParams(
  query: URLSearchParams,
  params: InterviewParams,
): void {
  query.set(QUERY_KEYS.temperature, format(params.temperature, TEMPERATURE));
  query.set(QUERY_KEYS.topP, format(params.topP, TOP_P));
  query.set(QUERY_KEYS.maxTokens, format(params.maxTokens, MAX_TOKENS));
  query.set(QUERY_KEYS.persona, params.persona);
  query.set(QUERY_KEYS.difficulty, params.difficulty);
  query.set(QUERY_KEYS.strictness, params.strictness);
  query.set(QUERY_KEYS.language, params.language);
  query.set(QUERY_KEYS.provider, params.provider);
}

/** The same, standalone — for a link built without an existing query. */
export function interviewParamsToQuery(params: InterviewParams): string {
  const query = new URLSearchParams();
  writeInterviewParams(query, params);
  return query.toString();
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Fixed places, so a column of these aligns. */
export function format(value: number, spec: NumericSpec): string {
  return value.toFixed(spec.places);
}

function labelOf<T extends string>(
  id: T,
  options: readonly Option<T>[],
): string {
  return options.find((option) => option.id === id)?.label ?? id;
}

export const personaLabel = (id: Persona) => labelOf(id, PERSONAS);
export const difficultyLabel = (id: Difficulty) => labelOf(id, DIFFICULTIES);
export const strictnessLabel = (id: Strictness) => labelOf(id, STRICTNESSES);
export const languageLabel = (id: Language) => labelOf(id, LANGUAGES);
export const providerLabel = (id: Provider) => labelOf(id, PROVIDERS);

/** Trimmed for prose: 0.20 reads as 0.2 in a caption. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** The caption under a re-run: `temp 0.2 · startup founder`. */
export function describeParams(params: InterviewParams): string {
  return `temp ${trim(params.temperature)} · ${personaLabel(
    params.persona,
  ).toLowerCase()}`;
}

/** Every knob on one line, for the collapsed panel and the inspector. */
export function describeParamsFull(params: InterviewParams): string {
  return [
    `temp ${trim(params.temperature)}`,
    `top-p ${trim(params.topP)}`,
    `${params.maxTokens} tok`,
    personaLabel(params.persona).toLowerCase(),
    params.difficulty,
    params.strictness,
    params.language,
    params.provider,
  ].join(" · ");
}

/** Which fields differ — what the inspector marks as changed since the call. */
export function changedParams(
  before: InterviewParams,
  after: InterviewParams,
): Set<keyof InterviewParams> {
  const changed = new Set<keyof InterviewParams>();
  for (const key of Object.keys(before) as (keyof InterviewParams)[]) {
    if (before[key] !== after[key]) changed.add(key);
  }
  return changed;
}
