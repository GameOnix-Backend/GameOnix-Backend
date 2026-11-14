import { randomUUID } from "node:crypto";

const MAX_FILE_SIZE = 2 * 1024 * 1024;

function detectImage(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    return { mime: "image/png", ext: "png" };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))
  ) {
    return { mime: "image/gif", ext: "gif" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(buffer.toString("ascii", 8, 12))
  ) {
    return { mime: "image/avif", ext: "avif" };
  }

  return null;
}

function createError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Stores an avatar image in the public image repository and returns its URL.
 * `imageData` is a plain base64 string (no data: prefix).
 */
export async function uploadAvatarImage({ imageData, mimeType, username }) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  const token = process.env.GITHUB_TOKEN;

  if (!token || !owner || !repo) {
    console.error("Avatar upload environment variables are missing.");
    throw createError("Avatar uploads are not configured.", 503);
  }

  const base64 = String(imageData || "");

  if (
    !base64 ||
    base64.length > Math.ceil(MAX_FILE_SIZE * 4 / 3) + 16 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    base64.length % 4 !== 0
  ) {
    throw createError(
      "Invalid image data or image is too large. Maximum size is 2 MB.",
      400
    );
  }

  const imageBuffer = Buffer.from(base64, "base64");

  if (
    imageBuffer.length === 0 ||
    imageBuffer.length > MAX_FILE_SIZE ||
    imageBuffer.toString("base64") !== base64
  ) {
    throw createError(
      "Invalid image data or image is too large. Maximum size is 2 MB.",
      400
    );
  }

  const detected = detectImage(imageBuffer);

  if (!detected) {
    throw createError(
      "Supported formats are PNG, JPG, WEBP, GIF, and AVIF.",
      415
    );
  }

  const suppliedMime = String(mimeType || "").toLowerCase();

  if (suppliedMime && suppliedMime !== detected.mime) {
    throw createError("The image format does not match the file content.", 415);
  }

  const safeUsername = String(username || "account")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");

  const fileName = `${safeUsername}-${randomUUID()}.${detected.ext}`;
  const path = `avatars/${fileName}`;

  const githubResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message: `Upload avatar for ${safeUsername}`,
        content: imageBuffer.toString("base64"),
        branch,
      }),
    }
  );

  if (!githubResponse.ok) {
    const details = await githubResponse.text();
    console.error(
      "GitHub avatar upload failed:",
      githubResponse.status,
      details.slice(0, 500)
    );

    throw createError(
      "Unable to upload the image to the image repository.",
      502
    );
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}
