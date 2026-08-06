# Device integration guide

## Before purchase

Ask the seller for the exact model, card frequency/type, supported terminal user ID, offline event capacity, original timestamp export, TCP/IP/Wi-Fi behaviour and API/push/SDK documentation. Do not rely on a listing that only says RFID or networked.

The system can use a standalone terminal later. The terminal must be registered in Attendance and given a device credential through an approved adapter. It must not receive a Supabase service key.

## First installation

1. Create the real Device Registry entry with exact code, model, serial, location and connection method.
2. Rotate/store the one-time device secret through the approved administrator flow.
3. Test offline storage and later synchronisation without changing event timestamps.
4. Obtain a genuine sample export if using USB/Wi-Fi import.
5. Create the adapter mapping for external user ID/card UID and verification method.
6. Assign each real terminal user ID/card to a real Central Registry pupil or staff person.
7. Confirm duplicate/replay behaviour and an unknown-user queue.
8. Run a controlled pilot with authorised identities and approved test dates.

## Replacement

Suspend the old device, preserve its logs, register the replacement and map the same real people to the new external IDs. Never reuse a device secret or delete historical device events.

Vendor compatibility is not claimed until the exact model and authentic export/API have been tested.
