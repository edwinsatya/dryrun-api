/**
 * The assistant's routes.
 *
 * No multer, and no file ever arrives here. Uploads are signed by /upload/sign,
 * performed by the browser against Cloudinary, and reported back to
 * /upload/complete as a URL — the shape a 4.5MB function body limit forces and,
 * as it turns out, the shape that lets a 20MB recording work at all.
 *
 * Every route is rate limited per IP, including the signing endpoint: a
 * signature is a capability to write into our Cloudinary account, so handing
 * them out is exactly as worth limiting as spending them.
 */

import { Router } from "express";

import { getChatBudget, postChat } from "../controllers/chat.controller.js";
import {
  postCompleteUpload,
  postSignUpload,
} from "../controllers/upload.controller.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

router.post("/", rateLimit, postChat);
router.post("/upload/sign", rateLimit, postSignUpload);
router.post("/upload/complete", rateLimit, postCompleteUpload);
router.get("/budget", getChatBudget);

export default router;
