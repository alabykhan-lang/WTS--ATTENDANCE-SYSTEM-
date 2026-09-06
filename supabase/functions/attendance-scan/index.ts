import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const EVENTS = new Set(["check_in", "check_out"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_ORIGINS = new Set([
  "https://wts-attendance-system.vercel.app",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:8000",
  "http://localhost:8080",
]);
const PREVIEW = /^https:\/\/wts-attendance-system(?:-[a-z0-9-]+)?-alabykhan-6803s-projects\.vercel\.app$/;

function originFor(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return "";
  return FIXED_ORIGINS.has(origin) || PREVIEW.test(origin) ? origin : null;
}

function headers(request: Request): Record<string, string> {
  const origin = originFor(request);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "content-type,x-wts-installation-id,x-wts-installation-token",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function reply(request: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers(request), "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

function cleanNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    if (originFor(request) === null) return reply(request, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
    return new Response(null, { status: 204, headers: headers(request) });
  }
  if (request.method !== "POST") return reply(request, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (originFor(request) === null) return reply(request, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 32_768) return reply(request, { ok: false, code: "REQUEST_TOO_LARGE" }, 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply(request, { ok: false, code: "INVALID_JSON" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(request, { ok: false, code: "SERVER_CONFIGURATION_ERROR" }, 500);
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body.action === "register") {
    const scannerPassword = cleanText(body.scannerPassword, 256);
    const browserInstallationId = cleanText(body.browserInstallationId, 160);
    const deviceName = cleanText(body.deviceName, 100) || "QR scanner";
    if (!scannerPassword || !browserInstallationId) return reply(request, { ok: false, code: "SCANNER_REGISTRATION_REQUIRED" }, 400);
    const { data, error } = await db.rpc("attendance_scanner_register_api", {
      p_password: scannerPassword,
      p_installation_id: browserInstallationId,
      p_device_name: deviceName,
    });
    if (error) return reply(request, { ok: false, code: "SCANNER_REGISTRATION_FAILED" }, 500);
    return reply(request, data, data?.ok === true ? 200 : 401);
  }

  const installationId = cleanText(request.headers.get("x-wts-installation-id"), 36);
  const installationToken = cleanText(request.headers.get("x-wts-installation-token"), 128);
  if (!installationId || !UUID_RE.test(installationId) || !installationToken) {
    return reply(request, { ok: false, code: "SCANNER_REGISTRATION_REQUIRED" }, 401);
  }

  const latitude = cleanNumber(body.latitude);
  const longitude = cleanNumber(body.longitude);
  const accuracy = cleanNumber(body.locationAccuracyMetres);
  if ((latitude === null) !== (longitude === null) || (latitude !== null && (latitude < -90 || latitude > 90 || longitude! < -180 || longitude! > 180))) {
    return reply(request, { ok: false, code: "INVALID_LOCATION" }, 400);
  }

  const source = body.offlineSync === true ? "offline_sync" : "qr";
  const { data: validation, error: validationError } = await db.rpc("attendance_scanner_validate_api", {
    p_installation_id: installationId,
    p_token: installationToken,
    p_latitude: latitude,
    p_longitude: longitude,
    p_accuracy: accuracy,
    p_is_sync: source === "offline_sync",
  });
  if (validationError) return reply(request, { ok: false, code: "SCANNER_VALIDATION_FAILED" }, 500);
  if (validation?.ok !== true) return reply(request, validation || { ok: false, code: "SCANNER_REGISTRATION_INVALID" }, 401);

  if (source === "offline_sync") {
    const adminPassword = cleanText(body.adminPassword, 256);
    if (!adminPassword) return reply(request, { ok: false, code: "ADMIN_PASSWORD_REQUIRED" }, 401);
    const { data: allowed, error } = await db.rpc("attendance_admin_password_valid", { p_password: adminPassword });
    if (error) return reply(request, { ok: false, code: "ADMIN_PASSWORD_CHECK_FAILED" }, 500);
    if (allowed !== true) return reply(request, { ok: false, code: "ADMIN_PASSWORD_INVALID" }, 401);
  }

  const credential = cleanText(body.credential, 512);
  const clientEventId = cleanText(body.clientEventId, 36);
  const eventType = cleanText(body.eventType, 20);
  const recordedAt = cleanText(body.recordedAt, 40);
  const reason = cleanText(body.reason, 500);
  if (!credential || credential.length < 8) return reply(request, { ok: false, code: "INVALID_CREDENTIAL" }, 400);
  if (!clientEventId || !UUID_RE.test(clientEventId)) return reply(request, { ok: false, code: "INVALID_CLIENT_EVENT_ID" }, 400);
  if (!eventType || !EVENTS.has(eventType)) return reply(request, { ok: false, code: "INVALID_EVENT_TYPE" }, 400);
  if (source === "offline_sync" && !recordedAt) return reply(request, { ok: false, code: "ORIGINAL_TIME_REQUIRED" }, 400);

  const { data, error } = await db.rpc("attendance_strict_intake", {
    p_token_hash: await sha256(credential),
    p_installation_id: installationId,
    p_client_event_id: clientEventId,
    p_event_type: eventType,
    p_source: source,
    p_event_time: source === "offline_sync" ? recordedAt : null,
    p_note: reason,
    p_metadata: {
      strictQr: true,
      locationCapturedAt: cleanText(body.locationCapturedAt, 40),
      latitude,
      longitude,
      locationAccuracyMetres: accuracy,
    },
  });
  if (error) return reply(request, { ok: false, code: "ATTENDANCE_SERVICE_FAILED" }, 500);
  return reply(request, data, data?.ok === true ? 200 : 422);
});
