# WTS Attendance System architecture

## Scope

Attendance is an operational module of WTS. Central Registry remains authoritative for people, pupil/staff identity, admission and staff numbers, active state, class placement, teacher allocation, official session/term and the Attendance module grant.

Attendance owns QR credentials, authorized capture devices, raw events, imports, interpretation, exceptions, reports, audit and printable QR output for the back of the school ID card. It does not create a second pupil or staff identity. The official session, term, people, classes and staff allocations remain Central Registry responsibilities.

## Intake model

The operator product is QR-first. Camera scans, connected QR readers, standalone network QR terminals and imported scanner files converge on `attendance_universal_intake`. A raw event is retained separately from the official interpretation. The QR image itself has no clock or storage: the scanner/device records the scan timestamp, and the import preserves that original timestamp. Server receipt/upload time is audit metadata only. Historical source vocabularies remain in the database for data preservation and adapter compatibility, but they are not offered as current operator methods.

The production database now includes:

- `attendance_credential_index`: one-way hashed, device-independent credential lookup linked to a real pupil or staff profile;
- `attendance_raw_events`: immutable-source event envelope with idempotency and processing state;
- `attendance_import_batches` and `attendance_import_rows`: previewable, checksum-protected import staging;
- `attendance_student_session_records` and `attendance_staff_session_records`: official morning/afternoon interpretations;
- `attendance_register_locks`: confirmation, closure, reopening and archive state;
- `attendance_register_correction_requests`: approval trail for AM/PM corrections;
- `attendance_outbox_events`: Notification-ready event hooks without provider delivery logic.

The protected `attendance_notebook_read_api` supplies the Dashboard’s date-and-session snapshot. It separates morning arrival from afternoon closing, reports signed-in/late/not-yet-scanned counts, class confirmation state, staff counts and recent activity without creating attendance facts.

## Access boundary

The browser currently holds only the short-lived Attendance admin client session returned by the existing central identity flow. New read/write APIs validate the client secret, session expiry, effective Attendance permissions and, for class operations, the live class allocation. The final dedicated Attendance PKCE callback and host-only HttpOnly cookie transport remain a coordinated Central Registry/Workspace dependency; Attendance does not create a second password system. Raw credential values, device secrets and biometric templates are never returned by read APIs.

The live scanner uses a device code and one-way device-secret hash at the Edge Function boundary. Devices never receive a Supabase service key.

## Cross-system sign-in status

The connected Unify/Workspace portal exposes the Attendance module link and uses the central authorization route. Attendance waits for the authorization callback exchange before unlocking its application shell, preventing the previous login-page/portal redirect loop. The Attendance session remains host-only and short-lived, while central logout and grant revocation remain authoritative.

## Credential and ID-card operation

The central office searches existing Central Registry students or staff and works person by person. A secure QR pass can be issued, re-shown for authorized reprinting and printed class-by-class or for all staff on a back-cover sheet. Lost or used QR credentials are revoked/replaced through the controlled lifecycle. Raw QR tokens are displayed only through the issuance/print workflow; stored credentials remain one-way protected.

## Capture and synchronisation

The existing secure scanner is the dedicated QR capture application. It can use its camera or accept input from a connected QR reader. A future standalone Wi-Fi/mobile QR terminal can post directly to the device intake contract. Confirmed events can arrive in real time, remain in the scanner's encrypted offline queue for automatic retry, or be transferred from other equipment and imported as CSV, XLSX or delimited text. Every import is previewed, checksum-protected and held for identity resolution before confirmation.

The notebook’s Take Attendance area includes a controlled manual AM/PM class register for cases where scanning is unavailable. A blank row is incomplete and prevents confirmation; confirmed registers are locked. Staff attendance is recorded through the same QR intake or controlled staff workflow, then shown in the daily logbook. Absence/not-yet-scanned state is derived from the expected Central Registry roster and confirmed attendance events. Unusual cases use the controlled correction workflow so original events and the review trail remain auditable.

## Notebook screen contract

The operator workspace has five primary areas:

1. **Dashboard** — date, morning/afternoon switch, student and staff counters, unconfirmed classes, capture health and recent events.
2. **Take Attendance** — the focused QR scanner link, morning/afternoon mode, manual class register, save/confirm/lock controls and scan feedback.
3. **Analysis** — student and class reports, period breakdowns, staff history and a printable staff arrival/closing logbook.
4. **Setup** — official Central Registry context, roster status, authorized QR devices, offline import centre and correction access.
5. **QR Codes Generation** — individual, class and staff QR output with revocation/replacement history.

The scanner page is intentionally a separate, phone-friendly operational surface. It does not require staff to navigate the management workspace during gate operation.
