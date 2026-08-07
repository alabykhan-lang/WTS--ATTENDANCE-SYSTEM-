"use strict";

import {
  authCookies,
  clearAuthCookies,
  readBody,
  sameOrigin,
  safeCode,
  sendJson,
  supabaseRpc,
} from "../lib/attendance-api.js";

function field(value, maxLength = 512) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function statusFor(code, fallback = 401) {
  if (["ATTENDANCE_SESSION_SERVICE_UNAVAILABLE", "CENTRAL_SESSION_SERVICE_UNAVAILABLE", "ATTENDANCE_SERVICE_UNAVAILABLE"].includes(code)) return 503;
  if (["ACCOUNT_NOT_ACTIVE", "ATTENDANCE_ACCESS_NOT_GRANTED", "PORTAL_ACCESS_NOT_GRANTED", "PORTAL_PERMISSION_SYNC_FAILED"].includes(code)) return 403;
  return fallback;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(req)) return sendJson(res, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);

  const body = await readBody(req);
  if (!body || typeof body !== "object") return sendJson(res, { ok: false, code: "INVALID_REQUEST" }, 400);

  if (body.action === "change_password") {
    const login = field(body.login);
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (!login || !currentPassword || !newPassword || newPassword.length > 512) {
      return sendJson(res, { ok: false, code: "PASSWORD_CHANGE_INPUT_REQUIRED" }, 400, clearAuthCookies());
    }
    const changed = await supabaseRpc("school_identity_change_password", {
      p_login: login,
      p_current_password: currentPassword,
      p_new_password: newPassword,
    });
    if (!changed?.ok) {
      const code = safeCode(changed, "PASSWORD_CHANGE_FAILED");
      return sendJson(res, { ok: false, code }, statusFor(code, 400), clearAuthCookies());
    }
    return sendJson(res, { ok: true, code: changed.code || "PASSWORD_CHANGED" }, 200, clearAuthCookies());
  }

  const login = field(body.login);
  const password = typeof body.password === "string" ? body.password : "";
  if (!login || !password || password.length > 512) {
    return sendJson(res, { ok: false, code: "LOGIN_AND_PASSWORD_REQUIRED" }, 400, clearAuthCookies());
  }

  const authentication = await supabaseRpc("school_identity_portal_login", {
    p_login: login,
    p_password: password,
    p_app_code: "attendance",
  });
  if (!authentication?.ok) {
    const code = safeCode(authentication, "INVALID_LOGIN");
    return sendJson(res, { ok: false, code }, statusFor(code), clearAuthCookies());
  }
  if (authentication.must_change_password) {
    return sendJson(res, {
      ok: true,
      code: authentication.code || "PASSWORD_CHANGE_REQUIRED",
      must_change_password: true,
    }, 200, clearAuthCookies());
  }
  if (!authentication.client_code || !authentication.client_secret) {
    return sendJson(res, { ok: false, code: "ATTENDANCE_SESSION_SERVICE_UNAVAILABLE" }, 503, clearAuthCookies());
  }

  const issued = await supabaseRpc("school_identity_session_issue_api", {
    p_client_code: authentication.client_code,
    p_client_secret: authentication.client_secret,
    p_originating_app_code: "attendance",
    p_target_app_code: "attendance",
  });
  if (!issued?.ok || !issued.session_id || !issued.session_secret) {
    const code = safeCode(issued, "ATTENDANCE_SESSION_SERVICE_UNAVAILABLE");
    return sendJson(res, { ok: false, code }, statusFor(code, 503), clearAuthCookies());
  }

  return sendJson(res, {
    ok: true,
    code: "ATTENDANCE_SESSION_CREATED",
    expires_at: issued.expires_at,
    person_id: issued.person_id,
    identity_account_id: issued.identity_account_id,
    access_role: issued.access_role,
    permissions: issued.permissions || authentication.permissions || [],
    institutional_authority: issued.institutional_authority || authentication.institutional_authority || null,
  }, 200, authCookies(issued.session_id, issued.session_secret, authentication.client_code, authentication.client_secret));
}
