
import {
  getUsers,
  updateUser,
  publicUser,
} from "../../lib/googleSheets.js";

import { uploadAvatarImage } from "../../lib/avatars.js";

import { getSession } from "../../lib/auth.js";

import {
  setCors,
  handleOptions,
  methodNotAllowed,
  getJsonBody,
} from "../../lib/http.js";

export default async function handler(req, res) {
  setCors(req, res);

  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST", "OPTIONS"]);
  }

  try {
    const session = getSession(req);

    if (!session?.username) {
      return res.status(401).json({
        error: "Please sign in to upload an avatar.",
      });
    }

    const users = await getUsers();

    const currentUser = users.find(
      (user) =>
        String(user.username).trim().toLowerCase() ===
        String(session.username).trim().toLowerCase()
    );

    if (!currentUser) {
      return res.status(404).json({
        error: "Your account could not be found.",
      });
    }

    if (currentUser.status && currentUser.status !== "active") {
      return res.status(403).json({
        error: "This account is not active.",
      });
    }

    const body = getJsonBody(req);

    let avatarUrl;
    try {
      avatarUrl = await uploadAvatarImage({
        imageData: body?.imageData,
        mimeType: body?.mimeType,
        username: currentUser.username,
      });
    } catch (uploadError) {
      return res
        .status(uploadError.status || 500)
        .json({ error: uploadError.message });
    }

    const updatedUser = await updateUser(currentUser.username, {
      avatar: avatarUrl,
    });

    return res.status(200).json({
      message: "Avatar uploaded successfully.",
      avatar: avatarUrl,
      user: publicUser(updatedUser),
    });
  } catch (error) {
    console.error("Avatar upload error:", error.message);

    return res.status(500).json({
      error: "Unable to upload your avatar right now.",
    });
  }
}
