
import { timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { getSession, clearSession } from "../../lib/auth.js";
import bcrypt from "bcryptjs";
import {
  adjustWalletBalance,
  appendUser,
  compactUserRows,
  deleteUser,
  deleteUserBySheetRow,
  getSiteControl,
  getBlockedReviewUsers,
  getReviews,
  getUsers,
  moderateReview,
  publicUser,
  recordDesktopAppVersion,
  setReviewBlock,
  setSiteControl,
  updateUser,
} from "../../lib/googleSheets.js";
import { uploadAvatarImage } from "../../lib/avatars.js";
import { sendAccountCreatedEmail } from "../../lib/mailer.js";
import { handlePublicReviews } from "../../lib/reviewsApi.js";
import { blockIfSitePaused } from "../../lib/siteAvailability.js";
import { fetchReplica } from "../../lib/serviceFetch.js";
import { getAuthAbuseReport, setSignupIpBlock } from "../../lib/authSecurity.js";
import {
  validateDisplayNamePolicy,
  validateEmailPolicy,
  validateUsernamePolicy,
} from "../../lib/namePolicy.js";

const DEFAULT_AVATAR =
  "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-All/main/0.png";
const OWNER_ACCOUNT_USERNAME = "mahmoud";
const OWNER_ACCOUNT_EMAIL = "mahmoudpro963@gmail.com";
import {
  setCors,
  handleOptions,
  methodNotAllowed,
  getJsonBody,
} from "../../lib/http.js";

const USER_EDITABLE_FIELDS = new Set([
  "username",
  "email",
  "name",
  "comments",
  "likes",
  "favorites",
  "theme",
  "avatar",
  "status",
  "pending_email",
]);
const WALLET_ADMIN_ACTIONS_URL =
  "https://gameonix-fav-2.vercel.app/api/auth/wallet-notifications";
const WALLET_PURCHASE_ADMIN_URL =
  "https://gameonix-fav-2.vercel.app/api/auth/wallet-purchase";
const ADMIN_TOOL_RESOURCES = new Set([
  "game-requests",
  "purchase-requests",
  "support-reports",
]);
const ADMIN_TOOL_ACTIONS = new Set([
  "send",
  "set-site-mode",
  "publish-game-update",
  "send-password-reset-link",
  "update-game-request",
  "reply-support-report",
  "delete-support-report",
  "update-support-ticket-status",
  "edit-support-message",
  "delete-support-message",
  "delete-game-request",
  "approve-purchase-request",
  "reject-purchase-request",
]);

async function shouldRetryAdminReplica(response) {
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    return body.error === "Admin access is required.";
  }
  if (response.ok && response.status === 200) {
    const body = await response.json().catch(() => ({}));
    return body.canSend === false;
  }
  return false;
}

function isValidUsersAdminToken(req) {
  const expected = process.env.GAMEONIX_USERS_ADMIN_TOKEN?.trim();
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim();

  if (!expected || expected.length < 32 || !supplied) return false;

  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

function createAdminToolsToken(username) {
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Admin actions are not configured.");
  }

  return jwt.sign({ username }, secret, {
    algorithm: "HS256",
    expiresIn: "60s",
    issuer: "gameonix-community-api",
    audience: "gameonix-web",
  });
}

function adminUser(user) {
  const pendingEmail = String(user.pending_email || "");
  const isMalformed =
    !String(user.username || "").trim() &&
    !String(user.email || "").trim() &&
    /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(pendingEmail);
  return {
    ...publicUser(user),
    avatar: user.avatar || "",
    wallet: Number(user.wallet || 0),
    status: String(user.status || "active").trim().toLowerCase(),
    app_version: String(user.app_version || ""),
    app_last_seen_at: String(user.app_last_seen_at || ""),
    pending_email: isMalformed ? "" : pendingEmail,
    is_malformed: isMalformed,
    record_id: Number(user._sheetRow),
  };
}

function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be text.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is required and must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function validateUserUpdates(rawUpdates, { allowProtectedOwnerName = false } = {}) {
  if (!rawUpdates || typeof rawUpdates !== "object" || Array.isArray(rawUpdates)) {
    throw new Error("User updates are required.");
  }

  const fields = Object.keys(rawUpdates);
  if (!fields.length || fields.some((field) => !USER_EDITABLE_FIELDS.has(field))) {
    throw new Error("One or more user fields cannot be edited.");
  }

  const updates = {};
  if (Object.hasOwn(rawUpdates, "username")) {
    const username = normalizeRequiredText(rawUpdates.username, "Username", 24);
    if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
      throw new Error("Username must be 3–24 characters and use only letters, numbers, or underscores.");
    }
    const policyError = validateUsernamePolicy(username);
    if (policyError) throw new Error(policyError);
    updates.username = username;
  }

  if (Object.hasOwn(rawUpdates, "email")) {
    const email = normalizeRequiredText(rawUpdates.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    const emailPolicyError = validateEmailPolicy(email);
    if (emailPolicyError) throw new Error(emailPolicyError);
    updates.email = email;
  }

  if (Object.hasOwn(rawUpdates, "name")) {
    const name = normalizeRequiredText(rawUpdates.name, "Name", 80);
    const policyError = validateDisplayNamePolicy(name, { allowProtectedOwnerName });
    if (policyError) throw new Error(policyError);
    updates.name = name;
  }

  if (Object.hasOwn(rawUpdates, "theme")) {
    updates.theme = normalizeRequiredText(rawUpdates.theme, "Theme", 32);
  }

  if (Object.hasOwn(rawUpdates, "wallet")) {
    const wallet = Number(rawUpdates.wallet);

    if (!Number.isFinite(wallet) || wallet < 0 || wallet > 10_000_000) {
      throw new Error(
        "Wallet balance must be a number between 0 and 10,000,000."
      );
    }

    updates.wallet = Math.round((wallet + Number.EPSILON) * 100) / 100;
  }

  if (Object.hasOwn(rawUpdates, "status")) {
    const status = normalizeRequiredText(rawUpdates.status, "Status", 32).toLowerCase();
    if (!["active", "pending", "banned"].includes(status)) {
      throw new Error("Status must be active, pending, or banned.");
    }
    updates.status = status;
  }

  for (const field of ["avatar", "pending_email"]) {
    if (!Object.hasOwn(rawUpdates, field)) continue;
    const value = rawUpdates[field];
    if (typeof value !== "string" || value.trim().length > (field === "avatar" ? 2048 : 254)) {
      throw new Error(`${field} must be valid text.`);
    }
    const normalized = value.trim();
    if (field === "avatar" && normalized && !/^https?:\/\/\S+$/i.test(normalized)) {
      throw new Error("Avatar must be an HTTP or HTTPS URL.");
    }
    if (field === "pending_email" && normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("Pending email must be a valid email address or empty.");
    }
    if (field === "pending_email" && normalized) {
      const emailPolicyError = validateEmailPolicy(normalized);
      if (emailPolicyError) throw new Error(emailPolicyError);
    }
    updates[field] = normalized;
  }

  for (const field of ["comments", "likes", "favorites"]) {
    if (!Object.hasOwn(rawUpdates, field)) continue;
    const serialized = JSON.stringify(rawUpdates[field]);
    if (serialized === undefined || serialized.length > 100_000) {
      throw new Error(`${field} must be valid JSON under 100 KB.`);
    }
    updates[field] = rawUpdates[field];
  }

  return updates;
}

const REVIEW_USER_ACTIONS = ["block", "unblock"];

async function handleReviewsAdmin(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return methodNotAllowed(res, ["GET", "POST", "OPTIONS"]);
  }

  if (req.method === "GET") {
    return res.status(200).json({
      reviews: await getReviews({ includeHidden: true }),
      blocked: await getBlockedReviewUsers(),
    });
  }

  const body = getJsonBody(req);
  try {
    const username = normalizeRequiredText(body.username, "Username", 24);
    const action = normalizeRequiredText(body.action, "Action", 16).toLowerCase();

    if (REVIEW_USER_ACTIONS.includes(action)) {
      const blocked = await setReviewBlock({
        username,
        blocked: action === "block",
      });

      return res.status(200).json({ blocked });
    }

    const reviewId = normalizeRequiredText(body.reviewId, "Review id", 64);

    const result = await moderateReview({
      username,
      reviewId,
      action,
      rating: body.rating,
      comment: body.comment,
      reply: body.reply,
    });

    return res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 400;
    return res.status(status).json({ error: error.message });
  }
}

async function handleCreateUser(req, res, body) {
  let details;

  try {
    const username = normalizeRequiredText(body.username, "Username", 24);
    if (username.length < 3 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
      throw new Error(
        "Username must be 3–24 characters and use only letters, numbers, dots, underscores, or hyphens."
      );
    }

    const usernamePolicyError = validateUsernamePolicy(username);
    if (usernamePolicyError) throw new Error(usernamePolicyError);

    const email = normalizeRequiredText(body.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    const emailPolicyError = validateEmailPolicy(email);
    if (emailPolicyError) throw new Error(emailPolicyError);

    const name = normalizeRequiredText(body.name, "Display name", 80);
    const namePolicyError = validateDisplayNamePolicy(name);
    if (namePolicyError) throw new Error(namePolicyError);
    const password = String(body.password || "");

    if (password.length < 8 || password.length > 72) {
      throw new Error("Password must be between 8 and 72 characters.");
    }

    const walletValue =
      body.wallet === undefined || body.wallet === "" ? 0 : Number(body.wallet);

    if (!Number.isFinite(walletValue) || walletValue < 0 || walletValue > 10_000_000) {
      throw new Error("Starting balance must be a number between 0 and 10,000,000.");
    }

    const status = String(body.status || "active").trim().toLowerCase();
    if (!["active", "pending", "banned"].includes(status)) {
      throw new Error("Status must be active, pending, or banned.");
    }

    details = {
      username,
      email,
      name,
      password,
      wallet: Math.round((walletValue + Number.EPSILON) * 100) / 100,
      status,
      sendEmail: body.sendEmail !== false,
    };
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const users = await getUsers();
  const duplicateUsername = users.some(
    (user) =>
      String(user.username || "").trim().toLowerCase() ===
      details.username.toLowerCase()
  );
  const duplicateEmail = users.some(
    (user) =>
      String(user.email || "").trim().toLowerCase() === details.email
  );

  if (duplicateUsername || duplicateEmail) {
    return res.status(409).json({
      error: duplicateUsername
        ? "That username is already in use."
        : "That email is already in use.",
    });
  }

  let avatar = String(body.avatar || "").trim();

  if (typeof body.imageData === "string" && body.imageData.trim()) {
    try {
      avatar = await uploadAvatarImage({
        imageData: body.imageData.trim(),
        mimeType: body.mimeType,
        username: details.username,
      });
    } catch (uploadError) {
      return res
        .status(uploadError.status || 500)
        .json({ error: uploadError.message });
    }
  }

  const createdAccount = {
    username: details.username,
    email: details.email,
    name: details.name,
    created_at: new Date().toISOString(),
    comments: JSON.stringify([]),
    likes: JSON.stringify([]),
    favorites: JSON.stringify([]),
    theme: "dark",
    avatar: avatar || DEFAULT_AVATAR,
    status: details.status,
    wallet: details.wallet || "",
  };

  const appendResult = await appendUser({
    ...createdAccount,
    password_hash: await bcrypt.hash(details.password, 12),
  });
  if (appendResult.updatedRows !== 1) {
    throw new Error("Google Sheets did not confirm writing the new account row.");
  }
  createdAccount._sheetRow = appendResult.rowNumber;

  let created = null;
  try {
    created = (await getUsers()).find((user) => Number(user._sheetRow) === appendResult.rowNumber) || null;
  } catch (error) {
    console.error("Created account readback failed:", error?.message || error);
  }
  const accountForResponse = created || createdAccount;

  let emailSent = false;
  let emailError = "";

  if (details.sendEmail) {
    try {
      await sendAccountCreatedEmail({
        to: details.email,
        name: details.name,
        username: details.username,
        password: details.password,
      });
      emailSent = true;
    } catch (error) {
      emailError = error.message;
      console.error("Account welcome email failed:", error.message);
    }
  }

  return res.status(201).json({
    user: adminUser(accountForResponse),
    emailSent,
    emailError,
  });
}

async function handleAdjustWallet(req, res, body) {
  try {
    const identifier = normalizeRequiredText(
      body.identifier,
      "Username or email",
      254
    );
    const amount = Number(body.amount);

    if (!Number.isFinite(amount) || amount === 0) {
      throw new Error("Enter an amount other than zero.");
    }

    const result = await adjustWalletBalance({
      identifier,
      amount,
      note: body.note,
      adjustedBy: body.adjustedBy || "Publisher",
    });

    return res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 400;
    return res.status(status).json({ error: error.message });
  }
}

async function handleUsersAdmin(req, res) {
  const adminToken = process.env.GAMEONIX_USERS_ADMIN_TOKEN?.trim();
  if (!adminToken || adminToken.length < 32) {
    return res.status(503).json({
      error: "User management is not configured on the backend.",
    });
  }
  if (!isValidUsersAdminToken(req)) {
    return res.status(401).json({ error: "The admin key is invalid." });
  }

  const resource = req.query?.resource;
  if (resource !== undefined) {
    if (resource !== "reviews") {
      return res.status(400).json({ error: "Unsupported user management resource." });
    }

    return handleReviewsAdmin(req, res);
  }

  if (req.method === "POST") {
    const body = getJsonBody(req);
    const action = String(body.action || "").trim().toLowerCase();

    if (action === "block-signup-ip" || action === "unblock-signup-ip") {
      const result = await setSignupIpBlock(
        body.ip,
        action === "block-signup-ip",
        body.reason,
      );
      return res.status(200).json(result);
    }

    if (action === "create-user") {
      return handleCreateUser(req, res, body);
    }

    if (action === "adjust-wallet") {
      return handleAdjustWallet(req, res, body);
    }

    return res
      .status(400)
      .json({ error: "Unsupported user management action." });
  }

  if (req.method === "GET") {
    await compactUserRows();
    const users = await getUsers();
    let authSecurity = { attempts: [], blockedIps: [], error: "" };
    try {
      authSecurity = await getAuthAbuseReport();
    } catch (error) {
      console.error("Auth security report failed:", error?.message || error);
      authSecurity.error = "Attempt monitoring is temporarily unavailable.";
    }
    return res.status(200).json({
      users: users.map(adminUser),
      signupAbuseAttempts: authSecurity.attempts,
      blockedSignupIps: authSecurity.blockedIps,
      securityReportError: authSecurity.error || "",
    });
  }

  if (req.method === "DELETE") {
    const body = getJsonBody(req);
    const recordId = Number(body.recordId);
    const users = await getUsers();

    if (Number.isSafeInteger(recordId) && recordId >= 2) {
      const user = users.find((item) => Number(item._sheetRow) === recordId);
      if (!user) return res.status(404).json({ error: "Account row not found." });
      const pendingHash = String(user.pending_email || "");
      const isMalformed =
        !String(user.username || "").trim() &&
        !String(user.email || "").trim() &&
        /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(pendingHash);
      if (!isMalformed) {
        return res.status(400).json({ error: "Row deletion is limited to malformed blank accounts with a password hash in the pending email field." });
      }
      try {
        await deleteUserBySheetRow(recordId);
      } catch (error) {
        console.error("Malformed account deletion failed:", error?.message || error);
        return res.status(500).json({ error: "Could not delete the malformed account row." });
      }
      return res.status(200).json({ record_id: recordId });
    }

    let username;
    try {
      username = normalizeRequiredText(body.username, "Username", 24);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const user = users.find((item) => String(item.username || "").trim().toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: "User not found." });
    try {
      await deleteUser(user.username);
    } catch (error) {
      console.error("User deletion failed:", error?.message || error);
      const backendMessage = typeof error?.response?.data?.error?.message === "string"
        ? error.response.data.error.message
        : typeof error?.message === "string"
          ? error.message
          : "The account could not be removed from Google Sheets.";
      return res.status(500).json({ error: "Could not delete this account: " + backendMessage });
    }
    return res.status(200).json({ username: user.username });
  }

  if (req.method !== "PATCH") {
    return methodNotAllowed(res, [
      "GET",
      "POST",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]);
  }

  const body = getJsonBody(req);
  let username;
  try {
    username = normalizeRequiredText(body.username, "Username", 24);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const users = await getUsers();
  const currentUser = users.find(
    (user) => String(user.username || "").trim().toLowerCase() === username.toLowerCase()
  );
  if (!currentUser) {
    return res.status(404).json({ error: "User not found." });
  }

  const isOwnerAccount =
    String(currentUser.username || "").trim().toLowerCase() === OWNER_ACCOUNT_USERNAME &&
    String(currentUser.email || "").trim().toLowerCase() === OWNER_ACCOUNT_EMAIL;
  let updates;
  try {
    updates = validateUserUpdates(body.updates, {
      allowProtectedOwnerName: isOwnerAccount,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const nextUsername = String(updates.username ?? currentUser.username).trim().toLowerCase();
  const nextEmail = String(updates.email ?? currentUser.email).trim().toLowerCase();
  const duplicateUsername = users.some(
    (user) => user !== currentUser && String(user.username || "").trim().toLowerCase() === nextUsername
  );
  const duplicateEmail = users.some(
    (user) => nextEmail && user !== currentUser && String(user.email || "").trim().toLowerCase() === nextEmail
  );
  if (duplicateUsername || duplicateEmail) {
    return res.status(409).json({
      error: duplicateUsername ? "That username is already in use." : "That email is already in use.",
    });
  }

  const updatesToSave = { ...updates };
  if (Object.hasOwn(updatesToSave, "favorites")) {
    let storedFavorites = currentUser.favorites;
    if (typeof storedFavorites === "string") {
      try { storedFavorites = JSON.parse(storedFavorites); } catch { storedFavorites = []; }
    }
    const follows = Array.isArray(storedFavorites)
      ? storedFavorites.filter((item) => typeof item === "string" && item.startsWith("follow|"))
      : [];
    const nextFavorites = Array.isArray(updatesToSave.favorites)
      ? updatesToSave.favorites.filter((item) => typeof item === "string" && !item.startsWith("follow|"))
      : [];
    updatesToSave.favorites = JSON.stringify([...nextFavorites, ...follows]);
  }
  if (
    String(currentUser.status || "").trim().toLowerCase() !== "active" &&
    updates.status === "active"
  ) {
    Object.assign(updatesToSave, {
      verification_code_hash: "",
      verification_expires_at: "",
      pending_expires_at: "",
      reset_password_code_hash: "",
      reset_password_expires_at: "",
      reset_password_attempts: "0",
      pending_email: "",
      email_change_code_hash: "",
      email_change_expires_at: "",
    });
  }

  const updatedUser = await updateUser(currentUser.username, updatesToSave);
  return res.status(200).json({ user: adminUser(updatedUser) });
}

async function handleAdminTools(req, res) {
  const adminToken = process.env.GAMEONIX_USERS_ADMIN_TOKEN?.trim();
  if (!adminToken || adminToken.length < 32) {
    return res.status(503).json({
      error: "Admin tools are not configured on the backend.",
    });
  }
  if (!isValidUsersAdminToken(req)) {
    return res.status(401).json({ error: "The admin key is invalid." });
  }

  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    return res.status(503).json({
      error: "Admin actions are not configured on the backend.",
    });
  }
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  const resource = req.method === "GET" ? req.query?.resource : undefined;
  if (resource !== undefined && !ADMIN_TOOL_RESOURCES.has(resource)) {
    return res.status(400).json({ error: "Unsupported admin tools resource." });
  }

  if (req.method === "GET" && req.query?.username === undefined) {
    return res.status(200).json({ ready: true });
  }

  let adminUsername;
  let actionBody = null;
  if (req.method === "GET") {
    adminUsername = req.query?.username;
  } else {
    const body = getJsonBody(req);
    adminUsername = body.adminUsername;
    const { adminUsername: _adminUsername, ...forwardedBody } = body;
    actionBody = forwardedBody;
  }

  try {
    adminUsername = normalizeRequiredText(
      adminUsername,
      "Admin username",
      24
    );
    if (adminUsername.length < 3 || !/^[a-zA-Z0-9_]+$/.test(adminUsername)) {
      throw new Error(
        "Admin username must be 3–24 characters and use only letters, numbers, or underscores."
      );
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (
    req.method === "POST" &&
    !ADMIN_TOOL_ACTIONS.has(actionBody?.action)
  ) {
    return res.status(400).json({ error: "Unsupported admin action." });
  }

  if (req.method === "POST" && actionBody?.action === "publish-game-update") {
    if (!/^[a-f0-9]{40}$/i.test(String(actionBody.publishId || "")) ||
        !Array.isArray(actionBody.games) || actionBody.games.length > 100) {
      return res.status(400).json({ error: "The published game update is invalid." });
    }
    const users = await getUsers();
    actionBody.games = actionBody.games.map((game) => {
      const stored = typeof game?.slug === "string" ? game.slug.trim().toLowerCase() : "";
      const followers = users.filter((user) => {
        if (user.status && String(user.status).trim().toLowerCase() !== "active") return false;
        let favorites = user.favorites;
        if (typeof favorites === "string") {
          try { favorites = JSON.parse(favorites); } catch { favorites = []; }
        }
        return Array.isArray(favorites) && favorites.some((entry) =>
          typeof entry === "string" && entry.startsWith("follow|") &&
          String(entry.split("|")[1] || "").trim().toLowerCase() === stored
        );
      }).map((user) => ({ username: String(user.username || ""), email: String(user.email || "") }));
      return { ...game, followers };
    });
  }

  // Product purchase requests live in the wallet purchase function, everything
  // else is proxied to the wallet notifications function.
  const upstreamUrl =
    resource === "purchase-requests" ||
    actionBody?.action === "approve-purchase-request" ||
    actionBody?.action === "reject-purchase-request"
      ? WALLET_PURCHASE_ADMIN_URL
      : resource === "support-reports"
        ? `${WALLET_ADMIN_ACTIONS_URL}?admin=reports`
        : WALLET_ADMIN_ACTIONS_URL;

  const token = createAdminToolsToken(adminUsername);

  if (req.method === "POST" && actionBody.action === "set-site-mode") {
    const accessUrl = new URL(WALLET_ADMIN_ACTIONS_URL);
    accessUrl.searchParams.set("username", adminUsername);
    const accessResponse = await fetchReplica("fav", accessUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      retryOnResponse: shouldRetryAdminReplica,
      signal: AbortSignal.timeout(8000),
    });
    const accessData = await accessResponse.json().catch(() => ({}));
    if (!accessResponse.ok || accessData.canSend !== true) {
      return res.status(403).json({ error: "Admin access is required." });
    }
    const mode = String(actionBody.mode || "").trim();
    const message = typeof actionBody.message === "string" ? actionBody.message : "";
    const siteControl = await setSiteControl({ mode, message });
    return res.status(200).json({
      success: true,
      message: mode === "online" ? "The website is back online." : "The website status was updated.",
      siteControl,
    });
  }

  const response = await fetchReplica("fav", upstreamUrl, {
    method: req.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(actionBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(actionBody ? { body: JSON.stringify(actionBody) } : {}),
    retryOnResponse: shouldRetryAdminReplica,
    signal: AbortSignal.timeout(actionBody?.action === "publish-game-update" ? 9000 : 8000),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return res.status(response.status < 500 ? response.status : 502).json({
      error: data.error || "Unable to complete this admin action.",
    });
  }

  if (req.method === "GET") {
    if (resource === "support-reports") {
      if (data.canSend !== true || !Array.isArray(data.reports)) {
        return res.status(403).json({ error: "Admin access is required." });
      }
      const reports = data.reports
        .filter((report) =>
          report &&
          ["support_request", "bug_report"].includes(report.type) &&
          report.details &&
          typeof report.details === "object"
        )
        .map((report) => ({
          id: String(report.id || ""),
          username: String(report.username || ""),
          type: report.type,
          title: String(report.title || ""),
          message: String(report.message || ""),
          details: report.details,
          createdAt: String(report.createdAt || ""),
        }))
        .filter((report) => report.id && report.username);
      return res.status(200).json({ ready: true, canSend: true, reports });
    }

    if (resource === "game-requests") {
      if (data.canSend !== true) {
        return res.status(403).json({ error: "Admin access is required." });
      }

      const gameRequests = (Array.isArray(data.notifications)
        ? data.notifications
        : []
      )
        .filter(
          (notification) =>
            notification?.type === "game_request_admin" &&
            notification.details &&
            typeof notification.details === "object"
        )
        .map((notification) => ({
          id: String(notification.id || ""),
          createdAt: String(notification.createdAt || ""),
          readAt: String(notification.readAt || ""),
          username: String(notification.details.username || ""),
          email: String(notification.details.email || ""),
          gameTitle: String(notification.details.gameTitle || ""),
          platform: String(notification.details.platform || ""),
          details: String(notification.details.details || ""),
          status: ["pending", "accepted", "rejected"].includes(
            notification.details.status
          )
            ? notification.details.status
            : "pending",
          reply: String(notification.details.reply || ""),
          statusUpdatedAt: String(notification.details.statusUpdatedAt || ""),
          notificationSentAt: String(
            notification.details.notificationSentAt || ""
          ),
          emailSentAt: String(
            notification.details.emailSentAt ||
              (!Object.hasOwn(notification.details, "emailSentAt")
                ? notification.details.notificationSentAt || ""
                : "")
          ),
        }))
        .filter(
          (request) =>
            request.id &&
            request.username &&
            request.gameTitle &&
            request.platform
        );

      return res.status(200).json({
        ready: true,
        canSend: true,
        gameRequests,
      });
    }

    if (resource === "purchase-requests") {
      if (data.success !== true || !Array.isArray(data.requests)) {
        return res
          .status(502)
          .json({ error: "Unable to load product requests." });
      }

      return res.status(200).json({
        ready: true,
        canSend: true,
        purchaseRequests: data.requests,
      });
    }

    const siteControl = data.canSend === true ? await getSiteControl() : undefined;
    return res.status(200).json({
      ready: true,
      canSend: data.canSend === true,
      ...(siteControl ? { siteControl } : {}),
    });
  }

  const fallbackMessages = {
    send: "The private notification was sent.",
    "send-password-reset-link":
      "If an active account uses that email, a secure reset link was sent.",
    "update-game-request": "The game request decision was saved.",
    "reply-support-report": "The support report reply was sent.",
    "delete-support-report": "The support report was deleted.",
    "update-support-ticket-status": "The support ticket status was updated.",
    "edit-support-message": "The support message was updated.",
    "delete-support-message": "The support message was deleted.",
    "delete-game-request": "The game request was deleted.",
    "approve-purchase-request": "The product request was approved.",
    "reject-purchase-request": "The product request was rejected.",
    "publish-game-update": "Game followers were notified in GameOnix and by email.",
  };
  const actionResponse = {
    success: data.success === true,
    message:
      data.message ||
      fallbackMessages[actionBody.action] ||
      "The admin action was completed.",
  };
  if (actionBody.action === "update-game-request") {
    actionResponse.notificationSentAt = String(
      data.notificationSentAt || ""
    );
    actionResponse.emailSentAt = String(data.emailSentAt || "");
  }
  if (actionBody.action === "reply-support-report") {
    actionResponse.notificationSent = data.notificationSent === true;
    actionResponse.emailSent = data.emailSent === true;
  }
  if (actionBody.action === "update-support-ticket-status") {
    actionResponse.notificationSent = data.notificationSent === true;
    actionResponse.status = String(data.report?.details?.status || actionBody.status || "");
  }
  if (data.status !== undefined) {
    actionResponse.status = String(data.status);
  }
  return res.status(200).json(actionResponse);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  if (req.query?.siteStatus === "1") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "OPTIONS"]);
    try {
      const siteControl = await getSiteControl();
      // This endpoint is read cross-origin. Shared caching can serve a cached
      // response without the requesting origin's CORS headers.
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.status(200).json(siteControl);
    } catch (error) {
      console.error("Site status request failed:", error.message);
      return res.status(503).json({ error: "Website status is temporarily unavailable." });
    }
  }

  if (req.query?.admin === "tools") {
    if (!["GET", "POST"].includes(req.method)) {
      return methodNotAllowed(res, ["GET", "POST", "OPTIONS"]);
    }
    try {
      return await handleAdminTools(req, res);
    } catch (error) {
      console.error("Admin tools request failed:", error.message);
      return res.status(502).json({
        error: "Unable to process the admin tools request.",
      });
    }
  }

  if (req.query?.admin === "users") {
    try {
      return await handleUsersAdmin(req, res);
    } catch (error) {
      console.error("User management request failed:", error.message);
      return res.status(500).json({
        error: "Unable to process the user management request.",
      });
    }
  }

  if (req.method === "POST") {
    try {
      const session = getSession(req);
      if (!session?.username) return res.status(401).json({ error: "Please sign in again." });

      const body = getJsonBody(req);
      if (body.action !== "report-app-version") {
        return res.status(400).json({ error: "Unknown account action." });
      }
      const version = typeof body.version === "string" ? body.version.trim() : "";
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || version.length > 64) {
        return res.status(400).json({ error: "A valid application version is required." });
      }

      const users = await getUsers();
      const user = users.find((item) =>
        String(item.username || "").trim().toLowerCase() === String(session.username).trim().toLowerCase()
      );
      if (!user || (user.status && String(user.status).trim().toLowerCase() !== "active")) {
        clearSession(res);
        return res.status(401).json({ error: "The account is unavailable." });
      }
      const saved = await recordDesktopAppVersion(user.username, version);
      if (!saved) return res.status(404).json({ error: "The account was not found." });
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ success: true, version });
    } catch (error) {
      console.error("Desktop app version report failed:", error?.message || error);
      return res.status(503).json({ error: "Could not save the app version right now." });
    }
  }

  if (await blockIfSitePaused(res)) return;

  // Public reviews live on this function because the Hobby plan allows at most
  // 12 serverless functions per deployment. `/api/auth/comments` is rewritten
  // to `?reviews=public` in vercel.json.
  if (req.query?.reviews === "public") {
    return handlePublicReviews(req, res);
  }

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET", "OPTIONS"]);
  }

  // getSession() cannot verify a cookie or bearer token without this secret.
  // Report a configuration failure explicitly instead of masking it as a
  // generic session lookup error.
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    console.error("SESSION_SECRET is missing or too short.");
    return res.status(503).json({
      error: "Session authentication is temporarily unavailable.",
    });
  }

  const wantsToken = req.query?.token === "true";
  const communityTokenSecret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (wantsToken && (!communityTokenSecret || communityTokenSecret.length < 32)) {
    console.error("GAMEONIX_API_TOKEN_SECRET is missing or too short.");
    return res.status(503).json({
      error: "Community token service is temporarily unavailable.",
    });
  }

  try {
    const session = getSession(req);

    if (!session?.username) {
      clearSession(res);
      return res.status(401).json({ user: null });
    }

    const users = await getUsers();
    const user = users.find(
      (item) =>
        String(item.username || "").toLowerCase() ===
        String(session.username).toLowerCase()
    );

    if (!user || (user.status && String(user.status).trim().toLowerCase() !== "active")) {
      clearSession(res);
      return res.status(401).json({ user: null });
    }

    // Existing behavior remains unchanged unless token=true is requested.
    if (wantsToken) {
      const token = jwt.sign(
        { username: user.username },
        communityTokenSecret,
        {
          algorithm: "HS256",
          expiresIn: "5m",
          issuer: "gameonix-community-api",
          audience: "gameonix-web",
        }
      );

      return res.status(200).json({ token });
    }

    return res.status(200).json({ user: publicUser(user) });
  } catch (error) {
    console.error("Session lookup error:", error.message);
    if (error.message?.includes("Google Sheets environment variables")) {
      return res.status(503).json({
        error: "Account data is temporarily unavailable.",
      });
    }
    return res.status(500).json({
      error: "Unable to check the current session.",
    });
  }
}
