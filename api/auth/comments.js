import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { getSession } from "../../lib/auth.js";
import {
  getReviews,
  saveReviewByUsername,
} from "../../lib/googleSheets.js";
import {
  setCors,
  handleOptions,
  methodNotAllowed,
  getJsonBody,
} from "../../lib/http.js";

const REVIEW_TARGETS = ["game", "site"];
const GAME_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,159}$/i;
const MAX_COMMENT_LENGTH = 2000;

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} is required.`);
  }

  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }

  return text;
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

/**
 * The website posts reviews with the short-lived community token issued by
 * `/api/auth/me?token=true`. The session cookie is accepted too, so reviews can
 * also be posted from the same origin during local development.
 */
function getReviewerUsername(req) {
  const token = getBearerToken(req);
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;

  if (token && secret && secret.length >= 32) {
    try {
      const payload = jwt.verify(token, secret, {
        issuer: "gameonix-community-api",
        audience: "gameonix-web",
      });

      if (typeof payload?.username === "string" && payload.username.trim()) {
        return payload.username.trim();
      }
    } catch {
      // Fall through to the session cookie below.
    }
  }

  const session = getSession(req);
  return typeof session?.username === "string" ? session.username.trim() : "";
}

function buildReview(rawBody) {
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const target = String(body.target || "").trim().toLowerCase();

  if (!REVIEW_TARGETS.includes(target)) {
    throw new Error("Invalid review target.");
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Rating must be a whole number from 1 to 5.");
  }

  const review = {
    type: "review",
    id: randomUUID(),
    target,
    rating,
    comment: normalizeRequiredText(body.comment, "Review", MAX_COMMENT_LENGTH),
  };

  if (target === "game") {
    const gameSlug = String(body.gameSlug || "").trim();
    if (!GAME_SLUG_PATTERN.test(gameSlug)) {
      throw new Error("A valid game slug is required.");
    }

    review.gameSlug = gameSlug;
    review.gameTitle = normalizeRequiredText(body.gameTitle, "Game title", 120);
  }

  return review;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  if (!["GET", "POST"].includes(req.method)) {
    return methodNotAllowed(res, ["GET", "POST", "OPTIONS"]);
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const target = getQueryValue(req.query?.target);
      const gameSlug = getQueryValue(req.query?.gameSlug);

      if (target !== undefined && !REVIEW_TARGETS.includes(target)) {
        return res.status(400).json({ error: "Invalid review target." });
      }

      if (
        target === "game" &&
        (typeof gameSlug !== "string" || !GAME_SLUG_PATTERN.test(gameSlug))
      ) {
        return res.status(400).json({ error: "A valid game slug is required." });
      }

      return res.status(200).json({
        reviews: await getReviews({ target, gameSlug }),
      });
    }

    const username = getReviewerUsername(req);
    if (!username) {
      return res.status(401).json({ error: "Sign in to publish a review." });
    }

    let review;
    try {
      review = buildReview(getJsonBody(req));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const savedReview = await saveReviewByUsername(username, review);
    if (!savedReview) {
      return res.status(404).json({ error: "User account was not found." });
    }

    return res.status(200).json({ review: savedReview });
  } catch (error) {
    console.error("Reviews API error:", error.message);
    return res.status(500).json({ error: "Unable to load or save reviews." });
  }
}
