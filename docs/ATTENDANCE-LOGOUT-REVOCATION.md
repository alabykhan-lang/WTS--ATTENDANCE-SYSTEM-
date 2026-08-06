# Attendance logout and revocation

Attendance uses two host-only, Secure, HttpOnly, SameSite cookies: one for its Attendance session and one for the Central Registry Attendance-audience session. Cookie presence is never treated as authorization; protected endpoints revalidate the central session, person, account, employment and grant/authority state.

## Logout

`POST /api/sso-logout` calls the Central Registry revocation contract, clears both cookies and returns the approved Workspace destination. `GET /api/sso-logout` performs the same revocation and redirects to Workspace.

Central Workspace logout revokes linked Attendance sessions. Attendance grant revocation, identity suspension, employment termination, account suspension and session revocation are rechecked and block continued access. Device authentication remains a separate server-side path and is not used as a staff browser session.

Every session issuance and revocation is audited in Central Registry. The institutional recovery path requires recent re-authentication, explicit confirmation and a reason; ordinary management operations cannot downgrade, archive, delete or change an institutional identity or number.
