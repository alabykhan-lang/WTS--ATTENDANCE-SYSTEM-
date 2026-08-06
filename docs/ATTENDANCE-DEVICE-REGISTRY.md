# Attendance Device Registry

The Device Registry contains only real school-owned or authorised devices. It supports a card reader, fingerprint or multi-biometric terminal, QR/mobile scanner, USB import source, Wi-Fi/LAN terminal and manual register source.

Each device record includes its code, name, category, manufacturer/model/serial metadata where supplied, firmware, physical location, connection/import method, supported sources, time-zone and health/synchronisation fields, clock-drift allowance metadata, ownership/deployment mode, status and audit history.

Operational statuses are `pending_setup`, `active`, `offline`, `suspended`, `retired` and `faulty`. Existing registered device rows are preserved. The UI shows an honest empty state when there are no purchased devices.

Device secrets are issued once, hashed in Supabase, and rotated through an authorised server operation. A device can be suspended without deleting its historical events.

Health is based on last contact/synchronisation and failed import state. A device is not considered an attendance policy engine; it supplies raw detection events only.
