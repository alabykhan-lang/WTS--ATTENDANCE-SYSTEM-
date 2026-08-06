"use strict";

(() => {
  const CFG = window.WTS_CONFIG;
  const TRANSACTION_KEY = "wts_attendance_pkce_transaction";
  const $ = (selector) => document.querySelector(selector);

  function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function challenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
  }

  function setMessage(message, tone = "") {
    const node = $("#authError");
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone;
  }

  function friendly(code) {
    return ({
      ATTENDANCE_ACCESS_NOT_GRANTED: "This identity does not have an active Attendance grant.",
      PORTAL_ACCESS_NOT_GRANTED: "This identity does not have an active Attendance grant.",
      SSO_REQUEST_INVALID: "The Attendance sign-in request was not accepted.",
      ATTENDANCE_SSO_EXCHANGE_FAILED: "Attendance sign-in could not be completed. Start again from the WTS Workspace.",
      RESULT_SESSION_NOT_ACTIVE: "The central WTS session is no longer active. Sign in again.",
      CENTRAL_IDENTITY_NOT_ACTIVE: "The central WTS identity is no longer active.",
    })[code] || "Attendance sign-in could not be completed. Please use the central WTS sign-in.";
  }

  function saveTransaction(transaction) {
    sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
  }

  function loadTransaction() {
    try {
      const transaction = JSON.parse(sessionStorage.getItem(TRANSACTION_KEY) || "null");
      if (!transaction || !transaction.verifier || !transaction.state || !transaction.nonce || Number(transaction.expires_at) <= Date.now()) return null;
      return transaction;
    } catch {
      return null;
    }
  }

  function clearTransaction() {
    sessionStorage.removeItem(TRANSACTION_KEY);
  }

  async function beginLogin() {
    if (window.__WTS_ATTENDANCE_LOGIN_PENDING) return;
    window.__WTS_ATTENDANCE_LOGIN_PENDING = true;
    setMessage("Opening central WTS sign-in…", "info");
    const verifier = randomToken();
    const state = randomToken();
    const nonce = randomToken();
    const codeChallenge = await challenge(verifier);
    saveTransaction({ verifier, state, nonce, expires_at: Date.now() + 5 * 60 * 1000 });
    const authorize = new URL(CFG.authorizeUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", "attendance");
    authorize.searchParams.set("redirect_uri", `${CFG.attendanceOrigin}/`);
    authorize.searchParams.set("scope", "attendance");
    authorize.searchParams.set("code_challenge", codeChallenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    window.location.assign(authorize.toString());
  }

  async function exchangeCallback() {
    const query = new URLSearchParams(window.location.search);
    const code = query.get("code");
    const returnedState = query.get("state");
    const returnedNonce = query.get("nonce");
    const error = query.get("error") || query.get("code_error");
    if (error) throw Object.assign(new Error(friendly(error)), { code: error });
    if (!code && !returnedState && !returnedNonce) return false;
    const transaction = loadTransaction();
    if (!code || !returnedState || !returnedNonce || !transaction || returnedState !== transaction.state || returnedNonce !== transaction.nonce) {
      clearTransaction();
      throw Object.assign(new Error("The Attendance sign-in response could not be verified. Start again."), { code: "SSO_CALLBACK_INVALID" });
    }
    const response = await fetch("/api/sso-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, state: returnedState, nonce: returnedNonce, code_verifier: transaction.verifier }),
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({ ok: false, code: "ATTENDANCE_SSO_EXCHANGE_FAILED" }));
    clearTransaction();
    if (!response.ok || !result?.ok) throw Object.assign(new Error(friendly(result?.code)), { code: result?.code });
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    return true;
  }

  async function checkSession() {
    const response = await fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
    const result = await response.json().catch(() => ({ ok: false, code: "ATTENDANCE_SESSION_REQUIRED" }));
    return response.ok && result?.ok === true;
  }

  async function bootstrap() {
    const form = $("#gateForm");
    form?.addEventListener("submit", (event) => { event.preventDefault(); beginLogin().catch((error) => { window.__WTS_ATTENDANCE_LOGIN_PENDING = false; setMessage(error.message || friendly(error.code), "error"); }); });
    $("#centralSignIn")?.addEventListener("click", () => beginLogin().catch((error) => { window.__WTS_ATTENDANCE_LOGIN_PENDING = false; setMessage(error.message || friendly(error.code), "error"); }));
    try {
      const callbackHandled = await exchangeCallback();
      if (callbackHandled || await checkSession()) return true;
    } catch (error) {
      setMessage(error.message || friendly(error.code), "error");
      return false;
    }
    beginLogin().catch((error) => { window.__WTS_ATTENDANCE_LOGIN_PENDING = false; setMessage(error.message || friendly(error.code), "error"); });
    return false;
  }

  window.WTS_AUTH_BEGIN = beginLogin;
  window.WTS_AUTH_READY = bootstrap();
})();
