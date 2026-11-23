const RESERVED_USERNAME_PATTERNS = [
  /^(?:admin|administrator|adminstrator|adminastrator)[a-z\d]*$/,
  /^(?:owner|founder|creator|staff|support|moderator|official|gameonix)[a-z\d]*$/,
];

// Token matching avoids rejecting ordinary words that only contain a short
// substring, such as "assassin".
const BLOCKED_NAME_TOKENS = new Set([
  "fuck", "fucker", "fucking", "shit", "bullshit", "bitch", "bastard",
  "asshole", "dick", "piss", "cunt", "motherfucker", "slut", "whore",
  "porn", "porno", "pornhub", "xxx", "hentai", "nsfw", "sex",
  "\u0643\u0633", "\u0643\u0633\u0645", "\u0634\u0631\u0645\u0648\u0637",
  "\u0634\u0631\u0645\u0648\u0637\u0629", "\u0645\u062a\u0646\u0627\u0643",
  "\u0645\u062a\u0646\u0627\u0643\u0629", "\u062e\u0648\u0644", "\u0639\u0627\u0647\u0631\u0629",
  "\u0642\u062d\u0628\u0629", "\u0645\u0646\u064a\u0648\u0643", "\u0646\u064a\u0643",
  "\u0637\u064a\u0632", "\u0632\u0628\u064a", "\u0632\u0628",
]);

// Include common spellings/spacing variants of the adult creator names requested.
const BLOCKED_ADULT_CREATOR_NAMES = [
  "sweetiefox",
  "swittefox",
  "miakhalifa",
  "lanarhoades",
  "rileyreid",
  "johnnysins",
  "angelawhite",
  "abelladanger",
];

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[0]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t");
}

function getTokens(value) {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function isReservedUsername(username) {
  const tokens = getTokens(username);
  const compact = tokens.join("");
  const reserved = RESERVED_USERNAME_PATTERNS.some((pattern) => pattern.test(compact));
  const reservedRole = tokens.some((token) =>
    /(?:admin|administrator|adminstrator|adminastrator|owner|founder|creator|staff|support|moderator|official|gameonix)/.test(token)
  );
  return reserved || reservedRole;
}

function findBlockedName(value, { protectOwnerName = false } = {}) {
  const tokens = getTokens(value);
  const compact = tokens.join("");

  if (protectOwnerName && compact.startsWith("mahmoudpro")) {
    return "This display name is reserved.";
  }
  if (BLOCKED_ADULT_CREATOR_NAMES.some((blockedName) => compact.includes(blockedName))) {
    return "This display name is not allowed.";
  }
  if (tokens.some((token) => BLOCKED_NAME_TOKENS.has(token))) {
    return "Please choose a name without profanity or adult content.";
  }
  return "";
}

export function validateUsernamePolicy(username) {
  if (isReservedUsername(username)) {
    return "This username is reserved and cannot be used.";
  }

  if (findBlockedName(username)) {
    return "Please choose a username without profanity or adult content.";
  }

  return "";
}

export function validateDisplayNamePolicy(name) {
  const normalizedName = String(name ?? "").trim();
  if (!/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u.test(normalizedName)) {
    return "Display name can contain letters and spaces only.";
  }
  return findBlockedName(name, { protectOwnerName: true });
}
