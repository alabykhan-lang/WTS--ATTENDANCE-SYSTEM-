# Attendance Workspace integration

Workspace consumes Attendance through the protected read-only contract `public.attendance_workspace_read_workspace_api`. The contract validates the Workspace session, confirms the active Attendance grant or protected institutional authority, and returns only summaries.

Workspace displays:

- personal today status, check-in, check-out, weekly/monthly/term percentages and unresolved corrections;
- actual class-teacher assignments with separate morning and afternoon register status, present/absent counts, weekly percentage, incomplete-register alerts and repeated-absence alerts;
- authorised management figures for staff present/absent/late, pupils present/absent, incomplete registers and device/import health;
- latest roster synchronisation status.

Workspace remains read-only. It has no attendance marking, correction approval, import, device or log-editing controls. The Attendance card opens the Attendance origin directly; Attendance then performs PKCE through the central WTS authorization endpoint. No iframe or technical URL is exposed in the Workspace UI.

When no attendance events exist, the summary returns an explicit empty state instead of fabricated zero records. Protected institutional identities receive module access from Central Registry classification; ordinary users continue to require their real active module grants.
