import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SOURCES = new Set([
  "qr",
  "nfc",
  "mifare",
  "rfid",
  "card",
  "fingerprint",
  "face",
  "pin",
  "usb_hid",
  "usb_ccid",
  "standalone_terminal",
  "offline_sync",
]);
const EVENTS = new Set(["check_in", "check_out"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_ORIGINS = new Set([
  "https://wts-attendance-system.vercel.app",
  "https://wts-result-system.vercel.app",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:8000",
  "http://localhost:8080",
]);
const ATTENDANCE_PREVIEW =
  /^https:\/\/wts-attendance-system(?:-[a-z0-9-]+)?-alabykhan-6803s-projects\.vercel\.app$/;

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return "";
  return FIXED_ORIGINS.has(origin) || ATTENDANCE_PREVIEW.test(origin)
    ? origin
    : null;
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = allowedOrigin(request);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers":
      "content-type, x-wts-device-code, x-wts-device-secret, x-wts-installation-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function secureEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    if (allowedOrigin(request) === null)
      return reply(request, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST")
    return reply(request, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (allowedOrigin(request) === null)
    return reply(request, { ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 8192)
    return reply(request, { ok: false, code: "REQUEST_TOO_LARGE" }, 413);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey)
    return reply(
      request,
      { ok: false, code: "SERVER_CONFIGURATION_ERROR" },
      500,
    );

  const deviceCode = clean(request.headers.get("x-wts-device-code"), 80);
  const deviceSecret = clean(request.headers.get("x-wts-device-secret"), 256);
  const installationId = clean(
    request.headers.get("x-wts-installation-id"),
    160,
  );
  if (!deviceCode || !deviceSecret)
    return reply(request, { ok: false, code: "DEVICE_AUTH_REQUIRED" }, 401);

  let body: Record<string, unknown>;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 8192)
      return reply(request, { ok: false, code: "REQUEST_TOO_LARGE" }, 413);
    const parsedBody: unknown = JSON.parse(rawBody);
    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    )
      return reply(request, { ok: false, code: "INVALID_JSON" }, 400);
    body = parsedBody as Record<string, unknown>;
  } catch {
    return reply(request, { ok: false, code: "INVALID_JSON" }, 400);
  }

  const credential = clean(body.credential, 512);
  const eventId = clean(body.clientEventId, 36);
  const eventType = clean(body.eventType, 20);
  const source = clean(body.source, 32);
  const localRecordedAt = clean(body.localRecordedAt, 40);
  const locationCapturedAt = clean(body.locationCapturedAt, 40);
  const latitude = numberOrNull(body.latitude);
  const longitude = numberOrNull(body.longitude);
  const accuracy = numberOrNull(body.locationAccuracyMetres);
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  if (body.diagnostic === true)
    return reply(
      request,
      { ok: false, code: "SCAN_MODE_UNSUPPORTED" },
      422,
    );

  if (
    !credential ||
    credential.length > 512 ||
    (source === "qr" && credential.length < 8)
  )
    return reply(request, { ok: false, code: "INVALID_CREDENTIAL" }, 400);
  if (!eventId || !UUID_RE.test(eventId))
    return reply(request, { ok: false, code: "INVALID_CLIENT_EVENT_ID" }, 400);
  if (!eventType || !EVENTS.has(eventType))
    return reply(request, { ok: false, code: "INVALID_EVENT_TYPE" }, 400);
  if (!source || !SOURCES.has(source))
    return reply(request, { ok: false, code: "INVALID_SOURCE" }, 400);
  if ((latitude === null) !== (longitude === null))
    return reply(request, { ok: false, code: "INCOMPLETE_LOCATION" }, 400);
  if (
    latitude !== null &&
    (latitude < -90 ||
      latitude > 90 ||
      longitude === null ||
      longitude < -180 ||
      longitude > 180)
  ) {
    return reply(request, { ok: false, code: "INVALID_LOCATION" }, 400);
  }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: device, error: deviceError } = await db
    .from("attendance_devices")
    .select(
      "id,status,secret_hash,supported_sources,offline_enabled,deployment_mode,scan_enabled",
    )
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (deviceError)
    return reply(request, { ok: false, code: "DEVICE_LOOKUP_FAILED" }, 500);
  if (
    !device ||
    device.status !== "active" ||
    device.scan_enabled !== true ||
    typeof device.secret_hash !== "string"
  ) {
    return reply(request, { ok: false, code: "DEVICE_AUTH_FAILED" }, 401);
  }
  if (!secureEqual(await sha256(deviceSecret), device.secret_hash)) {
    return reply(request, { ok: false, code: "DEVICE_AUTH_FAILED" }, 401);
  }
  if (
    source !== "offline_sync" &&
    (!Array.isArray(device.supported_sources) ||
      !device.supported_sources.includes(source))
  ) {
    return reply(
      request,
      { ok: false, code: "SOURCE_NOT_SUPPORTED_BY_DEVICE" },
      422,
    );
  }
  if (source === "offline_sync" && device.offline_enabled !== true) {
    return reply(request, { ok: false, code: "OFFLINE_SYNC_NOT_ENABLED" }, 422);
  }
  if (!installationId && device.deployment_mode !== "development") {
    return reply(request, { ok: false, code: "INSTALLATION_ID_REQUIRED" }, 401);
  }

  if (installationId) {
    const { data: binding, error: bindingError } = await db.rpc(
      "bind_or_validate_scanner_installation",
      {
        p_device_id: device.id,
        p_installation_hash: await sha256(installationId),
      },
    );
    if (bindingError)
      return reply(
        request,
        { ok: false, code: "INSTALLATION_VALIDATION_FAILED" },
        500,
      );
    if (binding?.ok !== true) return reply(request, binding, 401);
  }

  const tokenHash = await sha256(credential);
  // Browser scanners cannot provide trustworthy native-device attestation. Devices
  // with integrity_required must use a future attested native scanner instead.
  const { data, error } = await db.rpc("attendance_universal_intake", {
    p_token_hash: tokenHash,
    p_device_id: device.id,
    p_client_event_id: eventId,
    p_event_type: eventType,
    p_source: source,
    p_event_time: source === "offline_sync" ? localRecordedAt : null,
    p_local_recorded_at: localRecordedAt,
    p_source_event_id: eventId,
    p_note: note,
    p_metadata: {
      credential_method: source,
      source_time_zone: "Africa/Lagos",
      latitude,
      longitude,
      location_accuracy_metres: accuracy,
    },
  });
  if (error)
    return reply(
      request,
      {
        ok: false,
        code: "SCAN_PROCESSING_FAILED",
      },
      500,
    );

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    last_seen_at: now,
    health_status: "online",
    updated_at: now,
  };
  if (source === "offline_sync") update.last_sync_at = now;
  if (latitude !== null) {
    update.last_latitude = latitude;
    update.last_longitude = longitude;
    update.last_location_accuracy_metres = accuracy;
    update.last_location_at = locationCapturedAt || now;
  }
  await db.from("attendance_devices").update(update).eq("id", device.id);

  return reply(
    request,
    { ...data, api_version: "5.1" },
    data?.ok === true ? 200 : 422,
  );
});
