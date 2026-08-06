# Attendance credentials

## Supported types

`qr_token`, `nfc_uid`, `mifare_uid`, `rfid_uid`, `generic_card_uid`, `fingerprint_device_user_id`, `face_device_user_id`, `pin`, `external_device_user_id`, `barcode` and `temporary_pass` are supported by the universal credential model.

Each active credential maps to exactly one real Central Registry pupil or staff profile. A person may have more than one credential. The same active value cannot be assigned to two people.

## Storage and lifecycle

The system stores a one-way hash and a short display suffix. The raw reader value is used only in the controlled assignment request and is never returned by list APIs. A raw-value hash can be retained in non-reversible metadata to remain compatible with readers that hash exact output; it is not a credential secret.

Statuses are `pending`, `active`, `lost`, `suspended`, `revoked`, `expired` and `replaced`. Revocation or replacement updates the source credential row and preserves all historical events.

QR tokens are random server-issued values. They do not contain names, phone numbers, addresses, admission data or guardian data. QR output is shown once for printing and can later be revoked.

Fingerprint and face devices are represented by external user IDs. Attendance does not store biometric images or templates.

## Assignment flow

1. Search the live pupil or staff list.
2. Select the credential type.
3. Tap, scan, paste or enter the reader value.
4. Select the real issuing device when known.
5. Confirm and activate.
6. Audit and retain the credential history.

If a value is already active, assignment fails. Unknown import values remain unresolved until an authorised administrator maps them to an existing identity.
