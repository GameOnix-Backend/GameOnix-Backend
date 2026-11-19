import { randomUUID } from "node:crypto";
import { google } from "googleapis";

const SHEET = "Game Analytics";
const HEADERS = ["event_id", "slug", "event", "created_at"];
let initialized = false;

function getClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "");
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!email || !key || !spreadsheetId) throw new Error("Google Sheets environment variables are missing.");
  const auth = new google.auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return { api: google.sheets({ version: "v4", auth }), spreadsheetId };
}

async function ensureSheet(api, spreadsheetId) {
  const metadata = await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" });
  let tab = metadata.data.sheets?.find((item) => item.properties?.title === SHEET);
  if (!tab) {
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET } } }] } });
    tab = (await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" })).data.sheets?.find((item) => item.properties?.title === SHEET);
  }
  if (!tab) throw new Error(`Could not create the ${SHEET} sheet.`);
  if (!initialized) {
    const { data } = await api.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET}'!A1:D1` });
    const header = data.values?.[0] || [];
    if (!header.length) await api.spreadsheets.values.update({ spreadsheetId, range: `'${SHEET}'!A1:D1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
    else if (HEADERS.some((value, index) => header[index] !== value)) throw new Error(`The ${SHEET} sheet has unexpected headers.`);
    initialized = true;
  }
}

export async function recordGameEvent(slug, event) {
  const { api, spreadsheetId } = getClient();
  await ensureSheet(api, spreadsheetId);
  await api.spreadsheets.values.append({ spreadsheetId, range: `'${SHEET}'!A:D`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [[randomUUID(), slug, event, new Date().toISOString()]] } });
}

export async function getGameEventCounts() {
  const { api, spreadsheetId } = getClient();
  await ensureSheet(api, spreadsheetId);
  const { data } = await api.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET}'!A2:D` });
  const counts = new Map();
  let shoppingViews = 0;
  for (const row of data.values || []) {
    const slug = String(row[1] || "");
    const event = String(row[2] || "");
    if (event === "shopping-view") {
      shoppingViews += 1;
      continue;
    }
    if (!slug || !["view", "download"].includes(event)) continue;
    const entry = counts.get(slug) || { views: 0, downloads: 0 };
    entry[event === "view" ? "views" : "downloads"] += 1;
    counts.set(slug, entry);
  }
  return { games: counts, shoppingViews };
}
