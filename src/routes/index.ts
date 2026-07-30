/**
 * Where every path in this service is declared.
 *
 *   GET  /health
 *   GET  /api/profile/:username
 *   POST /api/interview/question
 *   POST /api/interview/score
 *   POST /api/interview/followup
 *   POST /api/interview/summary
 *
 * /health sits outside /api on purpose: it is infrastructure, pinged by the
 * keepalive cron rather than by the frontend, and it is the one endpoint that
 * should still answer if the API surface is ever versioned or moved.
 */

import { Router } from "express";

import healthRoutes from "./health.routes.js";
import interviewRoutes from "./interview.routes.js";
import profileRoutes from "./profile.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/api/profile", profileRoutes);
router.use("/api/interview", interviewRoutes);

export default router;
