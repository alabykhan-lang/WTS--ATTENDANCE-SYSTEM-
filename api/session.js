"use strict";

import { attendanceCookie, clearAuthCookies, sendJson, validateCentralAttendanceSession } from "../lib/attendance-api.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  const result = await validateCentralAttendanceSession(req);
  const local = attendanceCookie(req);
  if (!result.ok || !local) return sendJson(res, { ok: false, code: result.ok ? "ATTENDANCE_SESSION_REQUIRED" : result.code }, 401, clearAuthCookies());
  return sendJson(res, {
    ok: true,
    code: "ATTENDANCE_SESSION_ACTIVE",
    expires_at: result.context.expires_at,
    person_id: result.context.person_id,
    identity_account_id: result.context.identity_account_id,
    access_role: result.context.access_role,
    permissions: result.context.permissions || [],
    institutional_authority: result.context.institutional_authority || null,
  });
};
