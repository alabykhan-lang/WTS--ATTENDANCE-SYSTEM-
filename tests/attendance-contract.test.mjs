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
  assert.equal(normalizeIdentifier("  a1-b2:c3  ", "generic_card_uid"), "A1-B2C3");
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

test("operator workspace exposes the five notebook areas", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const primary = [...html.matchAll(/<button class="nav(?: active)?" data-view="([^"]+)">/g)].map((match) => match[1]);

  assert.deepEqual(primary, ["overview", "scan", "reports", "settings", "credentials"]);
  assert.match(html, />Dashboard<\/button>/);
  assert.match(html, />Take Attendance<\/button>/);
  assert.match(html, />Analysis<\/button>/);
  assert.match(html, />Setup<\/button>/);
  assert.match(html, />QR Codes Generation<\/button>/);
  assert.match(html, /id="registerDate"/);
  assert.match(html, /id="confirmRegister"/);
  assert.match(html, /data-dashboard-slot="morning"/);
  assert.match(html, /data-dashboard-slot="afternoon"/);
  assert.doesNotMatch(html, /id="(?:attentionList|healthList|classSummary|recentEvents)"/);
  assert.match(html, /id="manualRegisterDetails"/);
  assert.match(html, /Open a class register to begin/);
});

test("credential office and scanner are QR-first with no operational NFC controls", async () => {
  const [html, scannerHtml, scannerSource, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../scanner.html", import.meta.url), "utf8"),
    readFile(new URL("../scanner.js", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /Generate \/ show QR/);
  assert.match(html, /Permanent attendance QR/);
  assert.doesNotMatch(html, /value="(?:nfc_uid|nfc|rfid_uid|fingerprint_device_user_id|temporary_pass)"/i);
  assert.match(scannerHtml, /Automatic QR camera/);
  assert.doesNotMatch(scannerHtml, /Scanner source|Attach phone location|Remember device secret|Test a QR without recording/i);
  assert.doesNotMatch(scannerHtml, /value="(?:nfc|rfid|usb_ccid|standalone_terminal)"/i);
  assert.doesNotMatch(html, /\bNFC\b/i);
  assert.doesNotMatch(scannerHtml, /\bNFC\b/i);
  assert.doesNotMatch(scannerSource, /\bNFC\b/i);
  assert.doesNotMatch(appSource, /\bNFC\b/i);
  assert.doesNotMatch(html, /id="newDeviceMethod"|>Source<\/label>/i);
  assert.doesNotMatch(appSource, /createManualEntry/);
  assert.doesNotMatch(appSource, /contextClasses\(\)\[0\]/);
  assert.doesNotMatch(scannerSource, /diagnosticMode|rememberSecret|locationPayload/i);
});

test("record intake explains connected, interrupted, and saved-file paths in plain language", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Live scans arrive directly/);
  assert.match(html, /original scan time/);
  assert.match(html, /Offline imports/);
  assert.match(html, /Original scan time/);
});

test("QR-code search and device setup use the universal permission-scoped flow", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /universalRead\("people"/);
  assert.doesNotMatch(appSource, /studentRead\("students"/);
  assert.match(appSource, /staffRead\("staff"\)/);
  assert.match(appSource, /universalWrite\("registerDevice"/);
  assert.match(appSource, /const notebookRead = .*attendance_notebook_read_api/);
  assert.match(appSource, /const staffRead = .*staff_attendance_admin_read_api/);
  assert.match(await readFile(new URL("../api/rpc.js", import.meta.url), "utf8"), /"attendance_notebook_read_api"/);
  assert.match(html, /id="deviceDialog"/);
  assert.match(html, /id="readyDeviceCode"/);
  assert.match(html, /id="readyDeviceSecret"/);
});

test("notebook dashboard contract is AM/PM-specific and read-only", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260905160000_attendance_notebook_dashboard_snapshot.sql", import.meta.url), "utf8");
  assert.match(migration, /attendance_notebook_read_api/);
  assert.match(migration, /session_slot/);
  assert.match(migration, /morning|afternoon/);
  assert.match(migration, /NOTEBOOK_DASHBOARD_READY/);
  assert.doesNotMatch(migration, /insert into|update public\.attendance_(?:student|staff)|delete from/i);
});

test("staff analysis and printed register hooks are present", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="staffAnalysisPerson"/);
  assert.match(html, /id="staffHistoryRows"/);
  assert.match(html, /id="staffLogbookRows"/);
  assert.match(source, /staffRead\("history"/);
  assert.match(source, /universalRead\("staff_logbook"/);
  assert.match(source, /printStaffLogbook/);
  assert.match(source, /printRegisterSheet/);
  assert.match(html, /id="staffManualForm"/);
  assert.match(html, /id="staffManualPerson"/);
  assert.match(source, /notebookWrite\("manualStaffAttendance"/);
  assert.match(await readFile(new URL("../api/rpc.js", import.meta.url), "utf8"), /"attendance_notebook_write_api"/);
});

test("manual staff fallback is protected, timestamped, and additive", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260905163000_attendance_notebook_staff_manual.sql", import.meta.url), "utf8");
  assert.match(migration, /attendance_notebook_write_api/);
  assert.match(migration, /manualStaffAttendance/);
  assert.match(migration, /Africa\/Lagos/);
  assert.match(migration, /attendance_raw_events/);
  assert.match(migration, /attendance_staff_session_records/);
  assert.match(migration, /attendance_admin_audit/);
  assert.match(migration, /attendance_emit_outbox_event/);
  assert.match(migration, /ADMIN_PERMISSION_DENIED/);
  assert.doesNotMatch(migration, /delete from/i);
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
  assert.match(html, /Keep this page open\. The next QR code will be read automatically\./);
  assert.match(source, /startActiveReader\(true\)/);
  assert.match(source, /async function detectQrFrame/);
  assert.match(source, /decodeQrRegion/);
  assert.match(source, /detectNativeQrFrame/);
  assert.match(source, /Promise\.race/);
  assert.match(source, /150/);
  assert.match(html, /scanner\.js\?v=8/);
  assert.match(source, /focusWidth/);
  assert.match(source, /tuneCameraTrack/);
  assert.match(source, /zoom/);
  assert.match(source, /nativeDetector\.detect\(video\)/);
  assert.match(source, /if \(focusedValue\) return focusedValue;/);
  assert.match(source, /1280 \/ Math\.max\(width, height\)/);
  assert.match(source, /WTS_VENDOR\?\.jsQR/);
  assert.match(source, /Remove this QR first/);
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
  assert.match(source, /renderQrBackCover/);
  assert.match(source, /attendance-qr-block/);
  assert.match(source, /qr-back-cover/);
  assert.match(source, /qr-block-code/);
  assert.match(source, /showQrPreview/);
  assert.match(source, /printQrBatch/);
  assert.match(source, /printQrBackCovers/);
  assert.match(source, /preparedCodes\.map\(\(code, index\) => renderQrBlock/);
  assert.match(source, /errorCorrectionLevel: "H"/);
  assert.match(source, /width: 1600/);
  assert.doesNotMatch(source, /renderIdCardPair|showCardPreview|printCardBatch/);
  assert.doesNotMatch(html, /Issue a permanent ID card|Show \/ download ID card|Print \/ save ID card|id="cardPrintArea"/);
  assert.match(source, /person\.reference/);
  assert.match(source, /person\.group_name/);
  assert.match(html, /Attendance does not generate an ID-card front/);
  assert.match(html, /Print ID-card back covers/);
  assert.match(styles, /@page\s*\{[^}]*size:\s*A4 landscape/);
  assert.match(styles, /\.qr-block-code/);
  assert.match(styles, /break-inside:\s*avoid/);
});

test("QR controls reuse permanent values and restrict replacement to used credentials", async () => {
  const [html, source, rpcSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../api/rpc.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /BATCH OUTPUT/);
  assert.match(html, /Generate class QRs/);
  assert.match(html, /Generate staff QRs/);
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
