# Hardware adapter framework

The stable adapter boundary is:

```text
read source -> normalise identifier -> preserve raw reference -> resolve credential
-> produce standard event -> idempotent intake -> attendance interpretation
```

Initial adapters:

- Manual Entry Adapter
- QR Scanner Adapter
- Generic Card / UID Adapter
- Generic CSV Adapter
- Generic XLSX Adapter
- Generic delimited text Adapter
- Google Sheets read-only input contract
- WTS Live Device API Adapter

Vendor adapters are extension points, not compatibility claims. ZKTeco, Hikvision, Anviz and other terminals must be tested against an authentic export or documented API before a vendor adapter is enabled.

An adapter may provide a device event ID, external user ID, card UID, method, direction, original event timestamp, source time zone, device location and raw source reference. It must not invent a person or overwrite a Central Registry identity.
