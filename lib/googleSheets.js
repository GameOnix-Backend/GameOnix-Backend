
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

function sheetRange() {
  const name = sheetName().replace(/'/g, "''");
  return `'${name}'!A:T`;
}

function serializeCell(header, value) {
  if (["comments", "likes", "favorites"].includes(header)) {
    return typeof value === "string"
      ? value
      : JSON.stringify(value ?? []);
  }

  if (header === "theme") return value || "dark";
  if (header === "reset_password_attempts") return value ?? "0";

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
      .filter((row) =>
        row.some((cell) => String(cell ?? "").trim())
      )
      .map((row) =>
        Object.fromEntries(
          headers.map((header, index) => [
            header,
            row[index] ?? "",
          ])
        )
      ),
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
    range: `'${escapedName}'!A${sheetRow}:T${sheetRow}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [values],
    },
  });

  return updatedUser;
}

export async function deleteUser(username) {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const { rowIndex } = await findUserRow(sheets, spreadsheetId, username);
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const sheet = metadata.data.sheets?.find(
    (item) => item.properties?.title === sheetName()
  );
  const sheetId = sheet?.properties?.sheetId;

  if (!Number.isInteger(sheetId)) {
    throw new Error(`Could not find Google Sheet tab "${sheetName()}".`);
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    },
  });
}

export function publicUser(user) {
  return {
    username: user.username,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    comments: parseJsonCell(user.comments),
    likes: parseJsonCell(user.likes),
    favorites: parseJsonCell(user.favorites),
    theme: user.theme || "dark",
    avatar:
      user.avatar ||
      "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-All/main/0.png",
  };
}

// ==========================================
// COMMUNITY REVIEWS
// Reviews live inside the existing `comments`
// column as JSON entries, so no extra files or
// sheets are needed.
// ==========================================

const REVIEW_TARGETS = ["game", "site"];
const REVIEW_ACTIONS = ["hide", "unhide", "feature", "unfeature", "delete"];
const MAX_REVIEWS_RETURNED = 500;

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

function findUserByName(users, username) {
  const needle = String(username || "").trim().toLowerCase();
  return users.find(
    (user) => String(user.username || "").trim().toLowerCase() === needle
  );
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

export async function moderateReview({ username, reviewId, action }) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!REVIEW_ACTIONS.includes(normalizedAction)) {
    throw new Error("Unsupported review action.");
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

