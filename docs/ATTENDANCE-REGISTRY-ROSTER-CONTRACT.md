# Attendance Registry roster contract

Central Registry is authoritative for Attendance roster data. Attendance does not maintain a second pupil or staff master list.

The protected contract is `public.school_attendance_registry_roster_read_api` and requires an active Attendance audience session. It returns, for a requested academic session, term and effective date:

- the official academic context;
- active classes;
- pupils with admission number, status, class placement and effective dates;
- active staff identities and employment status;
- actual class-teacher and assistant class-teacher allocations;
- active Attendance module grants.

Records are filtered using the requested effective date. A same-day effective enrollment is valid on its start/end date. Historical attendance is not part of this contract and is not rewritten by roster changes.

Unauthenticated, expired, revoked, suspended or audience-mismatched sessions are rejected. Class-teacher assignments are returned only when an active Central Registry allocation exists; an empty allocation is an honest empty result.
