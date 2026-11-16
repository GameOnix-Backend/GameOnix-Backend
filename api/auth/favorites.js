import { getUsers, updateUser } from "../../lib/googleSheets.js";
import { getGameEventCounts, recordGameEvent } from "../../lib/gameAnalytics.js";
import { getSession } from "../../lib/auth.js";
import {
  setCors,
  handleOptions,
  methodNotAllowed,
  getJsonBody,
} from "../../lib/http.js";

function parseFavorites(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function splitCollections(value) {
  const favorites = [];
  const follows = [];
  for (const entry of parseFavorites(value)) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("follow|")) {
      const [, slug, followedAt, addonCount] = entry.split("|");
      if (slug) follows.push({ slug, followedAt: followedAt || "", addonCount: Number(addonCount) || 0 });
    } else favorites.push(entry);
  }
  return { favorites, follows };
}

const validSlug = (slug) => typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,159}$/i.test(slug.trim());
const recentEvents = new Map();

export default async function handler(req, res) {
  setCors(req, res);

  if (handleOptions(req, res)) return;

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return methodNotAllowed(res, ["GET", "POST", "DELETE", "OPTIONS"]);
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const body = req.method === "POST" ? getJsonBody(req) : {};
    if (req.method === "POST" && body.event) {
      const { slug, event } = body;
      if (!validSlug(slug) || !["view", "download"].includes(event)) return res.status(400).json({ error: "Invalid game activity event." });
      const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
      const key = `${ip}:${event}:${slug.trim()}`;
      const cooldown = event === "view" ? 30 * 60_000 : 60_000;
      if (Date.now() - (recentEvents.get(key) || 0) >= cooldown) {
        await recordGameEvent(slug.trim(), event);
        recentEvents.set(key, Date.now());
      }
      return res.status(200).json({ recorded: true });
    }

    if (req.method === "GET" && req.query?.analytics === "1") {
      const [users, eventCounts] = await Promise.all([getUsers(), getGameEventCounts()]);
      const stats = new Map([...eventCounts].map(([slug, counts]) => [slug, { ...counts, favorites: 0, follows: 0 }]));
      for (const user of users) {
        const collections = splitCollections(user.favorites);
        for (const slug of collections.favorites) {
          const item = stats.get(slug) || { views: 0, downloads: 0, favorites: 0, follows: 0 };
          item.favorites += 1;
          stats.set(slug, item);
        }
        for (const follow of collections.follows) {
          const item = stats.get(follow.slug) || { views: 0, downloads: 0, favorites: 0, follows: 0 };
          item.follows += 1;
          stats.set(follow.slug, item);
        }
      }
      return res.status(200).json({ games: [...stats].map(([slug, counts]) => ({ slug, ...counts })) });
    }

    const session = getSession(req);

    if (!session?.username) {
      return res.status(401).json({
        error: "Please log in to manage favorites.",
      });
    }

    const users = await getUsers();
    const user = users.find(
      (item) =>
        item.username?.toLowerCase() === session.username.toLowerCase()
    );

    if (!user) {
      return res.status(401).json({ error: "User not found." });
    }

    if (user.status && String(user.status).toLowerCase() !== "active") {
      return res.status(403).json({ error: "This account is not active." });
    }

    const { favorites, follows } = splitCollections(user.favorites);

    if (req.method === "GET") {
      return req.query?.collection === "follows"
        ? res.status(200).json({ follows })
        : res.status(200).json({ favorites });
    }

    const { slug, collection, addonCount } = body;

    if (
      typeof slug !== "string" ||
      !slug.trim() ||
      slug.length > 200
    ) {
      return res.status(400).json({ error: "Invalid game slug." });
    }

    const normalizedSlug = slug.trim();
    if (collection === "follows") {
      const updatedFollows = req.method === "POST"
        ? follows.some((item) => item.slug === normalizedSlug)
          ? follows
          : [...follows, { slug: normalizedSlug, followedAt: new Date().toISOString(), addonCount: Math.max(0, Math.floor(Number(addonCount) || 0)) }]
        : follows.filter((item) => item.slug !== normalizedSlug);
      const stored = [...favorites, ...updatedFollows.map((item) => `follow|${item.slug}|${item.followedAt}|${item.addonCount}`)];
      const updatedUser = await updateUser(user.username, { favorites: JSON.stringify(stored) });
      if (!updatedUser) return res.status(500).json({ error: "Could not update followed games." });
      return res.status(200).json({ follows: updatedFollows });
    }

    let updatedFavorites;

    if (req.method === "POST") {
      updatedFavorites = favorites.includes(normalizedSlug)
        ? favorites
        : [...favorites, normalizedSlug];
    } else {
      updatedFavorites = favorites.filter(
        (favorite) => favorite !== normalizedSlug
      );
    }

    const updatedUser = await updateUser(user.username, {
      favorites: JSON.stringify(updatedFavorites),
    });

    if (!updatedUser) {
      return res.status(500).json({
        error: "Could not update favorites.",
      });
    }

    return res.status(200).json({
      favorites: updatedFavorites,
    });
  } catch (error) {
    console.error("Favorites API error:", error);

    return res.status(500).json({
      error: "An unexpected error occurred.",
    });
  }
}
