# WTS Attendance System architecture

## Scope

Attendance is an operational module of WTS. Central Registry remains authoritative for people, pupil/staff identity, admission and staff numbers, active state, class placement, teacher allocation, official session/term and the Attendance module grant.

Attendance owns QR/NFC credentials, devices, raw events, imports, interpretation, exceptions, reports, audit and printable ID cards. It does not create a second pupil or staff identity.

## Intake model

The operator product accepts two attendance credentials: secure QR passes and NFC cards. Camera scans, phone NFC, USB NFC reader values, live events and imported device files converge on `attendance_universal_intake`. A raw event is retained separately from the official interpretation. Historical source vocabularies remain in the database for audit compatibility, but they are not offered as current operator methods. The event timestamp supplied by a device is preserved; receipt time is audit metadata only.

The production database now includes:

- `attendance_credential_index`: one-way hashed, device-independent credential lookup linked to a real pupil or staff profile;
- `attendance_raw_events`: immutable-source event envelope with idempotency and processing state;
- `attendance_import_batches` and `attendance_import_rows`: previewable, checksum-protected import staging;
- `attendance_student_session_records` and `attendance_staff_session_records`: official morning/afternoon interpretations;
- `attendance_register_locks`: confirmation, closure, reopening and archive state;
- `attendance_register_correction_requests`: approval trail for AM/PM corrections;
- `attendance_outbox_events`: Notification-ready event hooks without provider delivery logic.

## Access boundary

The browser currently holds only the short-lived Attendance admin client session returned by the existing central identity flow. New read/write APIs validate the client secret, session expiry, effective Attendance permissions and, for class operations, the live class allocation. The final dedicated Attendance PKCE callback and host-only HttpOnly cookie transport remain a coordinated Central Registry/Workspace dependency; Attendance does not create a second password system. Raw credential values, device secrets and biometric templates are never returned by read APIs.

The live scanner uses a device code and one-way device-secret hash at the Edge Function boundary. Devices never receive a Supabase service key.

## Cross-system sign-in status

The connected Unify/Workspace portal exposes the Attendance module link and uses the central authorization route. Attendance waits for the authorization callback exchange before unlocking its application shell, preventing the previous login-page/portal redirect loop. The Attendance session remains host-only and short-lived, while central logout and grant revocation remain authoritative.

## Credential and ID-card operation

The central office searches existing Central Registry students or staff and works person by person. A secure QR pass can be issued and immediately printed on the WTS ID-card layout. A physical NFC card is linked one at a time by tapping or reading its UID, which reduces card-to-person assignment mistakes. Raw QR tokens are displayed only for the issuance/print moment; stored credentials remain one-way protected.

## Capture and synchronisation

The existing secure scanner is the dedicated capture application for both methods. QR uses its camera; NFC uses phone Web NFC or a school-owned USB NFC reader through the credential input. Confirmed events can arrive in real time, remain in the scanner's encrypted offline queue for automatic retry, or be transferred from other equipment by USB, Bluetooth or Wi-Fi and imported as CSV, XLSX or delimited text. Every import is previewed, checksum-protected and held for identity resolution before confirmation.

Manual attendance has been removed from the operator workspace. Absence is derived from the expected Central Registry roster and confirmed attendance events. Unusual cases use the controlled Exceptions workflow so original events and the review trail remain auditable.
