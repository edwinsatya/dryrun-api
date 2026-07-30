import { Router } from "express";

import {
  postFollowUp,
  postQuestion,
  postScore,
  postSummary,
} from "../controllers/interview.controller.js";

const router = Router();

router.post("/question", postQuestion);
router.post("/score", postScore);
router.post("/followup", postFollowUp);
router.post("/summary", postSummary);

export default router;
