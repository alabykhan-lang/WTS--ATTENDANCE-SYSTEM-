# WTS Attendance System

Standalone student and staff attendance control system for Way to Success Standard Schools, Ejigbo.

Production release includes:

- Central WTS identity and Attendance module-grant validation;
- AM/PM student registers generated from real Central Registry classes;
- staff daily logbook linked to real Central Registry staff profiles;
- manual, QR, NFC/MIFARE/RFID, external device-user and generic card credentials;
- secure QR issuance and browser scanner at `/scanner`;
- generic CSV, XLSX and delimited-text Import Centre with preview, checksum and unresolved-user review;
- device registry, offline-safe event intake, deduplication and raw-event audit;
- corrections, register locking, reports and print-safe operational views;
- a protected read-only Workspace contract and Notification-ready outbox hooks.

The system is hardware-independent: manual and QR operation are available before a terminal is purchased, while future terminals connect through the universal event and adapter contracts. No sample pupils, staff, devices or attendance facts are created by the application.

See `docs/` for the architecture, credential lifecycle, device integration, calculations, security controls and production verification runbook.
