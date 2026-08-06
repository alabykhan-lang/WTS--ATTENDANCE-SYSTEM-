# Production verification

## Safe checks

- Confirm the current production deployment is READY and the main branch is the deployed source.
- Open Attendance through central identity; confirm the module grant is required.
- Confirm direct anonymous data writes are rejected.
- Confirm current real pupil/staff lists load and no duplicate identity is created.
- Load an empty AM register and confirm no pupil is silently marked present.
- Verify morning and afternoon selectors load different session records.
- Verify manual save, confirmation lock and correction request paths with an approved operator.
- Verify QR/card assignment rejects an active duplicate and displays only a suffix.
- Verify a diagnostic scan does not write attendance and a normal scan is server-confirmed.
- Verify an import preview separates ready, duplicate, unknown and invalid rows before confirmation.
- Verify re-uploading the same checksum is rejected.
- Verify original event timestamp is retained for imported rows.
- Verify staff logbook, report calculations and print views contain honest empty states.
- Verify holiday/closure/staff-only calendar rows are excluded from the pupil denominator and weekly/monthly grouped rows match the selected date range.
- Verify no browser bundle contains a service-role key or raw device secret.
- Verify mobile register controls do not require horizontal scrolling.

No production sample pupils, staff, attendance rows or devices are created by this checklist. Test fixtures belong in isolated test files or an approved non-production project.
