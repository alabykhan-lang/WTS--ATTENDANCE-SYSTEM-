"use strict";

import {
  ATTENDANCE_POST_LOGOUT_URI,
  clearAuthCookies,
  centralCookie,
  noStore,
  sameOrigin,
  sendJson,
  supabaseRpc,
} from "../lib/attendance-api.js";

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return sendJson(res, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (req.method === "POST" && !sameOrigin(req)) return sendJson(res, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
  const session = centralCookie(req);
  if (session) {
    await supabaseRpc("school_identity_session_revoke", {
      p_session_id: session.sessionId,
      p_session_secret: session.sessionSecret,
      p_reason: "ATTENDANCE_LOGOUT",
    });
  }
  if (req.method === "GET") {
    res.statusCode = 302;
    res.setHeader("Location", ATTENDANCE_POST_LOGOUT_URI);
    Object.entries(noStore()).forEach(([key, value]) => res.setHeader(key, value));
    res.setHeader("Set-Cookie", clearAuthCookies());
    return res.end();
  }
  return sendJson(res, { ok: true, code: "ATTENDANCE_SESSION_REVOKED", redirect_uri: ATTENDANCE_POST_LOGOUT_URI }, 200, clearAuthCookies());
};
