# WTS Attendance System architecture

## Scope

Attendance is an operational module of WTS. Central Registry remains authoritative for people, pupil/staff identity, admission and staff numbers, active state, class placement, teacher allocation, official session/term and the Attendance module grant.

Attendance owns credentials, devices, raw events, imports, interpretation, AM/PM registers, staff logbook, corrections, reports, audit and printable records. It does not create a second pupil or staff identity.

## Intake model

Manual entry, QR, NFC/MIFARE/RFID, USB reader values, biometric terminal user IDs, live device events and imported files converge on `attendance_universal_intake`. A raw event is retained separately from the official register interpretation. The event timestamp supplied by a terminal is preserved; receipt time is audit metadata only.

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

## Current cross-repository dependency

The connected School Platform currently exposes the Attendance module link and reads the central Attendance grant, but its documented PKCE client contract is still Result Portal-specific. Attendance therefore preserves the existing central identity login path and supplies the protected read-only Workspace RPC contract. A coordinated School Platform/Central Registry change is still required to issue an Attendance PKCE authorization code and register the Attendance callback. No uncontrolled cross-repository change was made.

## Immediate operation without hardware

Manual student AM/PM marking, manual staff review requests, secure QR issuance/scanning, generic credential assignment, reports, corrections, printing and audit are available before a terminal is purchased. Hardware is an adapter, not an Attendance identity or policy authority.
