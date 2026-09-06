"use strict";

import {
  attendanceCookie,
  clearAuthCookies,
  readBody,
  sameOrigin,
  safeCode,
  sendJson,
  supabaseRpc,
  validateCentralAttendanceSession,
} from "../lib/attendance-api.js";

const OPERATOR_RPCS = new Set([
  "attendance_strict_read_api",
  "attendance_strict_write_api",
  "attendance_qr_card_api",
]);

export default async function handler(req, res) {
  const startedAt = Date.now();
  const requestId = req.headers?.["x-vercel-id"] || null;
  if (req.method !== "POST") return sendJson(res, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(req)) return sendJson(res, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
  const body = await readBody(req);
  const name = typeof body.name === "string" ? body.name : "";
  const action = typeof body.action === "string" ? body.action : "";
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const central = await validateCentralAttendanceSession(req);
  const local = attendanceCookie(req);
  if (!central.ok || !local) return sendJson(res, { ok: false, code: central.ok ? "ATTENDANCE_SESSION_REQUIRED" : central.code }, 401, clearAuthCookies());

  let result;
  if (OPERATOR_RPCS.has(name)) {
    if (!action || action.length > 120) return sendJson(res, { ok: false, code: "ATTENDANCE_ACTION_REQUIRED" }, 400);
    result = await supabaseRpc(name, { p_client_code: local.clientCode, p_client_secret: local.clientSecret, p_action: action, p_payload: payload });
  } else if (name === "attendance_roster_sync_status_api") {
    result = await supabaseRpc(name, { p_session_id: central.session.sessionId, p_session_secret: central.session.sessionSecret });
  } else if (name === "attendance_roster_sync_api") {
    result = await supabaseRpc(name, {
      p_session_id: central.session.sessionId,
      p_session_secret: central.session.sessionSecret,
      p_academic_session: typeof payload.academic_session === "string" ? payload.academic_session : null,
      p_academic_term: typeof payload.academic_term === "string" ? payload.academic_term : null,
      p_as_of_date: typeof payload.as_of_date === "string" ? payload.as_of_date : null,
    });
  } else if (name === "attendance_roster_sync_retry_api") {
    result = await supabaseRpc(name, {
      p_session_id: central.session.sessionId,
      p_session_secret: central.session.sessionSecret,
      p_run_id: typeof payload.run_id === "string" ? payload.run_id : null,
    });
  } else {
    return sendJson(res, { ok: false, code: "ATTENDANCE_RPC_NOT_ALLOWED" }, 403);
  }

  if (!result?.ok && ["RESULT_SESSION_NOT_ACTIVE", "RESULT_SESSION_REQUIRED", "CENTRAL_IDENTITY_NOT_ACTIVE", "PORTAL_ACCESS_NOT_GRANTED", "ATTENDANCE_SESSION_NOT_ACTIVE", "ADMIN_SESSION_EXPIRED"].includes(safeCode(result, ""))) {
    return sendJson(res, { ok: false, code: safeCode(result, "ATTENDANCE_SESSION_NOT_ACTIVE") }, 401, clearAuthCookies());
  }
  const status = result?.ok === false ? 400 : 200;
  console.log(JSON.stringify({
    level: status >= 400 ? "warning" : "info",
    message: "Attendance RPC completed",
    route: "/api/rpc",
    requestId,
    rpc: name,
    action,
    code: safeCode(result, status >= 400 ? "ATTENDANCE_REQUEST_FAILED" : "OK"),
    status,
    durationMs: Date.now() - startedAt,
  }));
  return sendJson(res, result, status);
};
