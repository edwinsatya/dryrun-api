/**
 * The Express app: middleware chain, then routes, then the error handler.
 *
 * Order is load-bearing. CORS runs before anything that could throw, so a
 * refused origin still gets CORS headers on its 403 and the browser reports
 * the real reason. The error handler is mounted last because Express only
 * treats a four-argument function as terminal if nothing matched before it.
 *
 * Exported separately from server.ts so the app can be constructed without
 * binding a port.
 */

import express, { type Express } from "express";

import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import routes from "./routes/index.js";

export function createApp(): Express {
  const app = express();

  // Behind a proxy the client IP and protocol come from headers. Harmless
  // locally, and correct once this is deployed anywhere with a load balancer.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestLogger);
  app.use(corsMiddleware);

  // Prompts, transcripts and eight-question histories are the payload here.
  // The default 100kb is too tight for a full session summary.
  app.use(express.json({ limit: "1mb" }));

  app.use(routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
