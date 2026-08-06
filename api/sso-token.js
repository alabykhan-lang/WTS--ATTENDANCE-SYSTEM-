"use strict";

import {
  ATTENDANCE_CLIENT_ID,
  ATTENDANCE_REDIRECT_URI,
  authCookies,
  readBody,
  sameOrigin,
  safeCode,
  sendJson,
  supabaseRpc,
} from "../lib/attendance-api.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(req)) return sendJson(res, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
  const body = await readBody(req);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim() : "";
  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  if (!code || code.length > 512 || !verifier || verifier.length > 512 || !state || state.length > 512 || !nonce || nonce.length > 512) {
    return sendJson(res, { ok: false, code: "SSO_CALLBACK_INVALID" }, 400);
  }

  const exchanged = await supabaseRpc("school_sso_authorization_code_exchange", {
    p_code: code,
    p_client_id: ATTENDANCE_CLIENT_ID,
    p_redirect_uri: ATTENDANCE_REDIRECT_URI,
    p_code_verifier: verifier,
    p_state: state,
    p_nonce: nonce,
  });
  if (!exchanged?.ok) return sendJson(res, { ok: false, code: safeCode(exchanged, "ATTENDANCE_SSO_EXCHANGE_FAILED") }, 401);
  if (!exchanged.session_id || !exchanged.session_secret || !exchanged.attendance_client_code || !exchanged.attendance_client_secret) {
    return sendJson(res, { ok: false, code: "ATTENDANCE_SSO_EXCHANGE_FAILED" }, 503);
  }

  return sendJson(res, {
    ok: true,
    code: "ATTENDANCE_SESSION_CREATED",
    expires_at: exchanged.expires_at,
    person_id: exchanged.person_id,
    identity_account_id: exchanged.identity_account_id,
    access_role: exchanged.access_role,
    permissions: exchanged.permissions || [],
    institutional_authority: exchanged.institutional_authority || null,
  }, 200, authCookies(exchanged.session_id, exchanged.session_secret, exchanged.attendance_client_code, exchanged.attendance_client_secret));
};
