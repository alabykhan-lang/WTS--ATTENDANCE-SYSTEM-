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
  "credential_method": "QR | IMPORT | MANUAL",
  "physical_location": "optional registered location",
  "raw_source_reference": "non-sensitive audit reference",
  "import_batch_id": "optional batch UUID",
  "metadata": {}
}
```

The database adds a stable deduplication key. Duplicate retries become `DUPLICATE_IGNORED`; they are not silently removed. Unknown identifiers become an unresolved raw event and an outbox event for later review.

The official record is separate from the raw event and can be corrected without changing the original event.

The production intake direction is QR-first. `QR` is the active credential method for new attendance capture; `IMPORT` identifies a saved scanner export and `MANUAL` identifies a controlled register entry. Older non-QR method values may remain in historical rows or adapter vocabulary for preservation, but new operator setup does not expose them.

For an offline scanner, `event_timestamp` is the scanner’s original local scan time and `received_timestamp` is the later upload/import time. The server must never replace the former with the latter when calculating arrival, lateness or attendance percentages.
