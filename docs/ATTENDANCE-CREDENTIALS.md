# Attendance credentials

## Supported types

`qr_token` is the active operational credential type. The universal data model also retains older external credential types for migration, historical events and future adapter compatibility; they are not exposed in the current QR-first operator screens.

Each active credential maps to exactly one real Central Registry pupil or staff profile. A person may have more than one credential. The same active value cannot be assigned to two people.

## Storage and lifecycle

The system stores a one-way hash and a short display suffix. The raw reader value is used only in the controlled assignment request and is never returned by list APIs. A raw-value hash can be retained in non-reversible metadata to remain compatible with readers that hash exact output; it is not a credential secret.

Statuses are `pending`, `active`, `lost`, `suspended`, `revoked`, `expired` and `replaced`. Revocation or replacement updates the source credential row and preserves all historical events.

QR tokens are random server-issued values. They do not contain names, phone numbers, addresses, admission data or guardian data. QR output is shown once for printing and can later be revoked.

Fingerprint and face devices are represented by external user IDs. Attendance does not store biometric images or templates.

## Assignment flow

1. Search the live pupil or staff list.
2. Issue or retrieve the person’s permanent QR code.
3. Show, download or print the QR for the ID-card back or a class/staff sheet.
4. Select the real issuing device when known.
5. Confirm and activate, or revoke/replace an existing used QR through the controlled workflow.
6. Audit and retain the credential history.

If a value is already active, assignment fails. Unknown import values remain unresolved until an authorised administrator maps them to an existing identity.

The QR image is not a storage device. It contains a non-meaningful server-mapped token. The authorized scanner records the time and device context; if it is offline, the scanner or import file must retain that original time until synchronization.
