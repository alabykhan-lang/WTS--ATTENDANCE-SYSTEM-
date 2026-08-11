"use strict";

// The portal origin is deployment configuration, not an application-wide
// routing constant. Vercel can inject WTS_PORTAL_ORIGIN before the future
// custom domain is attached; the current production fallback keeps this
// deployment operational today.
const portalOrigin = String(window.WTS_PORTAL_ORIGIN || "https://wts-school-platform.vercel.app").replace(/\/$/, "");
const attendanceOrigin = window.location.origin;

window.WTS_CONFIG = Object.freeze({
  portalOrigin,
  postLogoutUri: `${portalOrigin}/workspace`,
  attendanceOrigin,
  authorizeUri: `${portalOrigin}/api/sso/authorize`,
});
