import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const file = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("portal SSO launch stays locked until callback exchange", async () => {
  const source = await file("../identity-login.js");
  const launch = source.match(/if \(query\.get\("sso"\) === "1"\) \{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.match(launch, /await beginLogin\(\)/);
  assert.match(launch, /return false/);
});

test("workspace exposes exactly the five specified areas", async () => {
  const html = await file("../index.html");
  const primary = [...html.matchAll(/<button class="nav(?: active)?" data-view="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(primary, ["overview", "scan", "reports", "settings", "credentials"]);
  for (const label of ["Dashboard", "Take Attendance", "Analysis", "Setup", "QR Codes Generation"]) assert.match(html, new RegExp(`>${label}<\\/button>`));
  assert.doesNotMatch(html, /manual attendance|manual class|manual staff|correction|confirm register|reopen register/i);
});

test("dashboard is a date, AM/PM switch, and two counts", async () => {
  const html = await file("../index.html");
  assert.match(html, /data-dashboard-slot="morning"[^>]*>AM</);
  assert.match(html, /data-dashboard-slot="afternoon"[^>]*>PM</);
  assert.match(html, /id="staffCount"/);
  assert.match(html, /id="studentCount"/);
  assert.doesNotMatch(html, /attentionList|recentEvents|healthList|classSummary/);
});

test("analysis uses only Day, Week, Month, and Term", async () => {
  const html = await file("../index.html");
  assert.match(html, /data-person-type="student"/);
  assert.match(html, /data-person-type="staff"/);
  assert.match(html, /data-analysis-mode="general"/);
  assert.match(html, /data-analysis-mode="individual"/);
  for (const period of ["day", "week", "month", "term"]) assert.match(html, new RegExp(`value="${period}"`));
  assert.doesNotMatch(html, />From<input|>To<input|reportFrom|reportTo/);
});

test("daily general books are ordered by arrival", async () => {
  const [source, migration] = await Promise.all([file("../app.js"), file("../supabase/migrations/20260906233134_strict_qr_attendance_architecture.sql")]);
  assert.match(source, /function sortByArrival/);
  assert.match(source, /if \(left\.arrival\) return -1/);
  assert.match(migration, /order by x\.attendance_date, x\.arrival nulls last, x\.name/);
  assert.match(migration, /order by d\.attendance_date, d\.first_check_in nulls last, s\.full_name/);
});

test("staff daily time book has the six specified columns", async () => {
  const source = await file("../app.js");
  assert.match(source, /\["S\/N", "Staff Name", "Morning Arrival", "Signature", "Afternoon Closing", "Signature"\]/);
  assert.match(source, /official_signature/);
  assert.doesNotMatch(source, /Staff number.*Position.*Arrival status.*Method/);
});

test("setup contains separate administrative and general scanner passwords", async () => {
  const [html, migration] = await Promise.all([file("../index.html"), file("../supabase/migrations/20260906233134_strict_qr_attendance_architecture.sql")]);
  assert.match(html, /Administrative password/);
  assert.match(html, /One general password registers any approved phone/);
  assert.match(html, /Registered phones/);
  assert.match(migration, /scanner_password_version=scanner_password_version\+1/);
  assert.match(migration, /update public\.attendance_scanner_installations set status='revoked'/);
});

test("every offline sync submits the administrative password", async () => {
  const [scanner, edge, app] = await Promise.all([file("../scanner.js"), file("../supabase/functions/attendance-scan/index.ts"), file("../app.js")]);
  assert.match(scanner, /offlineSync: true, adminPassword/);
  assert.match(edge, /ADMIN_PASSWORD_REQUIRED/);
  assert.match(edge, /attendance_admin_password_valid/);
  assert.match(app, /write\("importRows", \{ adminPassword/);
  assert.doesNotMatch(scanner, /if \(online.*syncQueue|automatically when/i);
});

test("scanner registration uses one password and a revocable installation token", async () => {
  const [html, source, edge] = await Promise.all([file("../scanner.html"), file("../scanner.js"), file("../supabase/functions/attendance-scan/index.ts")]);
  assert.match(html, /id="scannerPassword"/);
  assert.doesNotMatch(html, /device code|device secret|one-time secret/i);
  assert.match(source, /installationToken/);
  assert.match(edge, /attendance_scanner_register_api/);
  assert.match(edge, /x-wts-installation-token/);
});

test("scanner supports phone camera and connected QR readers", async () => {
  const [html, source, vendor] = await Promise.all([file("../scanner.html"), file("../scanner.js"), file("../src/vendor-entry.js")]);
  assert.match(html, /id="cameraVideo"/);
  assert.match(html, /connected QR reader/i);
  assert.match(source, /BarcodeDetector/);
  assert.match(source, /WTS_VENDOR\.jsQR/);
  assert.match(vendor, /import jsQR from "jsqr"/);
});

test("early checkout reason is required before 3:30 PM in UI and database", async () => {
  const [html, source, migration] = await Promise.all([file("../scanner.html"), file("../scanner.js"), file("../supabase/migrations/20260906233134_strict_qr_attendance_architecture.sql")]);
  assert.match(html, /Reason for early closing/);
  assert.match(source, /15 \* 60 \+ 30/);
  assert.match(migration, /closing_time time not null default time '15:30'/);
  assert.match(migration, /EARLY_CLOSING_REASON_REQUIRED/);
});

test("backend accepts QR and offline QR only", async () => {
  const [migration, edge, rpc] = await Promise.all([file("../supabase/migrations/20260906233134_strict_qr_attendance_architecture.sql"), file("../supabase/functions/attendance-scan/index.ts"), file("../api/rpc.js")]);
  assert.match(migration, /not in \('qr', 'offline_sync'\)/);
  assert.match(migration, /check \(source in \('qr','offline_sync'\)\)/);
  assert.match(migration, /drop function if exists public\.attendance_notebook_write_api/);
  assert.doesNotMatch(edge, /nfc|mifare|rfid|fingerprint|face|pin|barcode/i);
  assert.match(rpc, /attendance_strict_read_api/);
  assert.match(rpc, /attendance_strict_write_api/);
  assert.doesNotMatch(rpc, /attendance_universal_admin|attendance_notebook|staff_attendance_admin|attendance_controls_admin/);
});

test("backend enforces one scan per person, date, and AM/PM period", async () => {
  const migration = await file("../supabase/migrations/20260906233134_strict_qr_attendance_architecture.sql");
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /DUPLICATE_IGNORED/);
  assert.match(migration, /v_slot := case when p_event_type = 'check_in' then 'morning' else 'afternoon' end/);
});

test("offline records preserve the original scan timestamp and location", async () => {
  const [source, edge] = await Promise.all([file("../scanner.js"), file("../supabase/functions/attendance-scan/index.ts")]);
  assert.match(source, /recordedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(edge, /p_event_time: source === "offline_sync" \? recordedAt : null/);
  assert.match(edge, /locationAccuracyMetres/);
});

test("QR generation supports individual, class, all students, all staff and ID backs", async () => {
  const [html, source] = await Promise.all([file("../index.html"), file("../app.js")]);
  assert.match(html, /Class QRs/);
  assert.match(html, /All students/);
  assert.match(html, /All staff/);
  assert.match(html, /Individual QR/);
  assert.match(html, /ID-card backs/);
  assert.match(source, /qrWrite\("issueQr"/);
  assert.match(source, /errorCorrectionLevel: "H"/);
  assert.match(source, /width: 1600/);
});

test("manual staff migration has been removed", async () => {
  await assert.rejects(access(new URL("../supabase/migrations/20260905163000_attendance_notebook_staff_manual.sql", import.meta.url)));
});
