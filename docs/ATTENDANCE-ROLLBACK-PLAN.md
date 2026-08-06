# Rollback plan

## Application rollback

1. Stop or revert the Attendance deployment to the last verified production deployment.
2. Preserve the database migration and raw events; do not delete attendance facts.
3. Suspend a faulty device or adapter credential at the Device Registry.
4. Disable the affected source in the system configuration if required.
5. Continue through manual register operations while the adapter is investigated.

## Database rollback

The universal organizer migration is additive. Do not drop the new tables during an incident. Revoke the affected API execute grant or suspend the device, then repair forward with a reviewed migration. If a schema rollback is ever approved, take a backup manifest first, stop writes, verify dependencies, and restore only the affected function/table boundary.

## Data protection

Raw events, import batches, corrections and audit rows are evidence. Any correction is made through the controlled workflow and then reclosed. Central Registry session/term and identities are never changed as an Attendance rollback action.
