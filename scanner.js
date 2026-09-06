"use strict";
(() => {
  const EDGE_URL = "https://wuftzyeajmsxdrbwaawl.supabase.co/functions/v1/attendance-scan";
  const CONFIG_KEY = "wts_attendance_scanner_v2";
  const QUEUE_KEY = "wts_attendance_scanner_queue_v2";
  const BROWSER_ID_KEY = "wts_attendance_browser_installation_v2";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const requested = new URLSearchParams(location.search).get("event");
  const state = {
    config: null,
    eventType: requested === "check_out" ? "check_out" : "check_in",
    stream: null, frame: 0, busy: false, lastValue: "", lastTime: 0, detector: null,
  };

  function parse(value, fallback) { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } }
  function uuid() { return crypto.randomUUID(); }
  function browserId() { let id = localStorage.getItem(BROWSER_ID_KEY); if (!id) { id = `${uuid()}:${uuid()}`; localStorage.setItem(BROWSER_ID_KEY, id); } return id; }
  function loadQueue() { const queue = parse(localStorage.getItem(QUEUE_KEY), []); return Array.isArray(queue) ? queue : []; }
  function saveQueue(queue) { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-300))); renderQueue(); }
  function base64(bytes) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
  function bytes(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }

  async function queueKey() {
    const raw = await crypto.subtle.digest("SHA-256", encoder.encode(`${state.config.installationToken}:${state.config.installationId}`));
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  async function encrypt(payload) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await queueKey(), encoder.encode(JSON.stringify(payload)));
    return { iv: base64(iv), data: base64(new Uint8Array(ciphertext)) };
  }
  async function decrypt(item) {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(item.iv) }, await queueKey(), bytes(item.data));
    return parse(decoder.decode(plaintext), {});
  }

  function toast(message, tone = "") { const item = document.createElement("div"); item.className = `toast ${tone}`; item.textContent = message; $("#toasts").append(item); setTimeout(() => item.remove(), 4200); }
  function message(code) {
    return ({
      SCANNER_PASSWORD_INVALID: "The scanner password is incorrect.", SCANNER_PASSWORD_NOT_SET: "Set the scanner password in Setup first.",
      SCANNER_REGISTRATION_INVALID: "This phone was disconnected. Register it again.", ADMIN_PASSWORD_INVALID: "The administrative password is incorrect.",
      UNRECOGNISED_QR: "This QR is not active.", EARLY_CLOSING_REASON_REQUIRED: "Enter a reason for closing before 3:30 PM.",
      DUPLICATE_IGNORED: "Already recorded for this person and period.", NETWORK_ERROR: "No connection. The scan was saved on this phone.",
    })[code] || String(code || "Attendance request failed").replaceAll("_", " ");
  }

  async function request(body, registration = false) {
    let response;
    try {
      response = await fetch(EDGE_URL, {
        method: "POST", headers: {
          "Content-Type": "application/json",
          ...(registration ? {} : { "x-wts-installation-id": state.config.installationId, "x-wts-installation-token": state.config.installationToken }),
        }, body: JSON.stringify(body),
      });
    } catch (cause) {
      throw Object.assign(new Error("NETWORK_ERROR"), { code: "NETWORK_ERROR", network: true, cause });
    }
    const data = await response.json().catch(() => ({ ok: false, code: "INVALID_RESPONSE" }));
    if (!response.ok || data?.ok === false) throw Object.assign(new Error(message(data?.code)), { code: data?.code, permanent: response.status >= 400 && response.status < 500, data });
    return data;
  }

  async function register(event) {
    event.preventDefault();
    $("#setupError").textContent = "Registering…";
    try {
      const data = await request({ action: "register", scannerPassword: $("#scannerPassword").value, browserInstallationId: browserId(), deviceName: $("#deviceName").value }, true);
      state.config = { installationId: data.installationId, installationToken: data.installationToken, deviceName: data.deviceName };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
      $("#scannerPassword").value = "";
      openScanner();
    } catch (error) { $("#setupError").textContent = message(error.code); }
  }

  function openScanner() {
    $("#setupCard").hidden = true; $("#scannerApp").hidden = false;
    $("#connectedDevice").textContent = state.config.deviceName;
    $$('[data-event]').forEach((button) => button.classList.toggle("active", button.dataset.event === state.eventType));
    updateNetwork(); renderQueue(); setTimeout(startCamera, 100);
  }

  function updateNetwork() {
    const online = navigator.onLine;
    $("#networkPill").classList.toggle("online", online); $("#networkPill").classList.toggle("offline", !online);
    $("#networkPill span").textContent = online ? "Online" : "Offline";
  }

  function renderQueue() {
    const queue = loadQueue();
    $("#queueCount").textContent = queue.length;
    $("#queueMessage").textContent = queue.length ? `${queue.length} record(s) waiting. Administrative approval is required.` : "No records waiting.";
    $("#syncQueue").disabled = !queue.length;
    $("#queueList").innerHTML = queue.slice(-8).reverse().map((item) => `<div class="queue-item"><b>${item.eventType === "check_out" ? "Afternoon closing" : "Morning arrival"}</b><small>${new Date(item.recordedAt).toLocaleString("en-NG")}</small></div>`).join("");
  }

  function locationSnapshot() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({});
      const timeout = setTimeout(() => resolve({}), 4500);
      navigator.geolocation.getCurrentPosition((position) => { clearTimeout(timeout); resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, locationAccuracyMetres: position.coords.accuracy, locationCapturedAt: new Date(position.timestamp).toISOString() }); }, () => { clearTimeout(timeout); resolve({}); }, { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 });
    });
  }

  function beforeClosingTime() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return (parts.hour * 60 + parts.minute) < (15 * 60 + 30);
  }

  function askEarlyReason() {
    if (state.eventType !== "check_out" || !beforeClosingTime()) return Promise.resolve("");
    const dialog = $("#earlyReasonDialog"), form = $("#earlyReasonForm"), input = $("#earlyReason");
    input.value = "";
    return new Promise((resolve) => {
      const close = () => { form.removeEventListener("submit", submit); dialog.removeEventListener("close", close); if (dialog.returnValue !== "default") resolve(null); };
      const submit = (event) => { event.preventDefault(); if (!input.value.trim()) return; form.removeEventListener("submit", submit); dialog.removeEventListener("close", close); dialog.close("default"); resolve(input.value.trim()); };
      form.addEventListener("submit", submit); dialog.addEventListener("close", close, { once: true }); dialog.showModal(); input.focus();
    });
  }

  function showResult(tone, code, name, detail) {
    $("#resultCard").className = `result-card ${tone}`; $("#resultCode").textContent = code; $("#resultName").textContent = name; $("#resultDetail").textContent = detail;
    $("#resultMark").textContent = tone === "success" ? "✓" : tone === "warning" ? "!" : "×";
  }

  async function queueScan(payload) {
    const protectedPayload = await encrypt(payload);
    const queue = loadQueue(); queue.push({ id: payload.clientEventId, eventType: payload.eventType, recordedAt: payload.recordedAt, ...protectedPayload }); saveQueue(queue);
    showResult("warning", "SAVED OFFLINE", "QR recorded on phone", "Use Sync with admin password when the phone is online.");
  }

  async function submit(raw) {
    const credential = String(raw || "").trim();
    if (!credential || state.busy) return;
    if (credential === state.lastValue && Date.now() - state.lastTime < 7000) return;
    state.lastValue = credential; state.lastTime = Date.now(); state.busy = true;
    try {
      const reason = await askEarlyReason();
      if (reason === null) return;
      const payload = { credential, clientEventId: uuid(), eventType: state.eventType, recordedAt: new Date().toISOString(), reason, ...(await locationSnapshot()) };
      if (!navigator.onLine) return await queueScan(payload);
      try {
        const data = await request(payload);
        const duplicate = data.code === "DUPLICATE_IGNORED";
        showResult(duplicate ? "warning" : "success", duplicate ? "ALREADY RECORDED" : "RECORDED", data.person_name || "Attendance accepted", duplicate ? "Only one scan is kept for each AM/PM period." : `${data.person_type || "Person"} · ${data.session_slot || "period"}`);
      } catch (error) {
        if (error.network) await queueScan(payload); else showResult("error", error.code || "NOT RECORDED", "Scan rejected", message(error.code));
      }
    } finally { state.busy = false; }
  }

  async function syncQueue() {
    if (!navigator.onLine) return toast("Connect to the internet first.", "error");
    const queue = loadQueue(); if (!queue.length) return;
    const dialog = $("#syncDialog"), form = $("#syncForm"), input = $("#syncAdminPassword"); input.value = ""; dialog.showModal(); input.focus();
    const adminPassword = await new Promise((resolve) => {
      const close = () => { form.removeEventListener("submit", submit); if (dialog.returnValue !== "default") resolve(null); };
      const submit = (event) => { event.preventDefault(); const password = input.value; form.removeEventListener("submit", submit); dialog.removeEventListener("close", close); dialog.close("default"); resolve(password); };
      form.addEventListener("submit", submit); dialog.addEventListener("close", close, { once: true });
    });
    if (!adminPassword) return;
    $("#syncQueue").disabled = true;
    const remaining = [];
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      try { const payload = await decrypt(item); await request({ ...payload, offlineSync: true, adminPassword }); }
      catch (error) {
        remaining.push(item);
        if (error.code === "ADMIN_PASSWORD_INVALID") {
          remaining.push(...queue.slice(index + 1));
          toast(message(error.code), "error");
          break;
        }
      }
    }
    saveQueue(remaining); input.value = "";
    toast(remaining.length ? `${remaining.length} record(s) still waiting.` : "Offline attendance synchronized.", remaining.length ? "warning" : "success");
  }

  async function startCamera() {
    if (!("BarcodeDetector" in window) && !window.WTS_VENDOR?.jsQR) { $("#tapZone").hidden = false; $("#startScan").textContent = "Use connected QR reader below"; return; }
    try {
      if ("BarcodeDetector" in window && !state.detector) state.detector = new BarcodeDetector({ formats: ["qr_code"] });
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      $("#cameraVideo").srcObject = state.stream; await $("#cameraVideo").play();
      $("#cameraBox").hidden = false; $("#tapZone").hidden = true; $("#startScan").hidden = true;
      detectFrame();
    } catch { toast("Camera unavailable. Use the connected QR reader.", "warning"); }
  }

  async function detectFrame() {
    if (!state.stream) return;
    try {
      if (state.detector) {
        const codes = await state.detector.detect($("#cameraVideo"));
        if (codes[0]?.rawValue) await submit(codes[0].rawValue);
      } else {
        const video = $("#cameraVideo"), canvas = $("#cameraCanvas"), context = canvas.getContext("2d", { willReadFrequently: true });
        if (video.videoWidth && video.videoHeight) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight; context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.WTS_VENDOR.jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
          if (code?.data) await submit(code.data);
        }
      }
    } catch {}
    state.frame = requestAnimationFrame(detectFrame);
  }

  function forgetPhone() {
    if (!confirm("Forget this registered phone? Unsynchronized records on it will also be removed.")) return;
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    localStorage.removeItem(CONFIG_KEY); localStorage.removeItem(QUEUE_KEY); location.reload();
  }

  $("#setupForm").addEventListener("submit", register);
  $$('[data-event]').forEach((button) => button.addEventListener("click", () => { state.eventType = button.dataset.event; $$('[data-event]').forEach((item) => item.classList.toggle("active", item === button)); }));
  $("#readerForm").addEventListener("submit", (event) => { event.preventDefault(); const input = $("#credentialInput"); submit(input.value); input.value = ""; input.focus(); });
  $("#startScan").onclick = startCamera; $("#syncQueue").onclick = syncQueue; $("#forgetDevice").onclick = forgetPhone;
  addEventListener("online", updateNetwork); addEventListener("offline", updateNetwork);
  state.config = parse(localStorage.getItem(CONFIG_KEY), null);
  if (state.config?.installationId && state.config?.installationToken) openScanner(); else updateNetwork();
})();
