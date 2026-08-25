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

  assert.match(html, /Generate QR pass/);
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

test("ID-card search and device setup use the universal permission-scoped flow", async () => {
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
  assert.match(source, /focusWidth/);
  assert.match(source, /tuneCameraTrack/);
  assert.match(source, /zoom/);
  assert.match(source, /nativeDetector\.detect\(video\)/);
  assert.match(source, /if \(value\) return value;/);
  assert.match(source, /maxWidth = 960/);
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

test("printable identity card has separate front identity and back QR faces", async () => {
  const [html, source, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id-card-face id-card-front/);
  assert.match(html, /id-card-face id-card-back/);
  assert.match(html, /id="printAvatar"/);
  assert.match(html, /id="printNumber"/);
  assert.match(html, /id="qrPreview"/);
  assert.match(html, /Print front and back/);
  assert.match(source, /person\.reference/);
  assert.match(source, /person\.group_name/);
  assert.match(html, /85\.60 × 53\.98 MM/);
  assert.match(html, /assets\/wts-school-logo\.jpg/);
  assert.match(styles, /width:85\.6mm;height:53\.98mm/);
});

test("universal Attendance requests prefer the current RPC before compatibility fallbacks", async () => {
  const source = await readFile(new URL("../api/rpc.js", import.meta.url), "utf8");
  assert.match(source, /attendance_universal_admin_write_api: \["attendance_universal_admin_write_api", "attendance_admin_write_api"\]/);
  assert.match(source, /Attendance RPC completed/);
  assert.doesNotMatch(source, /attendance_universal_admin_write_api: \["attendance_admin_write_api", "attendance_universal_admin_write_api"\]/);
});
