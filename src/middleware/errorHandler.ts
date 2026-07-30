/**
 * The terminal error middleware, plus the 404 that feeds it.
 *
 * Controllers handle their own expected failures — a rate-limited GitHub, a
 * model that would not answer — because those have specific codes the UI
 * renders. What lands here is the unexpected: a throw nobody caught, a bad JSON
 * body, a refused origin.
 *
 * Express 5 forwards a rejected async handler here automatically, which is the
 * safety net behind the try/catch in each controller rather than a replacement
 * for it.
 */

import type { NextFunction, Request, Response } from "express";

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  /** express.json() sets this on a malformed body */
  type?: string;
}

export function notFound(request: Request, response: Response): void {
  response.status(404).json({
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: `No route for ${request.method} ${request.path}.`,
    },
  });
}

export function errorHandler(
  error: HttpError,
  _request: Request,
  response: Response,
  // Required: Express identifies the terminal handler by arity, so dropping
  // this parameter turns the whole thing back into ordinary middleware.
  _next: NextFunction,
): void {
  // Full detail to the log; only a readable line to the client.
  console.error("[api] unhandled", error);

  if (response.headersSent) return;

  // A refused origin is the one "unexpected" error with an obvious cause, and
  // saying so beats a 500 that looks like the server broke.
  if (error.message?.includes("is not allowed")) {
    response.status(403).json({
      ok: false,
      error: { code: "FORBIDDEN_ORIGIN", message: error.message },
    });
    return;
  }

  if (error.type === "entity.parse.failed") {
    response.status(400).json({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Request body is not valid JSON." },
    });
    return;
  }

  const status = error.status ?? error.statusCode ?? 500;
  response.status(status).json({
    ok: false,
    error: {
      code: "UPSTREAM_ERROR",
      message: "Something failed on the server. Retry.",
    },
  });
}
