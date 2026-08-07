"use strict";

const SUPABASE_URL = process.env.WTS_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wuftzyeajmsxdrbwaawl.supabase.co";
const SUPABASE_KEY = process.env.WTS_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_7AKtP6jh9xg8CdrK8F53xA_q4yZskPJ";
const ATTENDANCE_CLIENT_ID = "attendance";
const ATTENDANCE_REDIRECT_URI = "https://wts-attendance-system.vercel.app/";
const ATTENDANCE_POST_LOGOUT_URI = "https://wts-school-platform.vercel.app/workspace";
const CENTRAL_COOKIE = "wts_attendance_central_session";
const ATTENDANCE_COOKIE = "wts_attendance_session";
const RPC_RETRY_DELAYS_MS = [0, 120, 300];

function noStore() {
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function sendJson(res, payload, status = 200, cookies = []) {
  res.statusCode = status;
  Object.entries({ ...noStore(), "Content-Type": "application/json; charset=utf-8" }).forEach(([key, value]) => res.setHeader(key, value));
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end(JSON.stringify(payload));
}

function readCookieHeader(req) {
  return typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
}

function getCookie(req, name) {
  const prefix = `${name}=`;
  for (const part of readCookieHeader(req).split(/;\s*/)) {
    if (!part.startsWith(prefix)) continue;
    try { return decodeURIComponent(part.slice(prefix.length)); } catch { return ""; }
  }
  return "";
}

function splitCredential(value) {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;
  const left = value.slice(0, separator);
  const right = value.slice(separator + 1);
  return left && right ? { code: left, secret: right } : null;
}

function centralCookie(req) {
  const parsed = splitCredential(getCookie(req, CENTRAL_COOKIE));
  return parsed ? { sessionId: parsed.code, sessionSecret: parsed.secret } : null;
}

function attendanceCookie(req) {
  const parsed = splitCredential(getCookie(req, ATTENDANCE_COOKIE));
  return parsed ? { clientCode: parsed.code, clientSecret: parsed.secret } : null;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function authCookies(sessionId, sessionSecret, clientCode, clientSecret) {
  return [
    cookie(CENTRAL_COOKIE, `${sessionId}.${sessionSecret}`, 60 * 60 * 8),
    cookie(ATTENDANCE_COOKIE, `${clientCode}.${clientSecret}`, 60 * 60 * 8),
  ];
}

function clearAuthCookies() {
  return [cookie(CENTRAL_COOKIE, "", 0), cookie(ATTENDANCE_COOKIE, "", 0)];
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 64 * 1024) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).origin === `https://${req.headers.host}`; } catch { return false; }
}

function safeCode(payload, fallback = "ATTENDANCE_SERVICE_UNAVAILABLE") {
  return payload && typeof payload.code === "string" && /^[A-Z0-9_]+$/.test(payload.code) ? payload.code : fallback;
}

function rpcCandidates(name) {
  const names = Array.isArray(name) ? name : [name];
  return [...new Set(names.filter((item) => typeof item === "string" && item))];
}

function waitForRetry(attempt) {
  const delay = RPC_RETRY_DELAYS_MS[attempt] ?? RPC_RETRY_DELAYS_MS.at(-1);
  return delay ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

async function supabaseRpc(name, body) {
  for (const rpcName of rpcCandidates(name)) {
    for (let attempt = 0; attempt < RPC_RETRY_DELAYS_MS.length; attempt += 1) {
      await waitForRetry(attempt);
      let response;
      try {
        response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          body: JSON.stringify(body),
          cache: "no-store",
        });
      } catch {
        if (attempt + 1 < RPC_RETRY_DELAYS_MS.length) continue;
        continue;
      }

      if (response.status === 404) {
        if (attempt + 1 < RPC_RETRY_DELAYS_MS.length) continue;
        break;
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object") return { ok: false, code: "ATTENDANCE_SERVICE_UNAVAILABLE" };
      return payload;
    }
  }
  return { ok: false, code: "ATTENDANCE_SERVICE_UNAVAILABLE" };
}

async function validateCentralAttendanceSession(req) {
  const session = centralCookie(req);
  if (!session) return { ok: false, code: "RESULT_SESSION_REQUIRED" };
  const context = await supabaseRpc("school_identity_session_context_api", {
    p_session_id: session.sessionId,
    p_session_secret: session.sessionSecret,
    p_target_app_code: ATTENDANCE_CLIENT_ID,
  });
  if (!context?.ok) return { ok: false, code: safeCode(context, "RESULT_SESSION_NOT_ACTIVE"), session };
  return { ok: true, session, context };
}

export {
  ATTENDANCE_CLIENT_ID,
  ATTENDANCE_REDIRECT_URI,
  ATTENDANCE_POST_LOGOUT_URI,
  noStore,
  sendJson,
  readBody,
  sameOrigin,
  safeCode,
  supabaseRpc,
  centralCookie,
  attendanceCookie,
  authCookies,
  clearAuthCookies,
  validateCentralAttendanceSession,
};
