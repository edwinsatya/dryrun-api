/**
 * The four model calls that make up an interview.
 *
 * Server-only: everything here reaches lib/llm, which reads the API keys.
 * Route handlers are the only callers.
 *
 * Each call declares the shape it needs as a provider-agnostic JsonSchema.
 * Gemini enforces it natively; Groq is asked for a JSON object and held to the
 * same shape by the validators below, which run on both paths — a schema the
 * provider promised to honour is still not a shape this code has checked.
 *
 * Every call takes the same InterviewParams and passes them through unaltered.
 * Nothing here quietly overrides a value the panel set: an inspector that shows
 * a temperature the caller did not actually get is worse than no inspector.
 */

import type { InterviewParams } from "./params.js";
import type { PlannedTopic } from "./plan.js";
import { jsonCall } from "./json.js";
import {
  followUpSystemPrompt,
  questionSystemPrompt,
  scoreSystemPrompt,
  studyPlanSystemPrompt,
} from "./prompts.js";
import type {
  Assessment,
  CallRecord,
  ExchangeTurn,
  FollowUpReply,
  GeneratedQuestion,
  StudyPlan,
} from "./types.js";
import type { JsonSchema } from "../llm/types.js";
import type { CandidateProfile } from "../../types/candidate.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const QUESTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    topic: { type: "string" },
    question: { type: "string", description: "One question, two sentences at most." },
    rationale: {
      type: "string",
      description: "One sentence on why this question was chosen.",
    },
  },
  required: ["topic", "question", "rationale"],
  propertyOrdering: ["topic", "question", "rationale"],
};

const ASSESSMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 10 },
    verdict: { type: "string", description: "One sentence, addressed to the candidate." },
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    followUp: {
      type: "string",
      nullable: true,
      description: "A sharper question, or null if nothing is worth pursuing.",
    },
  },
  required: ["score", "verdict", "strengths", "gaps"],
  propertyOrdering: ["score", "verdict", "strengths", "gaps", "followUp"],
};

/**
 * The conversational call is still an envelope, but `reply` is unconstrained
 * prose — the structure exists only so a score revision arrives as data rather
 * than as a marker buried in free text, where a reformat would render it raw.
 */
const FOLLOW_UP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "Your prose reply to the candidate. Plain text, no markdown.",
    },
    revisedScore: {
      type: "integer",
      minimum: 0,
      maximum: 10,
      nullable: true,
      description: "The new score, or null if it is unchanged.",
    },
    revisionReason: {
      type: "string",
      nullable: true,
      description: "One sentence on what moved the score, or null.",
    },
  },
  required: ["reply"],
  propertyOrdering: ["reply", "revisedScore", "revisionReason"],
};

const STUDY_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "string" } },
  },
  required: ["steps"],
};

// ---------------------------------------------------------------------------
// Shape validators — run on both providers, schema or not
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, max);
}

/** Models occasionally return "7" or "7/10" rather than 7. */
function asScore(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(10, Math.round(parsed)));
}

function validateQuestion(value: unknown): GeneratedQuestion | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const question = asString(raw.question);
  if (!question) return null;

  return {
    topic: asString(raw.topic) ?? "",
    question,
    rationale: asString(raw.rationale) ?? "",
  };
}

function validateAssessment(value: unknown): Assessment | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const score = asScore(raw.score);
  const verdict = asString(raw.verdict);
  if (score === null || !verdict) return null;

  return {
    score,
    verdict,
    strengths: asStringList(raw.strengths, 3),
    gaps: asStringList(raw.gaps, 3),
    followUp: asString(raw.followUp),
  };
}

function validateFollowUp(value: unknown): FollowUpReply | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const text = asString(raw.reply);
  if (!text) return null;

  const revisedScore = raw.revisedScore == null ? null : asScore(raw.revisedScore);
  const revisionReason = asString(raw.revisionReason);

  // A revision without a stated reason is not shown as a revision — the reason
  // is the only part of it the candidate can argue with.
  if (revisedScore === null || !revisionReason) {
    return { text, revisedScore: null, revisionReason: null };
  }

  return { text, revisedScore, revisionReason };
}

function validateStudyPlan(value: unknown): StudyPlan | null {
  if (typeof value !== "object" || value === null) return null;
  const steps = asStringList((value as Record<string, unknown>).steps, 5);
  return steps.length > 0 ? { steps } : null;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  topic: string;
  question: string;
  answer: string;
}

export async function generateQuestion(
  profile: CandidateProfile,
  topic: PlannedTopic,
  history: HistoryEntry[],
  params: InterviewParams,
  /** set on a re-run, so the inspector can tell the two calls apart */
  label = "Question",
): Promise<{ data: GeneratedQuestion; call: CallRecord }> {
  const result = await jsonCall({
    label,
    system: questionSystemPrompt(profile, topic, history, params),
    messages: [
      {
        role: "user",
        content: `Ask question ${topic.index + 1} of 8, on "${topic.topic}".`,
      },
    ],
    schema: QUESTION_SCHEMA,
    validate: validateQuestion,
    params,
  });

  // The planner owns the topic label; the model only writes the question.
  return {
    data: { ...result.data, topic: topic.topic },
    call: result.call,
  };
}

export async function scoreAnswer(
  profile: CandidateProfile,
  topic: PlannedTopic,
  question: string,
  answer: string,
  params: InterviewParams,
): Promise<{ data: Assessment; call: CallRecord }> {
  return jsonCall({
    label: "Assessment",
    system: scoreSystemPrompt(profile, topic, question, params),
    messages: [{ role: "user", content: `Their answer:\n\n${answer}` }],
    schema: ASSESSMENT_SCHEMA,
    validate: validateAssessment,
    params,
  });
}

export async function continueExchange(
  profile: CandidateProfile,
  topic: PlannedTopic,
  question: string,
  answer: string,
  assessment: Assessment,
  turns: ExchangeTurn[],
  message: string,
  atCap: boolean,
  params: InterviewParams,
): Promise<{ data: FollowUpReply; call: CallRecord }> {
  return jsonCall({
    label: "Exchange",
    system: followUpSystemPrompt(
      profile,
      topic,
      question,
      answer,
      assessment,
      turns,
      atCap,
      params,
    ),
    // Prior turns are in the system prompt; this is the live one.
    messages: [{ role: "user", content: message }],
    schema: FOLLOW_UP_SCHEMA,
    validate: validateFollowUp,
    params,
  });
}

export async function generateStudyPlan(
  profile: CandidateProfile,
  results: { topic: string; score: number; verdict: string }[],
  params: InterviewParams,
): Promise<{ data: StudyPlan; call: CallRecord }> {
  return jsonCall({
    label: "Study plan",
    system: studyPlanSystemPrompt(profile, results, params),
    messages: [
      { role: "user", content: "Write the study plan for this session." },
    ],
    schema: STUDY_PLAN_SCHEMA,
    validate: validateStudyPlan,
    params,
  });
}
