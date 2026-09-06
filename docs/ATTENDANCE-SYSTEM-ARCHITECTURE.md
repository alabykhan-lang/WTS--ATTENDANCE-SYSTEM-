# WTS Attendance System architecture

The operator portal has five areas only: Dashboard, Take Attendance, Analysis,
Setup, and QR Codes Generation.

## Attendance capture

Attendance is recorded only by a valid QR. A registered phone may use its camera
or a connected QR reader. One record is accepted for each person, school date,
and AM/PM period; repeated scans are ignored by the database. Morning arrival is
`check_in` and afternoon closing is `check_out` regardless of the clock time.

Closing before 3:30 PM requires a reason. The scanner records the original time
and available phone location. If the network is unavailable, the encrypted phone
queue retains that information. Synchronizing a queue or uploaded scanner file
requires the administrative password every time.

## Setup

- The administrative password authorizes offline synchronization and protected
  setup changes.
- One general scanner password registers approved phones. Each installation
  receives its own stored token. Resetting the general password revokes every
  existing phone token.
- Setup lists registered phones and stores the school location.

Passwords and installation tokens are stored as hashes. Direct table access is
blocked by row-level security and explicit privilege revocation.

## Analysis

Analysis first separates Students and Staff, then General and Individual.
Available periods are Day, Week, Month, and Term. The backend derives the date
boundaries; there are no arbitrary From/To controls.

General student records are selected by class. Daily class attendance and the
general staff daily time book are ordered by morning arrival, earliest first,
with people who have not arrived listed last.

The printed daily staff time book contains only:

1. S/N
2. Staff Name
3. Morning Arrival
4. Signature
5. Afternoon Closing
6. Signature

A signature cell is blank unless an official signature is stored for that staff
member. A blank signature is not an attendance entry.

## QR generation

The school office can prepare a QR for one person, one class, all students, or
all staff. Output is available as a high-resolution image or printable document,
including a complete ID-card back cover. Replacement uses the established QR
lifecycle so a replaced code no longer records attendance.

## Data boundary

Central Registry remains the identity and roster authority. The Attendance
system retains raw event evidence, accepted student/staff events, daily summaries,
session records, location metadata, password hashes, and audit timestamps. Legacy
operator APIs are not exposed, and active attendance source constraints permit
only `qr` and `offline_sync`.
