
import bcrypt from "bcryptjs";
import { getUsers, publicUser } from "../../lib/googleSheets.js";
import { createSession } from "../../lib/auth.js";
import { checkLoginAttempt, recordLoginAttempt } from "../../lib/authSecurity.js";
import {
  setCors,
  handleOptions,
  methodNotAllowed,
  getJsonBody,
} from "../../lib/http.js";

import { blockIfSitePaused } from "../../lib/siteAvailability.js";

export default async function handler(req, res) {
  setCors(req, res);

  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST", "OPTIONS"]);
  }
  if (await blockIfSitePaused(res)) return;

  let stage = "start";

  try {
    stage = "parse request";

    const { identity, password, rememberMe = true } = getJsonBody(req);
    const cleanIdentity = String(identity || "").trim().toLowerCase();

    if (!cleanIdentity || !password) {
      return res.status(400).json({
        error: "Enter your email or username and password.",
      });
    }

    let loginRateLimited = false;
    try {
      loginRateLimited = await checkLoginAttempt(req);
    } catch (securityError) {
      console.error("Sign-in rate check failed; allowing normal authentication:", securityError?.message || securityError);
    }
    if (loginRateLimited) {
      res.setHeader("Retry-After", "900");
      return res.status(429).json({
        error: "Too many unsuccessful sign-in attempts. Please wait 15 minutes and try again.",
      });
    }
    stage = "read Google Sheets";

    const users = await getUsers();

    if (!Array.isArray(users)) {
      throw new Error("getUsers() did not return an array");
    }

    stage = "find user";

    const user = users.find(
      (item) =>
        String(item.username || "").trim().toLowerCase() === cleanIdentity ||
        String(item.email || "").trim().toLowerCase() === cleanIdentity
    );

    stage = "check password";

    if (
      !user ||
      !user.password_hash ||
      !(await bcrypt.compare(String(password), String(user.password_hash)))
    ) {
      try {
        await recordLoginAttempt(req, { identity: cleanIdentity, success: false });
      } catch (securityError) {
        console.error("Could not record failed sign-in:", securityError?.message || securityError);
      }
      return res.status(401).json({
        error: "Invalid email/username or password.",
      });
    }

    if (String(user.status || "").toLowerCase() === "pending") {
      return res.status(403).json({
        error: "Please verify your email before logging in.",
        verificationRequired: true,
      });
    }

    if (
      user.status &&
      String(user.status).toLowerCase() !== "active"
    ) {
      return res.status(403).json({
        error: "This account is not active.",
      });
    }

    stage = "create session";

    const sessionToken = createSession(res, user, rememberMe !== false);

    stage = "prepare response";

    return res.status(200).json({
      message: "Signed in successfully.",
      user: publicUser(user),
      sessionToken,
    });
  } catch (error) {
    console.error("[LOGIN API ERROR]", {
      stage,
      message: error?.message,
      stack: error?.stack,
    });

    return res.status(500).json({
      error: "Unable to sign in right now. Check backend configuration and try again.",
    });
  }
}
