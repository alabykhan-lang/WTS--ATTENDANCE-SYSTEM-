# Notebook attendance implementation

This document records the implementation direction taken from the supplied seven-page architectural plan.

## Primary navigation

The management workspace exposes five primary areas in this order:

1. Dashboard
2. Take Attendance
3. Analysis
4. Setup
5. QR Codes Generation

The separate `/scanner` page is the focused gate surface. It is designed to stay open on the scanning device and does not require repeated navigation through the management workspace.

## Capture direction

QR is the operational attendance method. The system supports:

- camera-based QR scanning;
- input from a connected QR reader;
- future standalone Wi-Fi/mobile QR terminals through the authenticated device API;
- scanners with internal storage through timestamp-preserving CSV/XLSX/text import;
- manual class registers as a controlled fallback.

NFC/card-reader setup is not part of the current operator UI. Existing non-QR values are preserved in the database only where required for historical integrity or future adapter contracts.

The QR code itself does not record time. The capture device records `event_timestamp`; the server records receipt/upload time separately. Offline synchronization must use the original event time for arrival, lateness and reporting.

## Dashboard

Dashboard uses the protected `attendance_notebook_read_api` and accepts a date plus `sessionSlot` of `morning` or `afternoon`. It shows:

- students expected;
- students signed in/recorded;
- late students;
- students not yet scanned;
- unconfirmed classes;
- staff signed in;
- capture health, attention items, class summaries and recent events.

The morning and afternoon views are separate. A later afternoon scan cannot overwrite the morning record, and duplicate scans for the same person/session are controlled by the authoritative intake function.

## Take Attendance

The page provides direct links to the focused scanner in morning-arrival and afternoon-closing modes. It also provides a class register using the existing Central Registry roster:

- choose date, register and class;
- load the active class roster;
- mark each status or use “Mark all present”;
- save an incomplete working register;
- resolve every row before confirmation;
- confirm and lock the register;
- request an authorized correction later without deleting history;
- print the current register.

Authorised Attendance officers also have a staff fallback on this page. They can record a missed staff check-in or check-out, choose an explicit exception such as approved leave, or let the active staff time rule classify the entry. The action uses the existing staff event, daily and session records, preserves the selected local event time, emits the attendance hook and creates an audit entry. It is unavailable to ordinary staff and cannot bypass a locked session.

## Analysis and printable records

Analysis retains the existing student/class report boundary and adds:

- staff expected/signed-in/late/not-yet-seen summary;
- individual staff history by date range;
- daily staff arrival and closing logbook ordered by arrival;
- student register printing;
- staff logbook printing with signatures and school-period context.

Reports remain generated from committed authoritative records. Corrections must invalidate/recalculate affected summaries before a report is regenerated.

## Setup and QR generation

Setup is the operator entry point for authorized QR devices, offline imports, corrections, Central Registry context and roster status. Device secrets are shown only at creation, stored as hashes, and never exposed in browser source.

QR Codes Generation searches the real Central Registry people and uses the existing secure QR lifecycle. Permanent values are reused for reprinting; replacement is controlled after a used/lost/damaged code and preserves the original history. Bulk output supports a selected class and all staff. The preview can print the complete QR block or a separate, fully rendered back-cover template sized for the school ID card. Attendance does not invent the ID-card front.

## Not claimed by this implementation

The system is ready for manual, QR and generic file-import operation without purchased hardware. A physical standalone terminal is not assumed to be compatible until its timestamp format, offline export and custom HTTPS/API capability are tested. The final dedicated PKCE/HttpOnly cross-repository session exchange and scheduled Google Sheets synchronization remain coordination items outside this repository.
