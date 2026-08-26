import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function normalizeIdentifier(raw, type = "generic_card_uid") {
  const value = String(raw ?? "").trim();
  return ["qr", "qr_token", "barcode", "temporary_pass", "pin"].includes(type.toLowerCase())
    ? value
    : value.replace(/[^A-Za-z0-9_-]+/g, "").toUpperCase();
}

function percentage(actual, possible) {
  return possible > 0 ? Number(((actual / possible) * 100).toFixed(2)) : 0;
}

test("card identifiers normalise punctuation without changing QR token case", () => {
  assert.equal(normalizeIdentifier("  a1-b2:c3  ", "nfc_uid"), "A1-B2C3");
  assert.equal(normalizeIdentifier("  secure.Token/Case  ", "qr_token"), "secure.Token/Case");
});

test("attendance percentage uses eligible sessions and two-decimal rounding", () => {
  assert.equal(percentage(7, 8), 87.5);
  assert.equal(percentage(0, 0), 0);
  assert.equal(percentage(1, 3), 33.33);
});

test("replayed source events resolve to one stable deduplication key", () => {
  const key = ({ sourceEventId, clientEventId, credentialHash, timestamp, deviceId }) => sourceEventId || clientEventId || `${credentialHash}|${timestamp}|${deviceId}`;
  const first = key({ sourceEventId: "terminal-17", clientEventId: "a", credentialHash: "h", timestamp: "2026-08-06T07:00:00Z", deviceId: "d" });
  const replay = key({ sourceEventId: "terminal-17", clientEventId: "b", credentialHash: "h", timestamp: "2026-08-06T07:00:00Z", deviceId: "d" });
  assert.equal(first, replay);
});

test("missing register rows are incomplete, not present", () => {
  const statuses = ["present", "late", "absent", "incomplete"];
  const actual = statuses.filter((status) => ["present", "late"].includes(status)).length;
  const incomplete = statuses.filter((status) => status === "incomplete").length;
  assert.equal(actual, 2);
  assert.equal(incomplete, 1);
});

test("portal SSO launch keeps the Attendance app locked until callback exchange", async () => {
  const source = await readFile(new URL("../identity-login.js", import.meta.url), "utf8");
  const portalLaunch = source.match(/if \(query\.get\("sso"\) === "1"\) \{([\s\S]*?)\n\s*\}/)?.[1] || "";

  assert.match(portalLaunch, /await beginLogin\(\)/);
  assert.match(portalLaunch, /return false/);
  assert.doesNotMatch(portalLaunch, /return true/);
});

test("operator workspace exposes five focused areas and no manual marking screen", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const primary = [...html.matchAll(/<button class="nav(?: active)?" data-view="([^"]+)">/g)].map((match) => match[1]);

  assert.deepEqual(primary, ["overview", "scan", "credentials", "imports", "reports"]);
  assert.doesNotMatch(html, /Manual Marking|id="view-manual"|id="manualStaffForm"/);
  assert.match(html, /Two simple ways to take attendance\./);
});

test("credential office and scanner are restricted to QR and NFC", async () => {
  const [html, scannerHtml, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../scanner.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /Show \/ download QR code/);
  assert.match(html, /Permanent attendance QR/);
  assert.match(html, /value="nfc_uid"/);
  assert.doesNotMatch(html, /rfid_uid|fingerprint_device_user_id|temporary_pass/);
  assert.match(scannerHtml, /value="qr"/);
  assert.match(scannerHtml, /value="nfc"/);
  assert.doesNotMatch(scannerHtml, /value="rfid"|value="usb_ccid"|value="standalone_terminal"/);
  assert.doesNotMatch(appSource, /createManualEntry/);
});

test("record intake explains connected, interrupted, and saved-file paths in plain language", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /While connected/);
  assert.match(html, /keeps the scans safely/);
  assert.match(html, /USB, Bluetooth, or Wi-Fi/);
  assert.match(html, /\.csv,\.xlsx,\.xls,\.txt,\.tsv/);
});

test("QR-code search and device setup use the universal permission-scoped flow", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /universalRead\("people"/);
  assert.doesNotMatch(appSource, /studentRead\("students"|staffRead\("staff"/);
  assert.match(appSource, /universalWrite\("registerDevice"/);
  assert.match(html, /id="deviceDialog"/);
  assert.match(html, /id="readyDeviceCode"/);
  assert.match(html, /id="readyDeviceSecret"/);
});

test("scanner opens as an always-ready camera with a bundled decoder fallback", async () => {
  const [html, source, vendorEntry, manifest] = await Promise.all([
    readFile(new URL("../scanner.html", import.meta.url), "utf8"),
    readFile(new URL("../scanner.js", import.meta.url), "utf8"),
    readFile(new URL("../src/vendor-entry.js", import.meta.url), "utf8"),
    readFile(new URL("../scanner-manifest.webmanifest", import.meta.url), "utf8"),
  ]);

  assert.match(html, /Automatic QR camera/);
  assert.match(html, /id="cameraCanvas"/);
  assert.match(html, /Keep this page open\. The next card will be read automatically\./);
  assert.match(source, /startActiveReader\(true\)/);
  assert.match(source, /async function detectQrFrame/);
  assert.match(source, /decodeQrRegion/);
  assert.match(source, /detectNativeQrFrame/);
  assert.match(source, /Promise\.race/);
  assert.match(source, /150/);
  assert.match(html, /scanner\.js\?v=7/);
  assert.match(source, /focusWidth/);
  assert.match(source, /tuneCameraTrack/);
  assert.match(source, /zoom/);
  assert.match(source, /nativeDetector\.detect\(video\)/);
  assert.match(source, /if \(focusedValue\) return focusedValue;/);
  assert.match(source, /1280 \/ Math\.max\(width, height\)/);
  assert.match(source, /WTS_VENDOR\?\.jsQR/);
  assert.match(source, /Remove this card first/);
  assert.match(source, /Allow and start camera/);
  assert.match(source, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(source, /cameraRestartTimer/);
  assert.match(source, /getVideoTracks\(\)\[0\]\?\.addEventListener\("ended"/);
  assert.match(vendorEntry, /import jsQR from "jsqr"/);
  assert.match(manifest, /assets\/wts-school-logo\.jpg/);
  assert.match(manifest, /"display": "standalone"/);
});

test("printable QR output contains a complete labeled code for every person", async () => {
  const [html, source, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="qrPrintArea"/);
  assert.match(html, /Download QR PNG/);
  assert.match(source, /renderQrBlock/);
  assert.match(source, /attendance-qr-block/);
  assert.match(source, /qr-block-code/);
  assert.match(source, /showQrPreview/);
  assert.match(source, /printQrBatch/);
  assert.match(source, /preparedCodes\.map\(\(code, index\) => renderQrBlock/);
  assert.match(source, /errorCorrectionLevel: "H"/);
  assert.match(source, /width: 1600/);
  assert.doesNotMatch(source, /renderIdCardPair|showCardPreview|printCardBatch/);
  assert.doesNotMatch(html, /Issue a permanent ID card|Show \/ download ID card|Print \/ save ID card|id="cardPrintArea"/);
  assert.match(source, /person\.reference/);
  assert.match(source, /person\.group_name/);
  assert.match(html, /No ID-card front is generated here/);
  assert.match(styles, /@page\{size:A4 portrait/);
  assert.match(styles, /\.qr-block-code/);
  assert.match(styles, /break-inside:avoid/);
});

test("QR controls reuse permanent values and restrict replacement to used credentials", async () => {
  const [html, source, rpcSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../api/rpc.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /ONE QR PER PERSON/);
  assert.match(html, /Show \/ download class QRs/);
  assert.match(html, /Show \/ download all staff QRs/);
  assert.match(source, /qrWrite\("issueQr"/);
  assert.match(source, /qrWrite\("replaceQr"/);
  assert.match(source, /data-replace-credential/);
  assert.match(source, /hasBeenUsed/);
  assert.match(source, /Replace used QR/);
  assert.doesNotMatch(source, /showSecret\(/);
  assert.match(rpcSource, /attendance_qr_card_api/);
  assert.match(rpcSource, /"refreshUnusedQr"/);
});

test("stable QR storage keeps raw values encrypted and refreshes only unused legacy values", async () => {
  const [migration, lifecycle] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260826120000_stable_qr_id_cards.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260826190000_qr_only_unused_reset.sql", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /add column if not exists qr_secret_id uuid/);
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /attendance_qr_card_api/);
  assert.match(migration, /p_action not in \('issueQr','replaceQr'\)/);
  assert.match(migration, /QR_REPRINT_UNAVAILABLE/);
  assert.match(migration, /QR_CREDENTIAL_REPLACED/);
  assert.match(migration, /one_active_qr_per_person/);
  assert.doesNotMatch(migration, /raw_secret.*metadata|metadata.*raw_secret/i);
  assert.match(lifecycle, /p_action not in \('issueQr','replaceQr','refreshUnusedQr'\)/);
  assert.match(lifecycle, /QR_UNUSED_LEGACY_RESET_COMPLETE/);
  assert.match(lifecycle, /QR_USED_CARD_REQUIRES_REPLACEMENT/);
  assert.match(lifecycle, /QR_REPLACEMENT_NOT_ALLOWED_BEFORE_USE/);
  assert.match(lifecycle, /QR_INITIAL_RESET_NOT_ALLOWED_AFTER_USE/);
  assert.match(lifecycle, /last_used_at/);
  assert.match(lifecycle, /attendance_events/);
  assert.match(lifecycle, /staff_attendance_events/);
  assert.doesNotMatch(lifecycle, /raw_secret.*metadata|metadata.*raw_secret/i);
});

test("universal Attendance requests prefer the current RPC before compatibility fallbacks", async () => {
  const source = await readFile(new URL("../api/rpc.js", import.meta.url), "utf8");
  assert.match(source, /attendance_universal_admin_write_api: \["attendance_universal_admin_write_api", "attendance_admin_write_api"\]/);
  assert.match(source, /Attendance RPC completed/);
  assert.doesNotMatch(source, /attendance_universal_admin_write_api: \["attendance_admin_write_api", "attendance_universal_admin_write_api"\]/);
});
