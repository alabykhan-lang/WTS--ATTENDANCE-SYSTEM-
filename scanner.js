"use strict";
(() => {
  const EDGE_URL =
    "https://wuftzyeajmsxdrbwaawl.supabase.co/functions/v1/attendance-scan";
  const CONFIG_KEY = "wts_attendance_scanner_config_v1";
  const SECRET_KEY = "wts_attendance_scanner_secret_v1";
  const QUEUE_KEY = "wts_attendance_scanner_queue_v1";
  const MAX_QUEUE = 200;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const query = new URLSearchParams(window.location.search);
  const requestedEvent = query.get("event");
  const initialEvent = ["check_in", "check_out"].includes(requestedEvent) ? requestedEvent : "check_in";
  const sourceLabels = {
    qr: "QR",
  };
  const sourceHelp = {
    qr: [
      "Automatic QR camera",
      "Camera permission needed",
      "Allow the camera once. It will stay ready and read each QR code automatically.",
      "Allow and start camera",
    ],
  };
  const friendly = {
    DEVICE_AUTH_REQUIRED: "Device code and secret are required.",
    DEVICE_AUTH_FAILED: "This device code or secret is not valid.",
    DEVICE_INACTIVE: "This device is inactive.",
    DEVICE_SCAN_DISABLED: "Scanning has been disabled for this device.",
    DEVICE_PERSON_SCOPE_DENIED: "This device cannot record this person type.",
    DEVICE_INTEGRITY_REQUIRED:
      "This device requires a verified native scanner.",
    DEVICE_LOCATION_REQUIRED: "Location is required for this device.",
    DEVICE_OUTSIDE_SCHOOL_GEOFENCE:
      "This scanner is outside the approved school location.",
    INSTALLATION_ID_REQUIRED: "This device requires an installation identity.",
    INSTALLATION_MISMATCH: "This scanner is locked to another installation.",
    SOURCE_NOT_SUPPORTED_BY_DEVICE:
      "QR capture is not enabled for this device.",
    OFFLINE_SYNC_NOT_ENABLED:
      "Offline synchronisation is not enabled for this device.",
    UNKNOWN_OR_INACTIVE_CREDENTIAL:
      "This QR code is unknown, suspended or expired.",
    STUDENT_INACTIVE: "This student is not active.",
    STAFF_INACTIVE: "This staff member is not active.",
    OUTSIDE_CHECK_IN_WINDOW:
      "Check-in is outside the configured attendance time.",
    CHECK_OUT_NOT_OPEN: "Checkout is not open yet.",
    INVALID_CREDENTIAL: "The scanned credential is invalid.",
    NETWORK_ERROR: "The attendance service could not be reached.",
  };
  const state = {
    config: null,
    secret: "",
    eventType: initialEvent,
    cameraStream: null,
    cameraLoop: 0,
    cameraBusy: false,
    cameraPaused: false,
    lastCameraValue: "",
    cameraClearFrames: 0,
    wakeLock: null,
    wakeRetryTimer: 0,
    cameraRestartTimer: 0,
    installPrompt: null,
    syncing: false,
    lastFingerprint: "",
    lastScanAt: 0,
    nativeDetectPromise: null,
  };

  function parse(value, fallback) {
    if (value == null || value === "") return fallback;
    try {
      return JSON.parse(value) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function loadQueue() {
    const value = parse(localStorage.getItem(QUEUE_KEY), []);
    return Array.isArray(value) ? value : [];
  }
  function saveQueue(queue) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
    renderQueue();
  }
  function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function base64ToBytes(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }
  function toast(message, type = "") {
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    $("#toasts").append(item);
    setTimeout(() => item.remove(), 4200);
  }
  function codeMessage(code, message) {
    return (
      friendly[code] ||
      message ||
      String(code || "Attendance request failed.").replaceAll("_", " ")
    );
  }
  function createId() {
    return (
      crypto.randomUUID?.() ||
      `${Date.now().toString(16)}-0000-4000-8000-${crypto.getRandomValues(new Uint32Array(2)).join("")}`
    );
  }
  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return bytesToBase64(new Uint8Array(digest));
  }
  async function queueKey() {
    const raw = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${state.secret}:${state.config.installationId}`),
    );
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async function encryptQueuePayload(payload) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await queueKey();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(payload)),
    );
    return {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
  }
  async function decryptQueuePayload(item) {
    const key = await queueKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(item.iv) },
      key,
      base64ToBytes(item.ciphertext),
    );
    return parse(decoder.decode(plaintext), {});
  }

  function loadConfiguration() {
    const config = parse(localStorage.getItem(CONFIG_KEY), null);
    const secret =
      sessionStorage.getItem(SECRET_KEY) ||
      localStorage.getItem(SECRET_KEY) ||
      "";
    if (config?.deviceCode && config?.installationId && secret) {
      state.config = {
        deviceCode: config.deviceCode,
        source: "qr",
        installationId: config.installationId,
      };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
      state.secret = secret;
      return true;
    }
    if (config?.deviceCode) {
      $("#deviceCode").value = config.deviceCode;
    }
    return false;
  }

  function persistConfiguration({ deviceCode, secret }) {
    const previous = parse(localStorage.getItem(CONFIG_KEY), {});
    const config = {
      deviceCode,
      source: "qr",
      installationId: previous.installationId || createId(),
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    sessionStorage.setItem(SECRET_KEY, secret);
    localStorage.removeItem(SECRET_KEY);
    state.config = config;
    state.secret = secret;
  }

  function openScanner() {
    $("#setupCard").hidden = true;
    $("#scannerApp").hidden = false;
    $("#connectedDevice").textContent = state.config.deviceCode;
    $("#installationPreview").textContent = state.config.installationId;
    $$('[data-event]').forEach((button) => button.classList.toggle("active", button.dataset.event === state.eventType));
    setSource(state.config.source || "qr");
    renderQueue();
    updateNetwork();
    requestWakeLock();
    window.setTimeout(() => startActiveReader(true), 120);
  }

  function setSource(source) {
    stopCamera(false);
    state.config.source = "qr";
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    $("#sourceBadge").textContent =
      sourceLabels[source] || source.toUpperCase();
    const copy = sourceHelp[source] || sourceHelp.qr;
    $("#scanTitle").textContent = copy[0];
    $("#tapTitle").textContent = copy[1];
    $("#tapHelp").textContent = copy[2];
    $("#startScan").textContent = copy[3] || copy[1];
    $("#scanIcon").textContent = "▣";
    $("#credentialInput").placeholder = "Enter a QR value only if the camera cannot be used";
    $(".reader-fallback").open = false;
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.hidden || state.wakeLock) return;
    if (state.wakeRetryTimer) window.clearTimeout(state.wakeRetryTimer);
    state.wakeRetryTimer = 0;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
        if (!document.hidden && state.config) {
          state.wakeRetryTimer = window.setTimeout(requestWakeLock, 15000);
        }
      });
    } catch {
      if (!document.hidden && state.config) {
        state.wakeRetryTimer = window.setTimeout(requestWakeLock, 30000);
      }
    }
  }

  function startActiveReader(automatic = false) {
    if (!state.config) return;
    return startCamera(automatic);
  }

  function updateNetwork() {
    const pill = $("#networkPill"),
      online = navigator.onLine;
    pill.classList.toggle("online", online);
    pill.classList.toggle("offline", !online);
    pill.querySelector("span").textContent = online ? "Online" : "Offline";
    if (online && loadQueue().some((item) => item.status !== "failed"))
      syncQueue();
  }

  function renderQueue() {
    const queue = loadQueue(),
      failed = queue.filter((item) => item.status === "failed").length,
      pending = queue.length - failed;
    $("#queueCount").textContent = queue.length;
    $("#queueMessage").textContent = queue.length
      ? `${pending} pending and ${failed} failed event(s).`
      : "No events are waiting.";
    $("#syncQueue").disabled = !queue.length || state.syncing;
    $("#clearFailed").hidden = !failed;
    $("#queueList").innerHTML = queue
      .slice(-8)
      .reverse()
      .map(
        (item) =>
          `<div class="queue-item ${item.status === "failed" ? "failed" : ""}"><div><b>${item.eventType === "check_out" ? "Afternoon closing" : "Morning arrival"}</b><small> • QR scanner</small></div><small>${item.status === "failed" ? item.lastError || "Failed" : new Date(item.localRecordedAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}</small></div>`,
      )
      .join("");
  }

  async function requestGateway(body) {
    let response;
    try {
      response = await fetch(EDGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wts-device-code": state.config.deviceCode,
          "x-wts-device-secret": state.secret,
          "x-wts-installation-id": state.config.installationId,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw Object.assign(new Error("NETWORK_ERROR"), {
        code: "NETWORK_ERROR",
        network: true,
        cause: error,
      });
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = { ok: false, code: "INVALID_SERVER_RESPONSE" };
    }
    if (!response.ok || data?.ok === false)
      throw Object.assign(new Error(codeMessage(data?.code, data?.message)), {
        code: data?.code || "ATTENDANCE_REQUEST_FAILED",
        status: response.status,
        data,
        permanent:
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 425, 429].includes(response.status),
      });
    return data;
  }

  async function queueCredential(credential, options) {
    const encrypted = await encryptQueuePayload({
      credential,
      note: `Original scanner source: ${options.source}`,
    });
    const queue = loadQueue();
    queue.push({
      id: options.clientEventId,
      eventType: options.eventType,
      originalSource: options.source,
      localRecordedAt: options.localRecordedAt,
      status: "pending",
      lastError: "",
      ...encrypted,
    });
    saveQueue(queue);
    showResult(
      "warning",
      "QUEUED OFFLINE",
      "Attendance event saved",
      `It will synchronise automatically when this phone is online.`,
    );
    toast("Attendance event queued for synchronisation.");
  }

  async function submitCredential(raw) {
    const credential = String(raw || "").trim();
    if (!credential.length)
      return (
        showResult(
          "error",
          "INVALID CREDENTIAL",
          "Card not accepted",
          "The reader returned an empty value.",
        ),
        beep(false)
      );
    const fingerprint = await sha256(`${state.eventType}:${credential}`),
      now = Date.now();
    if (fingerprint === state.lastFingerprint && now - state.lastScanAt < 7000)
      return toast("Duplicate scan ignored.");
    state.lastFingerprint = fingerprint;
    state.lastScanAt = now;
    const options = {
      clientEventId: createId(),
      eventType: state.eventType,
      source: state.config.source,
      localRecordedAt: new Date().toISOString(),
    };
    showResult("idle", "CHECKING", "Verifying credential", "Please wait…");
    if (!navigator.onLine) {
      try {
        await queueCredential(credential, options);
      } catch (error) {
        showResult(
          "error",
          error.code || "OFFLINE",
          "Internet connection required",
          error.message,
        );
        beep(false);
      } finally {
        $("#credentialInput").value = "";
      }
      return;
    }
    try {
      const body = {
        credential,
        clientEventId: options.clientEventId,
        eventType: options.eventType,
        source: options.source,
        localRecordedAt: options.localRecordedAt,
      };
      const data = await requestGateway(body);
      showGatewayResult(data);
      beep(true);
    } catch (error) {
      if (error.network) {
        try {
          await queueCredential(credential, options);
          return;
        } catch (queueError) {
          error = queueError;
        }
      }
      showResult(
        "error",
        error.code || "FAILED",
        "Scan rejected",
        codeMessage(error.code, error.message),
      );
      beep(false);
    } finally {
      $("#credentialInput").value = "";
    }
  }

  function showGatewayResult(data) {
    const person = data.student || data.staff || {},
      name = person.name || person.full_name || "Verified person",
      number = person.admno || person.staff_number || "",
      detail = person.class_key || person.designation || person.category || "";
    const status =
      data.event?.attendance_status ||
      data.attendance_status ||
      data.daily_status ||
      "verified";
    const description = `${status.replaceAll("_", " ")}${number ? ` • ${number}` : ""}${detail ? ` • ${detail}` : ""}`;
    showResult(
      "success",
      String(data.code || status).replaceAll("_", " "),
      name,
      description,
    );
  }

  function showResult(type, code, name, detail) {
    const card = $("#resultCard");
    card.className = `result-card ${type}`;
    $("#resultMark").textContent =
      type === "success"
        ? "✓"
        : type === "error"
          ? "×"
          : type === "warning"
            ? "!"
            : "•";
    $("#resultCode").textContent = code;
    $("#resultName").textContent = name;
    $("#resultDetail").textContent = detail;
  }
  function beep(success) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext,
        context = new AudioContext(),
        oscillator = context.createOscillator(),
        gain = context.createGain();
      oscillator.frequency.value = success ? 880 : 220;
      gain.gain.setValueAtTime(0.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
    } catch {}
  }

  function decodeQrRegion(
    jsQR,
    canvas,
    context,
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
  ) {
    if (!context) return "";
    const width = Math.max(1, Math.round(sourceWidth));
    const height = Math.max(1, Math.round(sourceHeight));
    const x = Math.max(0, Math.round(sourceX));
    const y = Math.max(0, Math.round(sourceY));
    const scale = Math.min(1, 1280 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    try {
      context.drawImage(
        video,
        x,
        y,
        width,
        height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      return (
        jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: "attemptBoth",
        })?.data || ""
      );
    } catch {
      return "";
    }
  }

  async function detectNativeQrFrame(video, nativeDetector) {
    if (!nativeDetector || state.nativeDetectPromise) return "";
    const detection = Promise.resolve().then(() => nativeDetector.detect(video));
    state.nativeDetectPromise = detection;
    const timeout = new Promise((resolve) =>
      window.setTimeout(() => resolve(null), 150),
    );
    try {
      const codes = await Promise.race([detection, timeout]);
      const value = Array.isArray(codes)
        ? codes.find((code) => code?.rawValue)?.rawValue || ""
        : "";
      return value;
    } catch {
      return "";
    } finally {
      detection
        .finally(() => {
          if (state.nativeDetectPromise === detection)
            state.nativeDetectPromise = null;
        })
        .catch(() => {});
    }
  }

  async function detectQrFrame(video, nativeDetector) {
    if (!video.videoWidth || !video.videoHeight) return "";

    const jsQR = window.WTS_VENDOR?.jsQR;
    if (!jsQR) return detectNativeQrFrame(video, nativeDetector);
    const canvas = $("#cameraCanvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const focusWidth = Math.min(
      video.videoWidth,
      Math.max(1, Math.round(video.videoHeight * 0.78)),
    );
    const focusHeight = Math.min(
      video.videoHeight,
      Math.max(1, Math.round(video.videoWidth / 0.78)),
    );
    const focusX = Math.max(
      0,
      Math.round((video.videoWidth - focusWidth) / 2),
    );
    const focusY = Math.max(
      0,
      Math.round((video.videoHeight - focusHeight) / 2),
    );

    // Decode the same centered region a user would see after camera zoom.
    const focusedValue = decodeQrRegion(
      jsQR,
      canvas,
      context,
      video,
      focusX,
      focusY,
      focusWidth,
      focusHeight,
    );
    if (focusedValue) return focusedValue;

    // Keep a full-frame pass for cards that are not perfectly centered.
    const fullFrameValue = decodeQrRegion(
      jsQR,
      canvas,
      context,
      video,
      0,
      0,
      video.videoWidth,
      video.videoHeight,
    );
    if (fullFrameValue) return fullFrameValue;

    // Native detection is last and time-limited so it cannot block jsQR.
    return detectNativeQrFrame(video, nativeDetector);
  }

  async function tuneCameraTrack(stream) {
    const track = stream.getVideoTracks()[0];
    if (!track?.getCapabilities || !track.applyConstraints) return;
    const capabilities = track.getCapabilities();

    if (
      Array.isArray(capabilities.focusMode) &&
      capabilities.focusMode.includes("continuous")
    ) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" }],
        });
      } catch {}
    }

    const zoom = capabilities.zoom;
    const min = Number(zoom?.min);
    const max = Number(zoom?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    const desired = Math.min(2, max);
    if (desired <= min) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: desired }] });
    } catch {}
  }

  async function startCamera(automatic = false) {
    if (state.cameraStream) return;
    if (state.cameraRestartTimer) window.clearTimeout(state.cameraRestartTimer);
    state.cameraRestartTimer = 0;
    state.cameraPaused = false;
    if (!navigator.mediaDevices?.getUserMedia)
      return showResult(
        "error",
        "CAMERA_UNAVAILABLE",
        "Camera scanner unavailable",
        "Use the credential input or a connected reader.",
      );
    if (!("BarcodeDetector" in window) && !window.WTS_VENDOR?.jsQR)
      return showResult(
        "error",
        "QR_NOT_SUPPORTED",
        "QR detection is unavailable",
        "This browser cannot read QR codes. Use a current browser or a connected reader.",
      );
    try {
      let detector = null;
      if ("BarcodeDetector" in window) {
        try {
          detector = new BarcodeDetector({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      const video = $("#cameraVideo");
      video.srcObject = state.cameraStream;
      const activeStream = state.cameraStream;
      activeStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (state.cameraStream !== activeStream || state.cameraPaused || document.hidden) return;
        stopCamera(false);
        state.cameraRestartTimer = window.setTimeout(() => startCamera(true), 1500);
      });
      await tuneCameraTrack(state.cameraStream);
      await video.play();
      $("#cameraBox").hidden = false;
      $("#tapZone").hidden = true;
      $("#startScan").hidden = true;
      $("#cameraStatus").textContent = "Camera active · Center the QR inside the frame";
      requestWakeLock();
      let lastCheck = 0;
      const loop = async (timestamp) => {
        if (!state.cameraStream) return;
        if (timestamp - lastCheck > 180) {
          lastCheck = timestamp;
          try {
            const value = await detectQrFrame(video, detector);
            if (value) {
              state.cameraClearFrames = 0;
              if (!state.cameraBusy && value !== state.lastCameraValue) {
                state.cameraBusy = true;
                state.lastCameraValue = value;
                $("#cameraStatus").textContent = "Card found · Recording attendance…";
                try {
                  await submitCredential(value);
                  $("#cameraStatus").textContent = "Ready for the next QR code · Remove this QR first";
                } finally {
                  state.cameraBusy = false;
                }
              }
            } else if (state.lastCameraValue) {
              state.cameraClearFrames += 1;
              if (state.cameraClearFrames >= 4) {
                state.lastCameraValue = "";
                state.cameraClearFrames = 0;
                $("#cameraStatus").textContent = "Camera active · Show the QR code";
              }
            }
          } catch {}
        }
        state.cameraLoop = requestAnimationFrame(loop);
      };
      state.cameraLoop = requestAnimationFrame(loop);
    } catch (error) {
      stopCamera(false);
      showResult(
        "error",
        "CAMERA_PERMISSION",
        "Camera could not start",
        automatic ? "Tap “Allow and start camera”, then approve camera access once." : error?.message || "Allow camera access and try again.",
      );
      beep(false);
    }
  }

  function stopCamera(manual = true) {
    state.cameraPaused = manual;
    if (manual && state.cameraRestartTimer) window.clearTimeout(state.cameraRestartTimer);
    if (manual) state.cameraRestartTimer = 0;
    if (state.cameraLoop) cancelAnimationFrame(state.cameraLoop);
    state.cameraLoop = 0;
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }
    const box = $("#cameraBox");
    if (box) {
      box.hidden = true;
      $("#tapZone").hidden = false;
      $("#startScan").hidden = false;
      if (manual) {
        $("#tapTitle").textContent = "Camera paused";
        $("#tapHelp").textContent = "Tap below to start automatic scanning again.";
        $("#startScan").textContent = "Resume automatic camera";
      }
    }
  }

  async function syncQueue() {
    if (state.syncing || !navigator.onLine || !state.config || !state.secret)
      return;
    state.syncing = true;
    renderQueue();
    let queue = loadQueue();
    for (const item of queue) {
      if (!navigator.onLine) break;
      try {
        const payload = await decryptQueuePayload(item);
        const data = await requestGateway({
          credential: payload.credential,
          clientEventId: item.id,
          eventType: item.eventType,
          source: "offline_sync",
          localRecordedAt: item.localRecordedAt,
          note: payload.note,
        });
        queue = queue.filter((candidate) => candidate.id !== item.id);
        saveQueue(queue);
        showGatewayResult(data);
      } catch (error) {
        const target = queue.find((candidate) => candidate.id === item.id);
        if (target) {
          target.lastError = codeMessage(error.code, error.message);
          if (error.permanent) target.status = "failed";
          saveQueue(queue);
        }
        if (error.network) break;
      }
    }
    state.syncing = false;
    renderQueue();
    if (!queue.length) toast("Offline attendance synchronised.", "success");
  }

  function saveSettings() {
    state.config.source = "qr";
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    sessionStorage.setItem(SECRET_KEY, state.secret);
    setSource("qr");
    $("#settingsDialog").close();
    toast("Scanner settings saved.", "success");
    window.setTimeout(() => startActiveReader(true), 100);
  }

  function forgetDevice() {
    if (
      !confirm(
        "Forget this scanner and remove its offline queue from this phone?",
      )
    )
      return;
    stopCamera();
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(SECRET_KEY);
    localStorage.removeItem(QUEUE_KEY);
    sessionStorage.removeItem(SECRET_KEY);
    location.reload();
  }

  $("#setupForm").onsubmit = (event) => {
    event.preventDefault();
    const deviceCode = $("#deviceCode").value.trim(),
      secret = $("#deviceSecret").value;
    if (!deviceCode || secret.length < 16) {
      $("#setupError").textContent =
        "Enter the complete device code and one-time device secret.";
      return;
    }
    persistConfiguration({ deviceCode, secret });
    $("#setupError").textContent = "";
    openScanner();
    toast("Scanner connected. It is ready for server-confirmed attendance.", "success");
  };
  $$("[data-event]").forEach(
    (button) =>
      (button.onclick = () => {
        state.eventType = button.dataset.event;
        $$("[data-event]").forEach((item) =>
          item.classList.toggle("active", item === button),
        );
      }),
  );
  $("#startScan").onclick = () => startActiveReader(false);
  $("#tapZone").onclick = $("#startScan").onclick;
  $("#stopCamera").onclick = () => stopCamera(true);
  $("#readerForm").onsubmit = (event) => {
    event.preventDefault();
    submitCredential($("#credentialInput").value);
  };
  $("#openSettings").onclick = () => $("#settingsDialog").showModal();
  $("#saveSettings").onclick = saveSettings;
  $("#installScanner").onclick = async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    $("#installScanner").hidden = true;
  };
  $("#forgetDevice").onclick = forgetDevice;
  $("#syncQueue").onclick = syncQueue;
  $("#clearFailed").onclick = () => {
    const failed = loadQueue().filter(
      (item) => item.status === "failed",
    ).length;
    if (failed && confirm(`Remove ${failed} failed offline event(s)?`))
      saveQueue(loadQueue().filter((item) => item.status !== "failed"));
  };
  window.addEventListener("online", updateNetwork);
  window.addEventListener("offline", updateNetwork);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera(false);
    else {
      requestWakeLock();
      if (state.config?.source === "qr" && !state.cameraPaused) startCamera(true);
    }
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    $("#installScanner").hidden = false;
  });
  if ("serviceWorker" in navigator)
    navigator.serviceWorker
      .register("/scanner-sw.js", { scope: "/" })
      .catch(() => {});
  updateNetwork();
  if (loadConfiguration()) openScanner();
  else $("#deviceCode").focus();
})();
