# WTS Attendance System

Standalone student and staff attendance control system for Way to Success Standard Schools, Ejigbo.

Production release includes:

- Central WTS identity and Attendance module-grant validation;
- AM/PM student registers generated from real Central Registry classes;
- staff daily logbook linked to real Central Registry staff profiles;
- QR-first attendance through the focused scanner, authorized readers and saved scanner exports;
- secure QR issuance and browser scanner at `/scanner`;
- generic CSV, XLSX and delimited-text Import Centre with preview, checksum and unresolved-user review;
- device registry, offline-safe event intake, deduplication and raw-event audit;
- corrections, register locking, reports and print-safe operational views;
- a protected read-only Workspace contract and Notification-ready outbox hooks.

The operational direction is QR-first. The QR image contains only a server-mapped identifier; the scanner or imported file supplies the original scan time. Live Wi-Fi/mobile devices can transmit immediately, while offline scanners can retain events for later import without changing their recorded times. Manual class registers remain available as a controlled fallback. Historical non-QR source values remain in the database only to preserve existing records and adapter compatibility; they are not offered as current operator workflows.

The primary workspace follows the notebook plan: Dashboard, Take Attendance, Analysis, Setup and QR Codes Generation. No sample pupils, staff, devices or attendance facts are created by the application.

See `docs/` for the architecture, credential lifecycle, device integration, calculations, security controls and production verification runbook.
