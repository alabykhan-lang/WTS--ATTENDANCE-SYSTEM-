# Attendance security controls

- Central WTS identity and server-side Attendance module grant validation.
- Short-lived Attendance admin sessions with expiry checks and revocation via the central logout path.
- Current browser session transport is short-lived and grant-validated; dedicated Attendance PKCE callback registration and the final host-only HttpOnly cookie session require the coordinated Central Registry/Workspace contract.
- Server-side effective Attendance permissions and class-allocation checks for protected actions.
- RLS enabled on Attendance-owned tables; direct browser table access revoked. Security-definer APIs validate their own credentials and have explicit execution grants.
- Device-specific secret hashes, device status checks, source allowlists, installation binding and rate/origin controls at the Edge Function.
- Stable event IDs, source IDs, timestamp sanity checks and deduplication keys prevent replayed scans and duplicate uploads.
- No browser service-role key, raw device secret, raw credential value or biometric template.
- Unknown identifiers are held for review and never become identities automatically.
- Imports are checksum-protected and previewed before processing.
- Manual entries, credential changes, device changes, register confirmation/reopening, corrections and report actions are audited.

Request signing for future standalone-vendor adapters remains an integration hardening step when a vendor can support it. Until then, use the device secret, HTTPS, allowlisted source and server idempotency boundary.
