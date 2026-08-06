# Attendance roster synchronisation

Roster synchronisation is idempotent and Central Registry-led.

## Process

1. Attendance requests the effective-dated Central Registry roster.
2. Attendance upserts pupil and staff roster snapshots keyed by the source identity and effective context.
3. Existing expected rows are deactivated only for future registers.
4. Historical attendance rows remain unchanged and reportable.
5. The run is recorded in `attendance_roster_sync_runs`.

The synchronisation audit records status, official context, effective date, additions, updates, future-roster deactivations, unresolved identities, failed mappings, retry linkage and completion time.

Protected Attendance endpoints:

- `attendance_roster_sync_status_api` — latest result and recent run history;
- `attendance_roster_sync_api` — safe idempotent re-sync;
- `attendance_roster_sync_retry_api` — retry a previous run against the current Central Registry contract.

The current corrected production sync loaded 737 effective pupil roster rows and 25 effective staff roster rows with zero unresolved identities, zero failed mappings and zero deactivations. The initial effective-date boundary issue was corrected before the successful sync; no attendance event or history row was created.
