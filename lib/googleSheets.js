
import { randomUUID } from "node:crypto";
import { google } from "googleapis";

const HEADERS = [
  "username",
  "password_hash",
  "email",
  "name",
  "created_at",
  "comments",
  "likes",
  "favorites",
  "theme",
  "avatar",
  "status",
  "verification_code_hash",
  "verification_expires_at",
  "pending_expires_at",
  "reset_password_code_hash",
  "reset_password_expires_at",
  "reset_password_attempts",
  "pending_email",
  "email_change_code_hash",
  "email_change_expires_at",
  "wallet",
];

const WALLET_LEDGER_SHEET = "Wallet Transactions";
const WALLET_LEDGER_HEADERS = [
  "transaction_id",
  "username",
  "type",
  "description",
  "amount",
  "status",
  "created_at",
];

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!process.env.GOOGLE_SHEET_ID || !email || !privateKey) {
    throw new Error(
      "Google Sheets environment variables are not configured."
    );
  }

  privateKey = privateKey
    .replace(/\\n/g, "\n")
    .replace(/^"|"$/g, "");

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });

  return google.sheets({ version: "v4", auth });
}

function sheetName() {
  return process.env.GOOGLE_SHEET_NAME || "Sheet1";
}

function columnToLetter(column) {
  let result = "";
  let current = column;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}

function sheetRange() {
  const name = sheetName().replace(/'/g, "''");
  return `'${name}'!A:${columnToLetter(HEADERS.length)}`;
}

function serializeCell(header, value) {
  if (["comments", "likes", "favorites"].includes(header)) {
    return typeof value === "string"
      ? value
      : JSON.stringify(value ?? []);
  }

  if (header === "theme") return value || "dark";
  if (header === "reset_password_attempts") return value ?? "0";

  if (header === "wallet") {
    if (value === "" || value === undefined || value === null) return "";
    const amount = Number(value);
    return Number.isFinite(amount) ? String(amount) : "";
  }

  return value ?? "";
}

function userToRow(user) {
  return HEADERS.map((header) =>
    serializeCell(header, user[header])
  );
}

function parseJsonCell(value) {
  if (!value) return [];

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function validateHeaders(headers) {
  const missing = HEADERS.filter(
    (header) => !headers.includes(header)
  );

  if (missing.length) {
    throw new Error(
      `Google Sheet is missing required headers: ${missing.join(", ")}`
    );
  }
}

function parseRows(rows) {
  if (!rows.length) {
    throw new Error(
      "Google Sheet is empty. Add the required header row first."
    );
  }

  const headers = rows[0].map((header) =>
    String(header).trim()
  );

  validateHeaders(headers);

  return {
    headers,
    users: rows
      .slice(1)
      .flatMap((row, index) => {
        if (!row.some((cell) => String(cell ?? "").trim())) return [];
        return [{
          ...Object.fromEntries(headers.map((header, columnIndex) => [header, row[columnIndex] ?? ""])),
          _sheetRow: index + 2,
        }];
      }),
  };
}

export async function getUsers() {
  const sheets = getSheetsClient();

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: sheetRange(),
  });

  return parseRows(result.data.values || []).users;
}

export async function appendUser(user) {
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: sheetRange(),
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [userToRow(user)],
    },
  });
}

async function findUserRow(sheets, spreadsheetId, username) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(),
  });

  const rows = result.data.values || [];
  const { headers } = parseRows(rows);

  const usernameIndex = headers.indexOf("username");

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameIndex] || "").trim().toLowerCase() ===
      String(username).trim().toLowerCase()
  );

  if (rowIndex === -1) throw new Error("User not found in Google Sheet.");

  return { rows, headers, rowIndex };
}

export async function updateUser(username, updates) {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const { rows, headers, rowIndex } = await findUserRow(
    sheets,
    spreadsheetId,
    username
  );

  const currentRow = rows[rowIndex] || [];

  const currentUser = Object.fromEntries(
    headers.map((header, index) => [
      header,
      currentRow[index] ?? "",
    ])
  );

  const updatedUser = { ...currentUser, ...updates };

  const values = headers.map((header) =>
    serializeCell(header, updatedUser[header])
  );

  const sheetRow = rowIndex + 1;
  const escapedName = (
    process.env.GOOGLE_SHEET_NAME || "Sheet1"
  ).replace(/'/g, "''");

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${escapedName}'!A${sheetRow}:${columnToLetter(headers.length)}${sheetRow}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [values],
    },
  });

  return updatedUser;
}

export async function deleteUserBySheetRow(rowNumber) {
  if (!Number.isSafeInteger(rowNumber) || rowNumber < 2) {
    throw new Error("The account row number is invalid.");
  }

  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(),
  });
  const { users } = parseRows(result.data.values || []);
  const user = users.find((item) => Number(item._sheetRow) === rowNumber);
  if (!user) throw new Error("Account row not found.");

  const pendingHash = String(user.pending_email || "");
  const isMalformed =
    !String(user.username || "").trim() &&
    !String(user.email || "").trim() &&
    /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(pendingHash);
  if (!isMalformed) {
    throw new Error("Refusing to delete a row that does not match the malformed-account pattern.");
  }

  const escapedSheetName = sheetName().replace(/'/g, "''");
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "'" + escapedSheetName + "'!A" + rowNumber + ":" + columnToLetter(HEADERS.length) + rowNumber,
  });
}

export async function deleteUser(username) {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const { rowIndex } = await findUserRow(sheets, spreadsheetId, username);
  const rowNumber = rowIndex + 1;
  const escapedSheetName = sheetName().replace(/'/g, "''");
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${escapedSheetName}'!A${rowNumber}:${columnToLetter(HEADERS.length)}${rowNumber}`,
  });
}

export function publicUser(user) {
  const storedFavorites = parseJsonCell(user.favorites);
  return {
    username: user.username,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    comments: parseJsonCell(user.comments),
    likes: parseJsonCell(user.likes),
    favorites: Array.isArray(storedFavorites)
      ? storedFavorites.filter((item) => typeof item === "string" && !item.startsWith("follow|"))
      : storedFavorites,
    wallet: Number(user.wallet || 0),
    theme: user.theme || "dark",
    avatar:
      user.avatar ||
      "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-All/main/0.png",
  };
}

// ==========================================
// WALLET BALANCE
// The balance lives in column U (`wallet`) of the
// users sheet; movements are appended to the
// "Wallet Transactions" tab so the website wallet
// history stays in sync.
// ==========================================

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function getWalletBalance(user) {
  const balance = Number(user?.wallet ?? 0);
  return Number.isFinite(balance) ? balance : 0;
}

export async function findUserByUsernameOrEmail(identifier) {
  const needle = String(identifier || "").trim().toLowerCase();
  if (!needle) return null;

  const users = await getUsers();

  return (
    users.find(
      (user) =>
        String(user.username || "").trim().toLowerCase() === needle ||
        String(user.email || "").trim().toLowerCase() === needle
    ) || null
  );
}

export async function appendWalletTransaction({
  username,
  type,
  description,
  amount,
  status = "completed",
}) {
  const sheets = getSheetsClient();
  const transactionId = randomUUID();

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${WALLET_LEDGER_SHEET}'!A:G`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        transactionId,
        username,
        type,
        typeof description === "string"
          ? description
          : JSON.stringify(description ?? {}),
        String(roundMoney(amount)),
        status,
        new Date().toISOString(),
      ]],
    },
  });

  return { id: transactionId, type, status };
}

export async function adjustWalletBalance({
  identifier,
  amount,
  note,
  adjustedBy,
}) {
  const delta = roundMoney(amount);

  if (!Number.isFinite(delta) || delta === 0) {
    throw badRequest("Enter an amount other than zero.");
  }

  if (Math.abs(delta) > 1_000_000) {
    throw badRequest("The amount is too large.");
  }

  const user = await findUserByUsernameOrEmail(identifier);
  if (!user) {
    throw notFound("No account matches that username or email.");
  }

  const username = String(user.username).trim();
  const previousBalance = getWalletBalance(user);
  const balance = roundMoney(previousBalance + delta);

  if (balance < 0) {
    throw badRequest(
      `The balance cannot go below zero. Current balance is ${previousBalance}.`
    );
  }

  const noteText = String(note || "").trim().slice(0, 300);
  const isCredit = delta > 0;

  await updateUser(username, { wallet: balance });

  const transaction = await appendWalletTransaction({
    username,
    type: isCredit ? "top_up_request" : "purchase_request",
    amount: Math.abs(delta),
    description: isCredit
      ? JSON.stringify({
          paymentMethod: "Admin credit",
          adminNote: noteText,
          adjustedBy: adjustedBy || "Publisher",
        })
      : JSON.stringify({
          gameName: "Admin adjustment",
          packageName: noteText || "Balance deducted by the admin",
          quantity: 1,
          paymentMethod: "Admin",
        }),
  });

  return {
    username,
    email: String(user.email || "").trim(),
    previousBalance,
    balance,
    amount: delta,
    transactionId: transaction.id,
  };
}

// ==========================================
// COMMUNITY REVIEWS
// Reviews live inside the existing `comments`
// column as JSON entries, so no extra files or
// sheets are needed.
// ==========================================

const REVIEW_TARGETS = ["game", "site"];
const REVIEW_ACTIONS = [
  "hide",
  "unhide",
  "feature",
  "unfeature",
  "delete",
  "update",
  "reply",
  "clear-reply",
];
const MAX_REVIEWS_RETURNED = 500;
const MAX_REVIEW_COMMENT = 2000;
const MAX_ADMIN_REPLY = 600;

function parseCommentsCell(value, { strict = false } = {}) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    if (strict) {
      throw new Error("The stored comments value is not valid JSON.");
    }
    return [];
  }
}

function isReviewEntry(entry) {
  return Boolean(entry) &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.type === "review" &&
    REVIEW_TARGETS.includes(entry.target) &&
    typeof entry.id === "string" &&
    entry.id.length > 0;
}

function isReviewSettingsEntry(entry) {
  return Boolean(entry) &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.type === "review-settings";
}

function findReviewSettings(comments) {
  return comments.find(isReviewSettingsEntry) || null;
}

function findUserByName(users, username) {
  const needle = String(username || "").trim().toLowerCase();
  return users.find(
    (user) => String(user.username || "").trim().toLowerCase() === needle
  );
}

function normalizeReviewText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw badRequest(`${label} is required.`);
  }

  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw badRequest(`${label} must be between 1 and ${maxLength} characters.`);
  }

  return text;
}

function reviewToJson(entry, username) {
  return {
    id: entry.id,
    type: "review",
    target: entry.target,
    gameSlug: typeof entry.gameSlug === "string" ? entry.gameSlug : "",
    gameTitle: typeof entry.gameTitle === "string" ? entry.gameTitle : "",
    rating: Number(entry.rating) || 0,
    comment: typeof entry.comment === "string" ? entry.comment : "",
    createdAt: entry.createdAt || "",
    updatedAt: entry.updatedAt || entry.createdAt || "",
    hidden: entry.hidden === true,
    hiddenAt: entry.hiddenAt || "",
    featured: entry.featured === true,
    featuredAt: entry.featuredAt || "",
    adminReply: typeof entry.adminReply === "string" ? entry.adminReply : "",
    adminReplyAt: entry.adminReplyAt || "",
    editedByAdminAt: entry.editedByAdminAt || "",
    username,
  };
}

function compareReviews(left, right) {
  if (left.featured !== right.featured) return left.featured ? -1 : 1;
  return (
    Date.parse(right.updatedAt || right.createdAt || "") -
    Date.parse(left.updatedAt || left.createdAt || "")
  );
}

export async function getReviews({ target, gameSlug, includeHidden = false } = {}) {
  const users = await getUsers();
  const reviews = [];

  for (const user of users) {
    const username = String(user.username || "").trim();
    if (!username) continue;
    if (String(user.status || "active").trim().toLowerCase() === "banned") continue;

    for (const entry of parseCommentsCell(user.comments)) {
      if (!isReviewEntry(entry)) continue;
      if (!includeHidden && entry.hidden === true) continue;
      if (target && entry.target !== target) continue;
      if (gameSlug && entry.gameSlug !== gameSlug) continue;

      reviews.push(reviewToJson(entry, username));
    }
  }

  return reviews.sort(compareReviews).slice(0, MAX_REVIEWS_RETURNED);
}

export async function saveReviewByUsername(username, review) {
  const user = findUserByName(await getUsers(), username);
  if (!user) return null;

  const comments = parseCommentsCell(user.comments, { strict: true });

  const settings = findReviewSettings(comments);
  if (settings?.blocked === true) {
    const error = new Error("Reviewing is disabled for this account.");
    error.status = 403;
    throw error;
  }

  const existingIndex = comments.findIndex(
    (entry) =>
      isReviewEntry(entry) &&
      entry.target === review.target &&
      (review.target === "site" || entry.gameSlug === review.gameSlug)
  );
  const existing = existingIndex === -1 ? null : comments[existingIndex];
  const now = new Date().toISOString();

  const savedReview = {
    type: "review",
    id: existing?.id || review.id,
    target: review.target,
    ...(review.target === "game"
      ? { gameSlug: review.gameSlug, gameTitle: review.gameTitle }
      : {}),
    rating: review.rating,
    comment: review.comment,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    hidden: existing?.hidden === true,
    hiddenAt: existing?.hiddenAt || "",
    featured: existing?.featured === true,
    featuredAt: existing?.featuredAt || "",
    adminReply: existing?.adminReply || "",
    adminReplyAt: existing?.adminReplyAt || "",
    editedByAdminAt: existing?.editedByAdminAt || "",
  };

  if (existingIndex === -1) {
    comments.push(savedReview);
  } else {
    comments[existingIndex] = savedReview;
  }

  const updatedUser = await updateUser(user.username, { comments });

  return reviewToJson(savedReview, String(updatedUser.username || user.username).trim());
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export async function getBlockedReviewUsers() {
  const users = await getUsers();
  const blocked = [];

  for (const user of users) {
    const username = String(user.username || "").trim();
    if (!username) continue;

    const settings = findReviewSettings(parseCommentsCell(user.comments));
    if (settings?.blocked === true) {
      blocked.push({ username, blockedAt: settings.blockedAt || "" });
    }
  }

  return blocked;
}

export async function setReviewBlock({ username, blocked }) {
  const user = findUserByName(await getUsers(), username);
  if (!user) throw notFound("User not found.");

  const comments = parseCommentsCell(user.comments, { strict: true });
  const settingsIndex = comments.findIndex(isReviewSettingsEntry);
  const isBlocked = blocked === true;
  const settings = {
    type: "review-settings",
    blocked: isBlocked,
    blockedAt: isBlocked ? new Date().toISOString() : "",
  };

  if (settingsIndex === -1) {
    comments.push(settings);
  } else {
    comments[settingsIndex] = settings;
  }

  await updateUser(user.username, { comments });

  return {
    username: String(user.username).trim(),
    blocked: settings.blocked,
    blockedAt: settings.blockedAt,
  };
}

export async function moderateReview({
  username,
  reviewId,
  action,
  rating,
  comment,
  reply,
}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!REVIEW_ACTIONS.includes(normalizedAction)) {
    throw badRequest("Unsupported review action.");
  }

  const user = findUserByName(await getUsers(), username);
  if (!user) throw notFound("User not found.");

  const comments = parseCommentsCell(user.comments, { strict: true });
  const reviewIndex = comments.findIndex(
    (entry) => isReviewEntry(entry) && entry.id === reviewId
  );
  if (reviewIndex === -1) throw notFound("Review not found.");

  if (normalizedAction === "delete") {
    const [removed] = comments.splice(reviewIndex, 1);
    await updateUser(user.username, { comments });

    return {
      deleted: true,
      reviewId: removed.id,
      username: String(user.username).trim(),
    };
  }

  const now = new Date().toISOString();
  const entry = { ...comments[reviewIndex] };

  if (normalizedAction === "update") {
    if (rating !== undefined) {
      const nextRating = Number(rating);
      if (!Number.isInteger(nextRating) || nextRating < 1 || nextRating > 5) {
        throw badRequest("Rating must be a whole number from 1 to 5.");
      }
      entry.rating = nextRating;
    }

    if (comment !== undefined) {
      entry.comment = normalizeReviewText(comment, "Review", MAX_REVIEW_COMMENT);
    }

    entry.editedByAdminAt = now;
  }

  if (normalizedAction === "reply") {
    entry.adminReply = normalizeReviewText(reply, "Reply", MAX_ADMIN_REPLY);
    entry.adminReplyAt = now;
  }

  if (normalizedAction === "clear-reply") {
    entry.adminReply = "";
    entry.adminReplyAt = "";
  }

  if (normalizedAction === "hide") {
    entry.hidden = true;
    entry.hiddenAt = now;
  }
  if (normalizedAction === "unhide") {
    entry.hidden = false;
    entry.hiddenAt = "";
  }
  if (normalizedAction === "feature") {
    entry.featured = true;
    entry.featuredAt = now;
  }
  if (normalizedAction === "unfeature") {
    entry.featured = false;
    entry.featuredAt = "";
  }

  comments[reviewIndex] = entry;
  await updateUser(user.username, { comments });

  return {
    deleted: false,
    review: reviewToJson(entry, String(user.username).trim()),
  };
}

