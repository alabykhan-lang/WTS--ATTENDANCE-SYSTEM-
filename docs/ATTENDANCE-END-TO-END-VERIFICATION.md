# Attendance end-to-end verification

Verification uses existing real identities and existing Central Registry classes. It does not create test users, classes, scans, devices or attendance records.

## Read-only checks

- Confirm the official context is the Central Registry current session and term.
- Confirm 798 pupils, 25 staff profiles and 2 existing devices remain present.
- Confirm the effective roster contains 737 active pupils and 25 active staff rows.
- Confirm attendance event/history tables remain unchanged and empty where no real operations have occurred.
- Confirm no duplicate people, invented allocations or Result/Notification changes.
- Confirm the Attendance SSO client, exact callback and S256 requirement are active.
- Confirm unauthenticated, expired, revoked and unauthorized calls are denied.
- Confirm the Workspace summary is read-only and matches the protected Attendance summary contract.

## Browser checks

With an existing authorised account, verify on desktop and mobile:

1. Attendance appears only when the server-derived authority or real Attendance grant allows it.
2. Workspace → Attendance opens without a second login.
3. A direct Attendance visit routes through central WTS authentication and returns safely.
4. Ordinary staff see only their own personal summary.
5. A class teacher sees only actual assigned classes, with separate AM/PM register state.
6. Authorised management sees school-wide summary fields and honest empty states.
7. Attendance logout clears its session; central logout invalidates linked Attendance access.

No operational attendance entry is required for this verification. If a real operational entry is explicitly approved later, verify it through the normal audit and correction workflow without altering historical data.
