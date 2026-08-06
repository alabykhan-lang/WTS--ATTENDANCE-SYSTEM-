# Attendance integration rollback

Rollback is additive and reversible. Do not delete attendance history, roster snapshots, identity rows, devices or institutional classifications as part of an integration rollback.

## Safe sequence

1. Disable the Attendance client registration in Central Registry if new SSO entry must stop immediately.
2. Revert the School Platform Attendance authorization route and Workspace card only after active sessions are allowed to expire or are centrally revoked.
3. Revert Attendance server endpoints and browser bundle together so the client cannot call a removed endpoint.
4. Leave the roster audit and snapshots intact for evidence; stop future syncs rather than deleting them.
5. Confirm the official academic context, pupil/staff counts, devices, grants and attendance history before and after rollback.
6. Restore the integration from the last known-good commit and re-run read-only SSO, revocation and roster checks.

The protected institutional classification and special identifiers are not ordinary feature flags and must not be removed during rollback. If a protected identity is disabled, use the Central Registry protected recovery contract with the required re-authentication, confirmation and audit reason.
