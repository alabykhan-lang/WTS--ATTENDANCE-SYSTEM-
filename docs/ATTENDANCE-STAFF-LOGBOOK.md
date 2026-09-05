# Staff attendance logbook

Staff records link to `staff_attendance_profiles`, the existing Attendance read adapter for Central Registry staff. No independent Attendance staff list is created.

The daily logbook shows real staff name, staff number, designation/department, arrival, departure, status, lateness, method and approved exception. It supports date, section and status filters, print/PDF browser output, individual summaries and correction requests.

An authorised Attendance officer may use the Take Attendance manual fallback when a staff QR scan was missed. The fallback records the selected Africa/Lagos event time, writes the existing raw/event/daily/session records, emits the normal attendance hook and adds an administrator audit entry. It cannot write to an inactive staff identity or a locked session. Staff members still cannot rewrite their official attendance; their correction requests use the separate review workflow and preserve the original event and decision.

Fingerprint, face, card, QR and imported terminal events use the same staff daily interpretation. A missing departure remains incomplete rather than being silently counted as a complete day.
