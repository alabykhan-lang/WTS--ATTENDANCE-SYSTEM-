# Attendance PKCE SSO

Attendance is an approved WTS SSO client. Central Registry remains the identity and grant authority; Attendance does not create a second staff identity and does not reuse a Results session.

## Production registration

- Client ID: `attendance`
- Audience / target: `attendance`
- Approved origin: `https://wts-attendance-system.vercel.app`
- Exact callback URI: `https://wts-attendance-system.vercel.app/`
- Exact post-logout URI: `https://wts-school-platform.vercel.app/workspace`
- Response type: `code`
- Scope: `attendance`
- Code challenge: `S256`

Central Registry stores the active registration and validates the exact client, audience and redirect tuple. Authorization codes are short-lived and single-use. The authorization request binds state and nonce hashes, and the exchange checks the state, nonce and S256 verifier again.

## Direct Attendance sign-in

Attendance also keeps its own normal sign-in screen for direct visits. The screen accepts the existing WTS staff number or official email and the existing WTS password. The Attendance server sends those credentials only to the Central Registry `school_identity_portal_login` contract with the `attendance` application code. Central Registry remains responsible for password verification, lockout, active identity, employment and Attendance-grant checks. Attendance then issues its own host-only session; it never creates a second identity or stores a second password.

The direct form is the normal fallback for a direct Attendance visit. It is not an independent Attendance account system.

## PKCE flow

1. When the user chooses the existing Workspace session, Attendance creates an ephemeral verifier, state and nonce in browser session storage.
2. The browser goes to the School Platform authorization endpoint.
3. The School Platform requires an active Workspace session and asks Central Registry to issue an Attendance-specific code.
4. Central Registry redirects to the exact Attendance callback.
5. Attendance verifies state and nonce, then posts the code and verifier to its same-origin server endpoint.
6. The Attendance server exchanges the code server-to-server and sets its own host-only session cookies.

Only the short-lived PKCE transaction is held in browser session storage. Reusable central or Attendance credentials are not placed in URLs, local storage or browser-readable cookies.
