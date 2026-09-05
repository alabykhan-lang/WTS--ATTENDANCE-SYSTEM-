# Attendance Device Registry

The Device Registry contains only real school-owned or authorised devices. The current operational device is a QR camera/reader or standalone QR terminal. The registry also supports a saved-file import source and the controlled manual register source. A future device may use Wi-Fi, mobile data, Ethernet or another documented transport, but it must still authenticate to the Attendance intake boundary.

Each device record includes its code, name, category, manufacturer/model/serial metadata where supplied, firmware, physical location, connection/import method, supported sources, time-zone and health/synchronisation fields, clock-drift allowance metadata, ownership/deployment mode, status and audit history.

At setup, record the gate/station, connection mode, time zone and whether offline retention is enabled. A device that is merely wireless is not automatically internet-connected: live delivery requires a network-capable terminal and a documented custom HTTPS/API contract. A scanner with internal storage can still be used through the authorized import workflow, provided its export preserves the original scan time and source record.

Operational statuses are `pending_setup`, `active`, `offline`, `suspended`, `retired` and `faulty`. Existing registered device rows are preserved. The UI shows an honest empty state when there are no purchased devices.

Device secrets are issued once, hashed in Supabase, and rotated through an authorised server operation. A device can be suspended without deleting its historical events.

Health is based on last contact/synchronisation and failed import state. A device is not considered an attendance policy engine; it supplies raw detection events only.
