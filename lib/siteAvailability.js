import { getSiteControl } from "./googleSheets.js";

export async function blockIfSitePaused(res) {
  try {
    const siteControl = await getSiteControl();
    if (siteControl.mode === "online") return false;

    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({
      error: siteControl.message || "GameOnix is temporarily unavailable.",
      siteControl,
    });
    return true;
  } catch (error) {
    // A status-store outage must not turn into an unplanned site outage.
    console.error("Could not check website availability:", error.message);
    return false;
  }
}
