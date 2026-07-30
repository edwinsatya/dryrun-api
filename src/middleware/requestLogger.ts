/**
 * One line per request: method, path, status, duration.
 *
 * Logged on "finish" rather than on the way in, because the status and the
 * duration are the two things worth having and neither exists yet when the
 * request arrives.
 */

import type { NextFunction, Request, Response } from "express";

export function requestLogger(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const started = Date.now();

  response.on("finish", () => {
    const ms = Date.now() - started;
    console.log(
      `[api] ${request.method} ${request.originalUrl} ${response.statusCode} ${ms}ms`,
    );
  });

  next();
}
