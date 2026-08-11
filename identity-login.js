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
      INVALID_LOGIN: "The staff number/email or password is incorrect. Check your current WTS password and try again.",
      LOGIN_AND_PASSWORD_REQUIRED: "Enter your staff number or official email and password.",
      ACCOUNT_NOT_ACTIVE: "This WTS staff account is not active.",
      ACCOUNT_TEMPORARILY_LOCKED: "Too many failed attempts. Try again later or ask management to unlock the account.",
      ATTENDANCE_ACCESS_NOT_GRANTED: "This identity does not have an active Attendance grant.",
      PORTAL_ACCESS_NOT_GRANTED: "This identity does not have an active Attendance grant.",
      PORTAL_PERMISSION_SYNC_FAILED: "Central Registry could not prepare this identity for Attendance. Try again or contact management.",
      ATTENDANCE_SESSION_SERVICE_UNAVAILABLE: "Central Registry verified the identity, but the secure Attendance session could not be created. Try again.",
      ATTENDANCE_SERVICE_UNAVAILABLE: "Attendance data is temporarily unavailable. Try again shortly.",
      CENTRAL_SESSION_SERVICE_UNAVAILABLE: "The secure WTS session could not be created. Try again.",
      PASSWORD_CHANGE_REQUIRED: "Your WTS password must be changed before Attendance can open.",
      PASSWORD_CHANGE_INPUT_REQUIRED: "Enter both your current password and a new password.",
      PASSWORD_REQUIREMENTS_NOT_MET: "New password must be at least 10 characters and contain uppercase, lowercase and a number.",
      PASSWORD_MISMATCH: "The two new passwords do not match.",
      SSO_REQUEST_INVALID: "The Attendance sign-in request was not accepted.",
      ATTENDANCE_SSO_EXCHANGE_FAILED: "Attendance sign-in could not be completed. Start again from the WTS Workspace.",
      RESULT_SESSION_NOT_ACTIVE: "The central WTS session is no longer active. Sign in again.",
      CENTRAL_IDENTITY_NOT_ACTIVE: "The central WTS identity is no longer active.",
    })[code] || String(code || "Attendance sign-in could not be completed.").replaceAll("_", " ");
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
    setMessage("Opening the existing WTS Workspace session…", "info");
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

  async function changeRequired(login, currentPassword) {
    const dialog = $("#requiredPasswordDialog");
    const form = $("#requiredPasswordForm");
    const nextInput = $("#requiredPassword");
    const confirmInput = $("#requiredPasswordConfirm");
    const error = $("#requiredPasswordError");
    if (!dialog || !form || !nextInput || !confirmInput || !error) {
      throw Object.assign(new Error(friendly("PASSWORD_CHANGE_REQUIRED")), { code: "PASSWORD_CHANGE_REQUIRED" });
    }
    return new Promise((resolve, reject) => {
      const close = () => { if (dialog.open) dialog.close(); };
      const cancel = () => { cleanup(); close(); reject(Object.assign(new Error(friendly("PASSWORD_CHANGE_REQUIRED")), { code: "PASSWORD_CHANGE_REQUIRED" })); };
      const submit = async (event) => {
        event.preventDefault();
        if (nextInput.value !== confirmInput.value) {
          error.textContent = friendly("PASSWORD_MISMATCH");
          return;
        }
        error.textContent = "Saving password…";
        try {
          const response = await fetch("/api/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ action: "change_password", login, current_password: currentPassword, new_password: nextInput.value }),
            cache: "no-store",
          });
          const result = await response.json().catch(() => ({ ok: false, code: "PASSWORD_CHANGE_FAILED" }));
          if (!response.ok || !result?.ok) throw Object.assign(new Error(friendly(result?.code)), { code: result?.code });
          cleanup();
          close();
          nextInput.value = "";
          confirmInput.value = "";
          resolve();
        } catch (changeError) {
          error.textContent = friendly(changeError.code || changeError.message);
        }
      };
      const cleanup = () => {
        form.removeEventListener("submit", submit);
        $("#requiredPasswordCancel")?.removeEventListener("click", cancel);
        dialog.removeEventListener("cancel", cancel);
      };
      form.addEventListener("submit", submit);
      $("#requiredPasswordCancel")?.addEventListener("click", cancel);
      dialog.addEventListener("cancel", cancel, { once: true });
      error.textContent = "";
      nextInput.value = "";
      confirmInput.value = "";
      dialog.showModal();
      nextInput.focus();
    });
  }

  async function directLogin() {
    if (window.__WTS_ATTENDANCE_LOGIN_PENDING) return false;
    const loginInput = $("#loginId");
    const passwordInput = $("#loginPassword");
    const login = loginInput?.value.trim() || "";
    const password = passwordInput?.value || "";
    if (!login || !password) {
      setMessage(friendly("LOGIN_AND_PASSWORD_REQUIRED"), "error");
      (login ? passwordInput : loginInput)?.focus();
      return false;
    }
    window.__WTS_ATTENDANCE_LOGIN_PENDING = true;
    setMessage("Verifying your WTS identity…", "info");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ login, password }),
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({ ok: false, code: "ATTENDANCE_SERVICE_UNAVAILABLE" }));
      if (!response.ok || !result?.ok) throw Object.assign(new Error(friendly(result?.code)), { code: result?.code });
      if (result.must_change_password) {
        await changeRequired(login, password);
        setMessage("Password changed. Sign in again with your new WTS password.", "info");
        passwordInput.value = "";
        return false;
      }
      passwordInput.value = "";
      setMessage("Attendance access verified. Opening your workspace…", "success");
      window.location.replace(`${window.location.pathname}${window.location.hash}`);
      return true;
    } catch (error) {
      passwordInput.value = "";
      setMessage(error.message || friendly(error.code), "error");
      return false;
    } finally {
      window.__WTS_ATTENDANCE_LOGIN_PENDING = false;
    }
  }

  async function bootstrap() {
    const form = $("#gateForm");
    form?.addEventListener("submit", (event) => { event.preventDefault(); void directLogin(); });
    $("#workspaceSignIn")?.addEventListener("click", () => beginLogin().catch((error) => { window.__WTS_ATTENDANCE_LOGIN_PENDING = false; setMessage(error.message || friendly(error.code), "error"); }));
    $("#passwordToggle")?.addEventListener("click", () => {
      const input = $("#loginPassword");
      if (!input) return;
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      $("#passwordToggle").textContent = visible ? "Show password" : "Hide password";
    });
    document.querySelectorAll("[data-password-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.passwordToggle);
        if (!input) return;
        const visible = input.type === "text";
        input.type = visible ? "password" : "text";
        button.textContent = visible ? "Show password" : "Hide password";
      });
    });
    try {
      const callbackHandled = await exchangeCallback();
      if (callbackHandled || await checkSession()) return true;
      const query = new URLSearchParams(window.location.search);
      if (query.get("sso") === "1") {
        await beginLogin();
        return true;
      }
    } catch (error) {
      setMessage(error.message || friendly(error.code), "error");
      return false;
    }
    return false;
  }

  window.WTS_AUTH_BEGIN = beginLogin;
  window.WTS_AUTH_READY = bootstrap();
})();
