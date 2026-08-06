# Workspace read-only contract

Attendance exposes `attendance_workspace_read_api(central_person_id)` as a protected, server-to-server read contract. It is not granted to anonymous or browser roles. Workspace must call it from its server boundary after validating the central WTS session.

The contract returns only the caller’s approved scope:

- own today status and check-in/check-out;
- own weekly/monthly/term summaries and unresolved issue count;
- active assigned class keys for a class teacher;
- assigned-class summary data when the future Workspace adapter requests it;
- management summary only when the caller’s Attendance permissions grant that scope.

Workspace cannot mark attendance, approve corrections, manage devices or import files. Operational actions must link to Attendance.

Current coordination item: the connected School Platform has not yet registered an Attendance PKCE client/callback. The exact required contract is `client_id=attendance`, target `attendance`, an allow-listed Attendance callback URL, short-lived authorization code exchange with PKCE, central grant validation and revocation propagation. This requires coordinated implementation in School Platform and Central Registry; Attendance did not change those repositories.
