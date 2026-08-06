# Standard Attendance event contract

The live and import contract accepts:

```json
{
  "event_id": "client idempotency UUID",
  "source_event_id": "vendor or file record id",
  "device_id": "registered device UUID",
  "external_person_or_credential_reference": "reader value hash or external user id",
  "event_timestamp": "original device timestamp",
  "received_timestamp": "server receipt timestamp",
  "source_time_zone": "Africa/Lagos",
  "direction": "IN | OUT | UNSPECIFIED",
  "event_type": "check_in | check_out",
  "credential_method": "QR | NFC | MIFARE | RFID | CARD | FINGERPRINT | FACE | PIN | IMPORT | MANUAL",
  "physical_location": "optional registered location",
  "raw_source_reference": "non-sensitive audit reference",
  "import_batch_id": "optional batch UUID",
  "metadata": {}
}
```

The database adds a stable deduplication key. Duplicate retries become `DUPLICATE_IGNORED`; they are not silently removed. Unknown identifiers become an unresolved raw event and an outbox event for later review.

The official record is separate from the raw event and can be corrected without changing the original event.
