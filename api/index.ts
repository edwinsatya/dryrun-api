/**
 * The Vercel entry point.
 *
 * One catch-all function for the whole API, not a function per route. The app
 * was already built for this without knowing it: routes/index.ts composes every
 * path onto a single router, and createApp() returns a configured Express app
 * without binding a port — server.ts is the only thing that ever called
 * listen(). So the serverless boundary lands exactly where the local one did.
 *
 * Per-route functions would mean unpicking that router into separate entry
 * points and re-registering the middleware chain in each, losing the single
 * ordering guarantee app.ts is explicit about. The gain would be independent
 * cold starts per route, which is not worth buying at this size.
 *
 * vercel.json rewrites every path here, so the Express router still sees the
 * original URL and matches /health, /api/profile/:username and the rest
 * unchanged.
 */

import "dotenv/config";

import { createApp } from "../src/app.js";

export default createApp();
