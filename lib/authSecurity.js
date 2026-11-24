import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { google } from "googleapis";

const SECURITY_SHEET = "Auth Security";
const SECURITY_HEADERS = [
  "timestamp",
  "action",
  "ip",
  "client_hash",
  "email",
  "username",
  "identity",
  "result",
];
const BLOCKS_SHEET = "Signup IP Blocks";
const BLOCKS_HEADERS = ["timestamp", "ip", "blocked", "reason"];
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_REGISTRATIONS_PER_BROWSER = 2;
const MAX_REGISTRATIONS_PER_IP = 5;
const MAX_LOGIN_FAILURES = 5;
const MAX_READ_ROWS = 3000;

let sheetsClient;
let spreadsheetId;
let securitySheetId;
let blocksSheetId;
let lastKnownRow = 1000;
let sheetInitialization;
let blocksInitialization;
let eventsCache;
let eventsCacheUntil = 0;
let blockedIpsCache;
let blockedIpsCacheUntil = 0;
const EVENTS_CACHE_MS = 3000;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !email || !privateKey) {
    throw new Error("Google Sheets environment variables are not configured.");
  }
  privateKey = privateKey.replace(/\\n/g, "\n").replace(/^"|"$/g, "");
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function initializeSecuritySheet() {
  if (securitySheetId) return;
  const sheets = getSheetsClient();
  let metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title,gridProperties(rowCount))",
  });
  let entry = (metadata.data.sheets || []).find(
    (sheet) => sheet.properties?.title === SECURITY_SHEET,
  );
  if (!entry) {
    try {
      const created = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: SECURITY_SHEET } } }],
        },
      });
      entry = { properties: created.data.replies?.[0]?.addSheet?.properties };
    } catch (error) {
      metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties(sheetId,title,gridProperties(rowCount))",
      });
      entry = (metadata.data.sheets || []).find(
        (sheet) => sheet.properties?.title === SECURITY_SHEET,
      );
      if (!entry) throw error;
    }
  }
  if (!entry?.properties?.sheetId) {
    throw new Error("Could not initialize the Auth Security sheet.");
  }
  securitySheetId = entry.properties.sheetId;
  lastKnownRow = Math.max(2, Number(entry.properties.gridProperties?.rowCount) || 1000);
  const header = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SECURITY_SHEET}'!A1:H1`,
  });
  const actualHeaders = header.data.values?.[0] || [];
  if (actualHeaders.join("|") !== SECURITY_HEADERS.join("|")) {
    if (actualHeaders.length) {
      throw new Error("The Auth Security sheet exists with an unexpected header row.");
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SECURITY_SHEET}'!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [SECURITY_HEADERS] },
    });
  }
}

async function readySecuritySheet() {
  if (securitySheetId) return;
  if (!sheetInitialization) {
    sheetInitialization = initializeSecuritySheet().finally(() => {
      sheetInitialization = null;
    });
  }
  await sheetInitialization;
}

async function initializeBlocksSheet() {
  if (blocksSheetId) return;
  const sheets = getSheetsClient();
  let metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  let entry = (metadata.data.sheets || []).find(
    (sheet) => sheet.properties?.title === BLOCKS_SHEET,
  );
  if (!entry) {
    try {
      const created = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: BLOCKS_SHEET } } }],
        },
      });
      entry = { properties: created.data.replies?.[0]?.addSheet?.properties };
    } catch (error) {
      metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties(sheetId,title)",
      });
      entry = (metadata.data.sheets || []).find(
        (sheet) => sheet.properties?.title === BLOCKS_SHEET,
      );
      if (!entry) throw error;
    }
  }
  if (!entry?.properties?.sheetId) throw new Error("Could not initialize the Signup IP Blocks sheet.");
  blocksSheetId = entry.properties.sheetId;
  const header = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${BLOCKS_SHEET}'!A1:D1`,
  });
  const actualHeaders = header.data.values?.[0] || [];
  if (actualHeaders.join("|") !== BLOCKS_HEADERS.join("|")) {
    if (actualHeaders.length) throw new Error("The Signup IP Blocks sheet has an unexpected header row.");
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${BLOCKS_SHEET}'!A1:D1`,
      valueInputOption: "RAW",
      requestBody: { values: [BLOCKS_HEADERS] },
    });
  }
}

async function readyBlocksSheet() {
  if (blocksSheetId) return;
  if (!blocksInitialization) {
    blocksInitialization = initializeBlocksSheet().finally(() => {
      blocksInitialization = null;
    });
  }
  await blocksInitialization;
}

async function readIpBlocks() {
  if (blockedIpsCache && Date.now() < blockedIpsCacheUntil) return blockedIpsCache;
  await readyBlocksSheet();
  const result = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId,
    range: `'${BLOCKS_SHEET}'!A1:D`,
  });
  const blocks = new Map();
  for (const row of (result.data.values || []).slice(1)) {
    const ip = normalizeIp(row[1]);
    if (!ip) continue;
    blocks.set(ip, {
      ip,
      blocked: String(row[2] || "").toLowerCase() === "true",
      blockedAt: String(row[0] || ""),
      reason: cleanField(row[3]),
    });
  }
  blockedIpsCache = blocks;
  blockedIpsCacheUntil = Date.now() + EVENTS_CACHE_MS;
  return blocks;
}

function normalizeIp(value) {
  const ip = String(value || "").trim().replace(/^\[|\]$/g, "");
  return isIP(ip) ? ip.toLowerCase() : "";
}

export function getRequestIp(req) {
  const direct = normalizeIp(req.headers["x-real-ip"]);
  if (direct) return direct;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0];
  return normalizeIp(forwarded);
}

function getClientHash(req) {
  const raw = String(req.headers["x-gameonix-client-id"] || "").trim();
  if (raw.length < 8 || raw.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(raw)) return "";
  return createHash("sha256").update(raw).digest("hex");
}

function cleanField(value, maxLength = 180) {
  return String(value || "").trim().replace(/[\r\n\t]/g, " ").slice(0, maxLength);
}

function rowToEvent(row) {
  return {
    timestamp: String(row[0] || ""),
    action: String(row[1] || ""),
    ip: normalizeIp(row[2]),
    clientHash: String(row[3] || ""),
    email: cleanField(row[4]).toLowerCase(),
    username: cleanField(row[5]),
    identity: cleanField(row[6]).toLowerCase(),
    result: cleanField(row[7], 80),
  };
}

async function readEvents() {
  if (eventsCache && Date.now() < eventsCacheUntil) return eventsCache;
  await readySecuritySheet();
  const startRow = Math.max(1, lastKnownRow - MAX_READ_ROWS + 1);
  const result = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId,
    range: `'${SECURITY_SHEET}'!A${startRow}:H${lastKnownRow}`,
  });
  eventsCache = (result.data.values || [])
    .map(rowToEvent)
    .filter((event) => Number.isFinite(Date.parse(event.timestamp)) && event.action);
  eventsCacheUntil = Date.now() + EVENTS_CACHE_MS;
  return eventsCache;
}

async function appendEvent(req, {
  action,
  email = "",
  username = "",
  identity = "",
  result = "received",
  ip = getRequestIp(req),
  clientHash = getClientHash(req),
} = {}) {
  await readySecuritySheet();
  const timestamp = new Date().toISOString();
  const response = await getSheetsClient().spreadsheets.values.append({
    spreadsheetId,
    range: `'${SECURITY_SHEET}'!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        timestamp,
        action,
        ip,
        clientHash,
        cleanField(email).toLowerCase(),
        cleanField(username),
        cleanField(identity).toLowerCase(),
        result,
      ]],
    },
  });
  const match = String(response.data.updates?.updatedRange || "").match(/![A-Z]+(\d+):/);
  if (match) lastKnownRow = Math.max(lastKnownRow, Number(match[1]));
  const event = {
    timestamp,
    action,
    ip,
    clientHash,
    email: cleanField(email).toLowerCase(),
    username: cleanField(username),
    identity: cleanField(identity).toLowerCase(),
    result,
  };
  if (eventsCache) {
    eventsCache.push(event);
    eventsCacheUntil = Date.now() + EVENTS_CACHE_MS;
  } else {
    eventsCacheUntil = 0;
  }
}

function eventsMatchRequest(event, ip, clientHash) {
  return (ip && event.ip === ip) || (clientHash && event.clientHash === clientHash);
}

export async function checkRegistrationAttempt(req, { email, username } = {}) {
  const ip = getRequestIp(req);
  const clientHash = getClientHash(req);
  const events = await readEvents();
  const blocks = await readIpBlocks();
  const now = Date.now();
  const recent = events.filter((event) =>
    event.action === "register" &&
    now - (Date.parse(event.timestamp) || 0) < REGISTRATION_WINDOW_MS &&
    eventsMatchRequest(event, ip, clientHash),
  );
  const sameBrowser = clientHash
    ? recent.filter((event) => event.clientHash === clientHash).length
    : 0;
  const sameIp = ip ? recent.filter((event) => event.ip === ip).length : 0;
  const manuallyBlocked = Boolean(ip && blocks.get(ip)?.blocked);
  const limited = clientHash
    ? sameBrowser >= MAX_REGISTRATIONS_PER_BROWSER || sameIp >= MAX_REGISTRATIONS_PER_IP
    : sameIp >= MAX_REGISTRATIONS_PER_BROWSER;
  const firstLimitedAttempt = limited && (clientHash
    ? sameBrowser === MAX_REGISTRATIONS_PER_BROWSER || sameIp === MAX_REGISTRATIONS_PER_IP
    : sameIp === MAX_REGISTRATIONS_PER_BROWSER);
  if (!manuallyBlocked && (!limited || firstLimitedAttempt)) {
    await appendEvent(req, {
      action: "register",
      email,
      username,
      result: limited ? "rate_limited" : "received",
      ip,
      clientHash,
    });
  }
  return {
    blocked: manuallyBlocked || limited,
    reason: manuallyBlocked ? "This network is blocked from creating accounts." :
      limited ? "Too many registration attempts. Please try again later." : "",
    ip,
  };
}

export async function checkLoginAttempt(req) {
  const ip = getRequestIp(req);
  const clientHash = getClientHash(req);
  const events = await readEvents();
  const now = Date.now();
  const failures = events.filter((event) =>
    event.action === "login_failed" &&
    now - (Date.parse(event.timestamp) || 0) < LOGIN_WINDOW_MS &&
    eventsMatchRequest(event, ip, clientHash),
  );
  return failures.length >= MAX_LOGIN_FAILURES;
}

export async function recordLoginAttempt(req, { identity, success }) {
  if (success) return;
  await appendEvent(req, {
    action: "login_failed",
    identity,
    result: "invalid_credentials",
  });
}

export async function setSignupIpBlock(ipValue, blocked, reason = "") {
  const ip = normalizeIp(ipValue);
  if (!ip) throw new Error("Enter a valid IPv4 or IPv6 address.");
  await readyBlocksSheet();
  const timestamp = new Date().toISOString();
  await getSheetsClient().spreadsheets.values.append({
    spreadsheetId,
    range: `'${BLOCKS_SHEET}'!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[timestamp, ip, Boolean(blocked), cleanField(reason || "Publisher admin action")]],
    },
  });
  if (!blockedIpsCache) blockedIpsCache = new Map();
  blockedIpsCache.set(ip, {
    ip,
    blocked: Boolean(blocked),
    blockedAt: timestamp,
    reason: cleanField(reason || "Publisher admin action"),
  });
  blockedIpsCacheUntil = Date.now() + EVENTS_CACHE_MS;
  return { ip, blocked: Boolean(blocked) };
}

export async function getAuthAbuseReport() {
  const events = await readEvents();
  const now = Date.now();
  const blocks = await readIpBlocks();
  const grouped = new Map();
  for (const event of events) {
    if (!["register", "login_failed", "login_blocked"].includes(event.action)) continue;
    const timestamp = Date.parse(event.timestamp) || 0;
    if (now - timestamp > REPORT_WINDOW_MS) continue;
    const key = event.ip || "unknown";
    let group = grouped.get(key);
    if (!group) {
      group = {
        ip: event.ip || "Unknown",
        attempts: 0,
        registrationAttempts: 0,
        failedLogins: 0,
        identities: new Set(),
        usernames: new Set(),
        lastAttemptAt: event.timestamp,
      };
      grouped.set(key, group);
    }
    group.attempts += 1;
    if (event.action === "register") group.registrationAttempts += 1;
    else group.failedLogins += 1;
    if (event.email) group.identities.add(event.email);
    if (event.identity) group.identities.add(event.identity);
    if (event.username) group.usernames.add(event.username);
    if (timestamp > (Date.parse(group.lastAttemptAt) || 0)) group.lastAttemptAt = event.timestamp;
  }
  const attempts = [...grouped.values()]
    .filter((group) => group.attempts > 2)
    .map((group) => ({
      ...group,
      identities: [...group.identities].slice(0, 6),
      usernames: [...group.usernames].slice(0, 6),
      blocked: group.ip !== "Unknown" && Boolean(blocks.get(group.ip)?.blocked),
    }))
    .sort((a, b) => Date.parse(b.lastAttemptAt) - Date.parse(a.lastAttemptAt));
  const blockedIps = [...blocks.values()]
    .filter((block) => block.blocked)
    .map(({ ip, blockedAt, reason }) => ({ ip, blockedAt, reason }));
  return { attempts, blockedIps };
}
