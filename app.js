"use strict";
(() => {
  const CFG = window.WTS_CONFIG;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = {
    connected: false,
    context: null,
    summary: null,
    devices: [],
    students: [],
    staff: [],
    selectedPerson: null,
    import: { batchId: null, rows: [], selectedRowId: null, file: null },
    mapPeople: [],
    lastQr: null,
    lastQrPersonId: null,
    lastQrCards: [],
    cardBatchBusy: false,
    rosterSync: null,
  };

  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
  const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
  const cleanStatus = (value) => String(value || "incomplete").replaceAll("_", " ");
  const statusClass = (value) => String(value || "incomplete").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const personPhoto = (person) => person?.photo || person?.photo_url || person?.profile_photo_url || person?.avatar_url || "";
  const avatarMarkup = (person, fallback = "W") => personPhoto(person) ? `<img src="${esc(personPhoto(person))}" alt="">` : esc((person?.displayName || fallback).slice(0, 1).toUpperCase());
  const dateInput = (value) => value ? String(value).slice(0, 10) : "";
  const displayDate = (value) => {
    if (!value) return "—";
    const date = new Date(`${dateInput(value)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
  };
  const displayTime = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
  };
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const monthStart = () => `${todayIso().slice(0, 7)}-01`;
  const permission = (name) => {
    const permissions = state.context?.permissions || [];
    return permissions.includes("*") || permissions.includes(name);
  };
  const globalScope = () => permission("settings.manage") || permission("*");

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    $("#toasts")?.append(node);
    window.setTimeout(() => node.remove(), 4800);
  }

  async function rpc(name, action, payload = {}) {
    const response = await fetch("/api/rpc", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name, action, payload }),
    });
    let data;
    try { data = await response.json(); } catch { throw new Error("Invalid Attendance server response."); }
    if (!response.ok || data?.ok === false) {
      const friendlyErrors = {
        ADMIN_PERMISSION_DENIED: "Your school account is not allowed to use this part of Attendance.",
        ADMIN_REQUIRED: "Your school account is not allowed to use this part of Attendance.",
        DEVICE_NAME_REQUIRED: "Give the device a clear name, such as Main Gate Phone.",
        DEVICE_CODE_EXISTS: "That device code is already in use. Create a new code and try again.",
        INVALID_DEVICE_METHOD: "Choose whether the device reads QR codes, NFC cards, or both.",
        CREDENTIAL_ALREADY_ASSIGNED: "This card is already linked to somebody else.",
        QR_REPRINT_UNAVAILABLE: "This older QR card cannot be reprinted from the portal. Use Replace card once to create a reprint-safe card.",
        QR_CREDENTIAL_NOT_REPLACEABLE: "That QR card has already been replaced or expired.",
        QR_REPLACEMENT_FAILED: "The replacement did not complete, so the old card was left unchanged.",
        PERSON_TYPE_REQUIRED: "Choose Students or Staff before searching.",
      };
      const error = new Error(data?.message || friendlyErrors[data?.code] || "Attendance could not complete that request.");
      error.code = data?.code;
      throw error;
    }
    return data;
  }

  const universalRead = (action, payload = {}) => rpc("attendance_universal_admin_read_api", action, payload);
  const universalWrite = (action, payload = {}) => rpc("attendance_universal_admin_write_api", action, payload);
  const qrWrite = (action, payload = {}) => rpc("attendance_qr_card_api", action, payload);
  const controlsWrite = (action, payload = {}) => rpc("attendance_controls_admin_write_api", action, payload);

  function connected(value, message = "") {
    state.connected = value;
    document.body.classList.toggle("locked", !value);
    $("#dot")?.classList.toggle("on", value);
    if ($("#connectionText")) $("#connectionText").textContent = value ? "Live central access" : "Central access required";
    if ($("#contextPill")) $("#contextPill").textContent = value ? `${state.context?.session || "Session"} · ${state.context?.term || "Term"}` : "Checking context";
    if ($("#login")) $("#login").textContent = value ? "Sign out" : "Administrator login";
    if ($("#authError")) $("#authError").textContent = message;
  }

  async function signOut() {
    await fetch("/api/sso-logout", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" }).catch(() => {});
    state.connected = false;
    state.context = null;
    state.summary = null;
    connected(false);
    window.location.assign(CFG.postLogoutUri);
  }

  function setOptions(selector, options, placeholder = "") {
    const select = $(selector);
    if (!select) return;
    const selected = select.value;
    select.innerHTML = `${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}${options.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("")}`;
    if (options.some((option) => String(option.value) === selected)) select.value = selected;
  }

  function contextClasses() {
    const classes = (state.context?.classes || []).map((item) => ({ value: item.class_key || item.key, label: item.display_name || item.class_key || item.key })).filter((item) => item.value);
    if (!globalScope() && (state.context?.class_scope || []).length) return classes.filter((item) => state.context.class_scope.includes(item.value));
    return classes;
  }

  function fillClassSelectors() {
    const options = contextClasses();
    setOptions("#reportClass", options, globalScope() ? "All classes" : "Choose class");
    setOptions("#cardBatchClass", options, "Choose a class");
    if (!globalScope() && !$("#reportClass")?.value && options[0]) $("#reportClass").value = options[0].value;
  }

  function applyNavigation() {
    const gated = {
      credentials: permission("credentials.manage"),
      devices: permission("devices.read") || permission("devices.manage"),
      imports: permission("imports.read") || permission("imports.manage"),
      corrections: permission("corrections.create") || permission("corrections.review"),
      reports: permission("reports.read"),
      settings: permission("settings.manage") || permission("dashboard.read"),
    };
    $$(".nav[data-view]").forEach((button) => {
      const viewName = button.dataset.view;
      button.hidden = gated[viewName] === false;
    });
  }

  function setTitle(viewName) {
    const titles = {
      overview: ["Home", "Today's attendance in one place."],
      scan: ["Take Attendance", "Scan a QR code or tap an NFC card."],
      credentials: ["ID Cards", "Show or print permanent student and staff ID cards."],
      devices: ["Set Up Devices", "Add a school phone, scanner, or card reader."],
      imports: ["Bring In Records", "Receive scans now or upload records saved by a device."],
      corrections: ["Fix a Record", "Review a record that needs correction."],
      reports: ["View Reports", "See attendance for a day, week, month, term, or session."],
      settings: ["School Setup", "See the school period and the Attendance areas you can use."],
    };
    const [title, subtitle] = titles[viewName] || titles.overview;
    $("#title").textContent = title;
    $("#subtitle").textContent = subtitle;
  }

  async function openView(viewName) {
    if (!state.connected) return;
    if ($(`#view-${viewName}`)?.hidden) return;
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
    $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
    setTitle(viewName);
    try {
      if (viewName === "overview") await loadOverview();
      if (viewName === "credentials") await loadCredentialPeople();
      if (viewName === "devices") await loadDevices();
      if (viewName === "imports") await loadImports();
      if (viewName === "corrections") await loadCorrections();
      if (viewName === "reports") await runReport();
      if (viewName === "settings") await renderSettings();
    } catch (error) {
      toast(error.message, "error");
      if (["ADMIN_AUTH_FAILED", "ADMIN_SESSION_EXPIRED", "RESULT_SESSION_NOT_ACTIVE", "RESULT_SESSION_REQUIRED", "ATTENDANCE_SESSION_REQUIRED", "CENTRAL_IDENTITY_NOT_ACTIVE"].includes(error.code)) void signOut();
    }
  }

  function numberValue(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function renderEvents(target, events = []) {
    const node = $(target);
    if (!node) return;
    node.innerHTML = events.length ? events.slice(0, 8).map((event) => `<div class="event"><div><strong>${esc(event.name || event.full_name || event.student_name || event.staff_name || "Attendance event")}</strong><small>${esc(event.class_key || event.designation || event.category || "")} · ${esc(cleanStatus(event.source || event.event_type || "recorded"))} · ${esc(displayTime(event.event_time || event.scan_time || event.recorded_at))}</small></div><span class="badge ${statusClass(event.attendance_status || event.daily_status || "recorded")}">${esc(cleanStatus(event.attendance_status || event.daily_status || "recorded"))}</span></div>`).join("") : `<div class="empty">No attendance events have been recorded yet.</div>`;
  }

  async function loadOverview() {
    const [summary, devices, imports] = await Promise.all([
      universalRead("summary"),
      permission("devices.read") || permission("devices.manage") || globalScope() ? universalRead("devices") : Promise.resolve({ devices: [] }),
      permission("imports.read") || permission("imports.manage") || globalScope() ? universalRead("imports") : Promise.resolve({ batches: [] }),
    ]);
    state.summary = summary;
    state.devices = devices.devices || [];
    const student = summary.student || summary;
    const staff = summary.staff || {};
    $("#sExpected").textContent = numberValue(student.expected);
    $("#sPresent").textContent = numberValue(student.present);
    $("#sLate").textContent = numberValue(student.late);
    $("#sAbsent").textContent = numberValue(student.absent);
    $("#sUnconfirmed").textContent = numberValue(student.waiting ?? student.unconfirmed_classes ?? (student.class_summary || []).filter((item) => numberValue(item.waiting) > 0).length);
    $("#tPresent").textContent = numberValue(staff.present);
    $("#today").textContent = new Date().toLocaleDateString("en-NG", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const events = [...(student.latest_events || []), ...(staff.latest_events || [])].sort((a, b) => String(b.event_time || b.recorded_at).localeCompare(String(a.event_time || a.recorded_at)));
    renderEvents("#recentEvents", events);
    const classRows = student.class_summary || student.classes || [];
    $("#classSummary").innerHTML = classRows.length ? classRows.map((item) => `<div class="class-row"><div><strong>${esc(item.class_key || item.class || "Class")}</strong><small>${numberValue(item.expected)} expected · ${numberValue(item.waiting)} unconfirmed</small></div><div class="class-progress"><span style="width:${Math.min(100, numberValue(item.expected) ? ((numberValue(item.present) + numberValue(item.late)) / numberValue(item.expected)) * 100 : 0)}%"></span></div><b>${numberValue(item.present) + numberValue(item.late)}/${numberValue(item.expected)}</b></div>`).join("") : `<div class="empty">No active class placements are available.</div>`;
    const attention = [];
    if (numberValue(student.waiting) > 0) attention.push(["Student sessions need review", `${student.waiting} expected records are still unresolved.`, "corrections"]);
    if (numberValue(staff.waiting) > 0) attention.push(["Staff events need review", `${staff.waiting} staff records are still unresolved.`, "corrections"]);
    if (!attention.length) attention.push(["No open attention items", "Confirmed data will appear here as the school records attendance.", "reports"]);
    $("#attentionList").innerHTML = attention.map(([title, copy, viewName]) => `<button class="attention-item" data-go="${viewName}"><span class="attention-icon">!</span><span><b>${esc(title)}</b><small>${esc(copy)}</small></span><span>→</span></button>`).join("");
    const importCount = (imports.batches || []).length;
    $("#healthList").innerHTML = `<div class="health-item"><span class="health-check ${state.devices.length ? "good" : "muted"}">${state.devices.length ? "✓" : "–"}</span><div><b>${state.devices.length ? `${state.devices.length} registered device${state.devices.length === 1 ? "" : "s"}` : "Web scanner ready"}</b><small>${state.devices.length ? "Health status comes from the live Device Registry." : "Use a phone camera or compatible NFC reader."}</small></div></div><div class="health-item"><span class="health-check ${importCount ? "good" : "muted"}">${importCount ? "✓" : "–"}</span><div><b>${importCount ? `${importCount} import batch${importCount === 1 ? "" : "es"}` : "No device imports yet"}</b><small>Imported records are previewed and checksum-protected.</small></div></div>`;
  }

  function normalizeCredentialPerson(person, type) {
    return {
      ...person,
      personType: person.person_type || type,
      displayName: person.display_name || person.full_name || "",
      secondary: (person.group_name || "") + (person.reference ? " · " + person.reference : ""),
    };
  }

  async function loadCredentialPeople() {
    const type = $("#credentialPersonType").value;
    const search = $("#credentialSearch").value.trim();
    const data = await universalRead("people", { personType: type, search });
    const people = (data.people || []).map((person) => normalizeCredentialPerson(person, type));
    if (type === "student") state.students = people; else state.staff = people;
    $("#credentialPeople").innerHTML = people.length ? people.map((person) => (
      '<button class="person-item ' + (state.selectedPerson?.id === person.id ? "active" : "") + '" data-person-id="' + esc(person.id) + '">' +
        '<span class="avatar small-avatar">' + avatarMarkup(person, "P") + "</span>" +
        "<span><b>" + esc(person.displayName) + "</b><small>" + esc(person.secondary || "") + "</small></span><span>›</span>" +
      "</button>"
    )).join("") : '<div class="empty">No live ' + (type === "student" ? "students" : "staff") + " match that search.</div>";
  }

  async function selectCredentialPerson(id) {
    const type = $("#credentialPersonType").value;
    const people = type === "student" ? state.students : state.staff;
    state.selectedPerson = people.find((person) => person.id === id) || null;
    if (!state.selectedPerson) return;
    $("#credentialEmpty").hidden = true;
    $("#credentialDetail").hidden = false;
    $("#credentialKind").textContent = type === "student" ? "STUDENT · SCHOOL RECORD" : "STAFF · SCHOOL RECORD";
    $("#credentialName").textContent = state.selectedPerson.displayName;
    $("#credentialMeta").textContent = state.selectedPerson.secondary;
    $("#credentialAvatar").innerHTML = avatarMarkup(state.selectedPerson);
    const data = await universalRead("credentials", { personType: type, personId: id });
    renderCredentialList(data.credentials || []);
    if (permission("devices.read") || permission("devices.manage") || globalScope()) await loadDevices(true);
    else setOptions("#credentialDevice", [], "Device assignment restricted");
  }

  function renderCredentialList(credentials) {
    $("#credentialList").innerHTML = credentials.length ? credentials.map((credential) => {
      const credentialType = String(credential.credential_type || "").toLowerCase();
      const isQr = credentialType.includes("qr");
      const status = String(credential.status || "").toLowerCase();
      const id = credential.id || credential.credential_id || "";
      const method = isQr ? "Permanent QR ID card" : credentialType.includes("nfc") ? "NFC tap card" : "Attendance card";
      const label = credential.credential_label || (isQr ? "Permanent attendance QR" : "School ID card");
      const detail = label + (credential.token_last4 ? " · ending " + credential.token_last4 : "");
      const actions = [];
      if (isQr && ["active", "pending"].includes(status)) actions.push('<button class="mini-button" data-show-credential="' + esc(id) + '">Show ID card</button>');
      if (["active", "pending"].includes(status)) actions.push('<button class="mini-button reject" data-block-credential="' + esc(id) + '">Block card</button>');
      if (isQr && !["replaced", "expired"].includes(status)) actions.push('<button class="mini-button approve" data-replace-credential="' + esc(id) + '">Replace card</button>');
      return '<div class="credential-row"><div><b>' + method + '</b><small>' + esc(detail) + '</small></div><div class="credential-actions"><span class="badge ' + statusClass(status) + '">' + esc(cleanStatus(status)) + "</span>" + actions.join("") + "</div></div>";
    }).join("") : '<div class="empty">No attendance card has been prepared yet.</div>';
  }

  async function digest(value) {
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function issueQr() {
    if (!state.selectedPerson) return toast("Select a real person first.", "error");
    const person = state.selectedPerson;
    const payload = person.personType === "student"
      ? { studentId: person.id, credentialType: "qr_token", label: person.displayName + " permanent QR ID card" }
      : { staffId: person.id, credentialType: "qr_token", label: person.displayName + " permanent QR ID card" };
    const data = await qrWrite("issueQr", payload);
    const raw = data.credential?.raw_token;
    if (!raw) throw new Error("The QR value was not returned for this card.");
    await showCardPreview(data.credential?.existing ? "ID card ready to reprint" : "Permanent ID card ready", [{ person, raw }]);
    toast(data.credential?.existing ? "The same permanent QR code was loaded." : "Permanent QR code created and saved for reprinting.", "success");
    await selectCredentialPerson(person.id);
  }

  async function replaceQrCard(credentialId) {
    if (!state.selectedPerson) return toast("Select a real person first.", "error");
    if (!window.confirm("Block the current QR card and create a replacement? The old card will stop working.")) return;
    const reason = window.prompt("Why is this card being replaced?", "Lost or damaged card");
    if (reason === null) return;
    const person = state.selectedPerson;
    const payload = {
      credentialId,
      reason: reason.trim() || "QR card replacement requested",
      label: person.displayName + " permanent QR ID card",
    };
    const data = await qrWrite("replaceQr", payload);
    const raw = data.credential?.raw_token;
    if (!raw) throw new Error("The replacement QR value was not returned.");
    await showCardPreview("Replacement ID card ready", [{ person, raw }]);
    toast("The old card is blocked and the replacement QR is ready.", "success");
    await selectCredentialPerson(person.id);
  }

  async function blockCredential(credentialId) {
    if (!window.confirm("Block this card? It will no longer be accepted for attendance.")) return;
    const reason = window.prompt("Reason for blocking this card:", "Lost or damaged card");
    if (reason === null) return;
    await universalWrite("suspendCredential", {
      credentialId,
      reason: reason.trim() || "Credential blocked",
    });
    toast("Card blocked. Use Replace card to issue another one.", "success");
    if (state.selectedPerson) await selectCredentialPerson(state.selectedPerson.id);
  }

  function setCardBatchStatus(message, kind) {
    const node = $("#cardBatchStatus");
    if (!node) return;
    node.textContent = message;
    node.className = "small-note" + (kind ? " " + kind : "");
  }

  async function prepareCardBatch(type, classKey = "") {
    if (state.cardBatchBusy) return toast("A card set is already being prepared.", "warning");
    if (type === "student" && !classKey) return toast("Choose a student class first.", "error");
    state.cardBatchBusy = true;
    const label = type === "student" ? classKey + " student" : "all staff";
    try {
      setCardBatchStatus("Loading " + label + " records…");
      const data = await universalRead("people", { personType: type, search: classKey || "" });
      let people = (data.people || []).map((person) => normalizeCredentialPerson(person, type));
      if (type === "student" && classKey) {
        people = people.filter((person) => String(person.group_name || "").toLowerCase() === String(classKey).toLowerCase());
      }
      if (!people.length) return toast("No active " + (type === "student" ? "students" : "staff") + " were found for that set.", "warning");
      const cards = [];
      const skipped = [];
      for (let index = 0; index < people.length; index += 1) {
        const person = people[index];
        setCardBatchStatus("Preparing " + label + " cards · " + (index + 1) + " of " + people.length + "…");
        try {
          const payload = person.personType === "student"
            ? { studentId: person.id, credentialType: "qr_token", label: person.displayName + " permanent QR ID card" }
            : { staffId: person.id, credentialType: "qr_token", label: person.displayName + " permanent QR ID card" };
          const result = await qrWrite("issueQr", payload);
          if (result.credential?.raw_token) cards.push({ person, raw: result.credential.raw_token });
          else skipped.push({ person, message: "QR value was not returned" });
        } catch (error) {
          skipped.push({ person, message: error.message || "QR card unavailable" });
        }
      }
      if (!cards.length) {
        setCardBatchStatus("No cards are ready. Older cards may need an explicit replacement first.", "error");
        return toast("No printable cards were returned for this set.", "error");
      }
      await showCardPreview((type === "student" ? "Class " + classKey : "All staff") + " ID cards ready", cards);
      const suffix = skipped.length ? " " + skipped.length + " older card(s) need Replace card first." : "";
      setCardBatchStatus(cards.length + " card(s) ready for print." + suffix, skipped.length ? "warning" : "success");
      toast(cards.length + " ID card(s) are ready. Use Print / save ID cards in the preview.", "success");
    } finally {
      state.cardBatchBusy = false;
    }
  }

  async function loadDevices(forCredential = false) {
    const data = await universalRead("devices");
    state.devices = data.devices || [];
    const options = state.devices.map((device) => ({ value: device.id, label: `${device.device_name} · ${device.device_code}` }));
    if (forCredential) setOptions("#credentialDevice", options, "No reader selected");
    setOptions("#importDevice", options, "No device selected");
    $("#deviceEmpty").style.display = state.devices.length ? "none" : "block";
    $("#deviceGrid").innerHTML = state.devices.length ? state.devices.map((device) => {
      const reads = (device.supported_sources || []).map((source) => source === "qr" ? "QR codes" : source === "nfc" ? "NFC cards" : source).join(" and ");
      const connects = ({ wifi: "Wi-Fi", cellular: "mobile data", usb: "USB or Bluetooth", mixed: "more than one way", ethernet: "network cable", offline: "file transfer only" })[device.connection_type] || cleanStatus(device.connection_type);
      const status = device.computed_status || device.status || "unknown";
      return `<article class="device-card"><div class="device-top"><div><small class="eyebrow">DEVICE CODE · ${esc(device.device_code)}</small><h3>${esc(device.device_name)}</h3></div><span class="badge ${statusClass(status)}">${esc(cleanStatus(status))}</span></div><div class="device-details"><div><span>Reads</span><b>${esc(reads || "Not chosen")}</b></div><div><span>Used at</span><b>${esc(device.assigned_gate || device.location || "Not set")}</b></div><div><span>Connects by</span><b>${esc(connects || "Not set")}</b></div><div><span>If internet stops</span><b>${device.offline_enabled ? "Saves scans safely" : "Needs a connection"}</b></div><div><span>Last contact</span><b>${esc(displayTime(device.last_sync_at || device.last_seen_at))}</b></div><div><span>Device status</span><b>${esc(cleanStatus(device.health_status || "not checked yet"))}</b></div></div></article>`;
    }).join("") : "";
  }

  function createDeviceCode() {
    const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID().replaceAll("-", "").slice(0, 10) : [...crypto.getRandomValues(new Uint8Array(5))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `WTS-${suffix.toUpperCase()}`;
  }

  function openDeviceSetup() {
    $("#deviceForm").reset();
    $("#newDeviceCode").value = createDeviceCode();
    $("#newDeviceMethod").value = "both";
    $("#newDeviceConnection").value = "wifi";
    $("#newDeviceOffline").checked = true;
    $("#deviceDialog").showModal();
  }

  async function addDevice(event) {
    event.preventDefault();
    const result = await universalWrite("registerDevice", {
      deviceCode: $("#newDeviceCode").value,
      deviceName: $("#newDeviceName").value.trim(),
      modality: $("#newDeviceMethod").value,
      assignedGate: $("#newDeviceLocation").value.trim(),
      connectionType: $("#newDeviceConnection").value,
      offlineEnabled: $("#newDeviceOffline").checked,
      deploymentMode: $("#newDeviceMethod").value === "qr" ? "mobile_admin" : "gate_fixed",
    });
    $("#deviceDialog").close();
    $("#readyDeviceCode").textContent = result.device.device_code;
    $("#readyDeviceSecret").textContent = result.device.raw_secret;
    $("#deviceReadyDialog").showModal();
    toast("Device login created.", "success");
    await loadDevices();
  }

  function csvRows(text, delimiter = ",") {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index], next = text[index + 1];
      if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (char === delimiter && !quoted) { row.push(cell); cell = ""; continue; }
      if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(cell); cell = "";
        if (row.some((value) => value.trim() !== "")) rows.push(row);
        row = [];
        continue;
      }
      cell += char;
    }
    if (cell || row.length) { row.push(cell); if (row.some((value) => value.trim() !== "")) rows.push(row); }
    return rows;
  }

  const keyOf = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  function objectRows(matrix) {
    if (!matrix.length) return [];
    const headers = matrix[0].map((header, index) => keyOf(header) || `column${index + 1}`);
    return matrix.slice(1).filter((row) => row.some((value) => String(value || "").trim() !== "")).map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()])));
  }

  function valueFrom(row, patterns) {
    const entry = Object.entries(row).find(([key, value]) => patterns.some((pattern) => key.includes(pattern)) && String(value).trim());
    return entry?.[1] || "";
  }

  function shapeImportRows(rawRows) {
    return rawRows.map((row, index) => {
      const identifier = valueFrom(row, ["externaluserid", "terminaluserid", "deviceuserid", "userid", "cardnumber", "carduid", "uid", "credential", "identifier", "admissionnumber", "staffnumber"]);
      const date = valueFrom(row, ["datetime", "timestamp", "eventtime", "attendancetime", "date"]) || "";
      const time = valueFrom(row, ["time", "checkin", "checkout"]);
      const eventTime = date && time && !date.includes("T") && !date.includes(" ") ? `${date}T${time}` : date;
      const direction = valueFrom(row, ["direction", "eventtype", "status"]).toLowerCase();
      const method = valueFrom(row, ["verificationtype", "verification", "method", "credentialtype"]).toLowerCase();
      return { rowNumber: index + 2, rawRecord: row, rawIdentifier: identifier, eventTime, direction: direction.includes("out") || direction.includes("checkout") ? "OUT" : direction.includes("in") || direction.includes("checkin") ? "IN" : "UNSPECIFIED", eventType: direction.includes("out") || direction.includes("checkout") ? "check_out" : "check_in", credentialMethod: method || "external_device_user_id", sourceEventId: valueFrom(row, ["sourceeventid", "eventid", "recordid"]), sourceTimeZone: "Africa/Lagos" };
    });
  }

  async function parseImportFile(file) {
    const buffer = await file.arrayBuffer();
    const lower = file.name.toLowerCase();
    let rawRows;
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      if (!window.WTS_VENDOR?.XLSX) throw new Error("XLSX support is not available in this deployment.");
      const workbook = window.WTS_VENDOR.XLSX.read(buffer, { type: "array", cellDates: true });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      rawRows = objectRows(window.WTS_VENDOR.XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: "" }));
    } else {
      const decoded = new TextDecoder().decode(buffer);
      const delimiter = lower.endsWith(".tsv") || decoded.split("\n", 1)[0].split("\t").length > decoded.split("\n", 1)[0].split(",").length ? "\t" : ",";
      rawRows = objectRows(csvRows(decoded, delimiter));
    }
    return { rows: shapeImportRows(rawRows), checksum: await digest(new Uint8Array(buffer)) };
  }

  function renderImportPreview() {
    const rows = state.import.rows;
    const counts = rows.reduce((acc, row) => { acc[row.validation_status || "pending"] = (acc[row.validation_status || "pending"] || 0) + 1; return acc; }, {});
    $("#importPreview").hidden = !rows.length;
    $("#importSummary").innerHTML = [["Ready", counts.ready || 0, "ready"], ["Unknown identity", counts.unknown_identity || 0, "unknown_identity"], ["Duplicate", counts.duplicate || 0, "duplicate"], ["Invalid", (counts.invalid_date_time || 0) + (counts.invalid_credential || 0), "invalid"]].map(([label, count, kind]) => `<span class="import-count ${kind}"><b>${count}</b><small>${label}</small></span>`).join("");
    $("#importRows").innerHTML = rows.map((row) => `<tr class="${state.import.selectedRowId === row.id ? "selected-row" : ""}" data-import-row="${esc(row.id || row.row_number)}"><td>${esc(row.row_number || row.rowNumber)}</td><td><strong>${esc(row.raw_identifier || row.rawIdentifier || "—")}</strong><small>${esc(row.external_user_id || "")}</small></td><td>${esc(displayTime(row.event_time || row.eventTime))}</td><td>${esc(cleanStatus(row.credential_method || row.credentialMethod || "—"))}</td><td><span class="badge ${statusClass(row.validation_status || "pending")}">${esc(cleanStatus(row.validation_status || "pending"))}</span></td><td>${esc(row.validation_reason || "")}</td></tr>`).join("");
  }

  async function previewImport() {
    const file = $("#importFile").files?.[0];
    if (!file) return toast("Choose a CSV, XLSX or text export first.", "error");
    $("#importFileStatus").textContent = `Reading ${file.name}…`;
    const parsed = await parseImportFile(file);
    if (!parsed.rows.length) throw new Error("The file has no readable data rows.");
    const extension = file.name.toLowerCase().endsWith(".xlsx") || file.name.toLowerCase().endsWith(".xls") ? "xlsx" : file.name.toLowerCase().endsWith(".txt") || file.name.toLowerCase().endsWith(".tsv") ? "text" : "csv";
    let data;
    try {
      data = await universalWrite("previewImport", { fileName: file.name, checksumSha256: parsed.checksum, deviceId: $("#importDevice").value || null, sourceType: extension, adapterCode: $("#importAdapter").value, rows: parsed.rows.slice(0, 5000) });
    } catch (error) {
      if (error.code === "DUPLICATE_RECORD" || error.code === "IMPORT_ALREADY_UPLOADED") throw new Error("This file has already been uploaded. Choose a new export or review its existing import batch.");
      throw error;
    }
    state.import.batchId = data.batch_id;
    state.import.rows = data.rows || [];
    state.import.file = file;
    $("#importFileStatus").textContent = `${file.name} · ${state.import.rows.length} row(s) previewed.`;
    $("#importPreviewTitle").textContent = `${file.name} · preview`;
    renderImportPreview();
    toast("Import preview ready. Review unknown and invalid rows before confirming.", "success");
    await loadImports();
  }

  async function loadMapPeople() {
    const personType = $("#mapPersonType").value;
    const search = $("#mapPersonSearch").value.trim();
    const data = await universalRead("people", { personType, search });
    state.mapPeople = data.people || [];
    $("#mapPersonResults").innerHTML = state.mapPeople.length ? state.mapPeople.map((person) => `<button type="button" class="person-item" data-map-person-id="${esc(person.id)}"><span class="avatar small-avatar">${avatarMarkup(person, "P")}</span><span><b>${esc(person.display_name)}</b><small>${esc(person.group_name || "")}${person.reference ? ` · ${esc(person.reference)}` : ""}</small></span><span>Choose</span></button>`).join("") : `<div class="empty">No matching ${personType === "student" ? "students" : "staff"} found.</div>`;
  }

  async function openMapImportRow() {
    const row = state.import.rows.find((item) => String(item.id) === String(state.import.selectedRowId));
    if (!row || row.validation_status !== "unknown_identity") return toast("Choose a row marked Unknown person first.", "error");
    $("#mapRowIdentifier").textContent = row.raw_identifier || row.external_user_id || "Unknown card";
    $("#mapPersonType").value = "student";
    $("#mapPersonSearch").value = "";
    $("#mapPersonDialog").showModal();
    await loadMapPeople();
  }

  async function mapSelectedImportRow(personId) {
    const row = state.import.rows.find((item) => String(item.id) === String(state.import.selectedRowId));
    const personType = $("#mapPersonType").value;
    if (!row) return;
    await universalWrite("mapImportRow", { rowId: row.id, [personType === "student" ? "studentId" : "staffId"]: personId, credentialType: "external_device_user_id", rawIdentifier: row.raw_identifier, externalUserId: row.external_user_id, deviceId: $("#importDevice").value || null });
    const refreshed = await universalRead("import_rows", { batchId: state.import.batchId });
    state.import.rows = refreshed.rows || [];
    renderImportPreview();
    $("#mapPersonDialog").close();
    toast("The unknown card is now matched to that person.", "success");
  }

  async function confirmImport() {
    if (!state.import.batchId) return toast("Preview an import first.", "error");
    await universalWrite("confirmImport", { batchId: state.import.batchId });
    toast("Import processed. Accepted, duplicate and unresolved rows remain auditable.", "success");
    const refreshed = await universalRead("import_rows", { batchId: state.import.batchId });
    state.import.rows = refreshed.rows || [];
    renderImportPreview();
    await loadImports();
  }

  async function loadImports() {
    const data = await universalRead("imports");
    const batches = data.batches || [];
    $("#importBatches").innerHTML = batches.length ? batches.map((batch) => `<div class="batch-row"><div><b>${esc(batch.file_name || "Unnamed import")}</b><small>${esc(batch.adapter_code || "generic")}${batch.uploaded_at ? ` · ${esc(displayDate(batch.uploaded_at))}` : ""}</small></div><div class="batch-numbers"><span>${numberValue(batch.accepted_count)} accepted</span><span>${numberValue(batch.unresolved_count)} unresolved</span><span class="badge ${statusClass(batch.status)}">${esc(cleanStatus(batch.status))}</span></div></div>`).join("") : `<div class="empty">No import batches have been uploaded.</div>`;
  }

  async function loadCorrections() {
    const data = await universalRead("corrections");
    const register = data.register_corrections || [];
    const daily = data.daily_corrections || [];
    const actions = (row, type) => `<div class="review-actions"><button class="mini-button approve" data-review="approve" data-review-type="${type}" data-review-id="${esc(row.id)}">Approve</button><button class="mini-button reject" data-review="reject" data-review-type="${type}" data-review-id="${esc(row.id)}">Reject</button></div>`;
    $("#registerCorrections").innerHTML = register.length ? register.map((row) => `<div class="review-row"><div><b>${esc(cleanStatus(row.requested_status))}</b><small>${esc(row.reason || "No reason")}</small></div>${actions(row, "register")}</div>`).join("") : `<div class="empty">No pending AM / PM corrections.</div>`;
    $("#dailyCorrections").innerHTML = daily.length ? daily.map((row) => `<div class="review-row"><div><b>${esc(cleanStatus(row.requested_status || "daily correction"))}</b><small>${esc(row.reason || "No reason")}</small></div>${actions(row, "daily")}</div>`).join("") : `<div class="empty">No pending daily corrections.</div>`;
  }

  async function reviewCorrection(event) {
    const button = event.target.closest("[data-review]");
    if (!button) return;
    const approve = button.dataset.review === "approve";
    const type = button.dataset.reviewType;
    if (type === "register") await universalWrite(`${approve ? "approve" : "reject"}RegisterCorrection`, { correctionId: button.dataset.reviewId, reviewNote: window.prompt("Review note (optional):", "") || null });
    else await controlsWrite(`${approve ? "approve" : "reject"}Correction`, { correctionId: button.dataset.reviewId, reviewNote: window.prompt("Review note (optional):", "") || null });
    toast(approve ? "Correction approved and audited." : "Correction rejected and audited.", "success");
    await loadCorrections();
  }

  async function runReport() {
    const from = $("#reportFrom").value || monthStart();
    const to = $("#reportTo").value || todayIso();
    const reportType = $("#reportType").value;
    const data = await universalRead("report", { from, to, classKey: $("#reportClass").value || null, reportType });
    const studentRows = data.student_rows || [];
    const classRows = data.class_rows || [];
    const summary = data.session_summary || {};
    const periodRows = reportType === "weekly" ? data.weekly_rows || [] : reportType === "monthly" ? data.monthly_rows || [] : [];
    const periodLabel = reportType === "weekly" ? "Weekly breakdown" : reportType === "monthly" ? "Monthly breakdown" : reportType === "session" ? "Session history" : "Selected period";
    $("#reportSummary").innerHTML = `<b>${esc(displayDate(from))} – ${esc(displayDate(to))}</b><span>${esc(data.session || state.context?.session || "Current session")} · ${esc(data.term || state.context?.term || "Current term")}</span><span>${numberValue(summary.actual_sessions)} actual / ${numberValue(summary.possible_sessions)} eligible sessions · ${numberValue(summary.incomplete_sessions)} incomplete · ${numberValue(summary.excluded_sessions)} excluded</span>`;
    $("#studentReportRows").innerHTML = studentRows.length ? studentRows.map((row) => `<div class="report-row"><div><b>${esc(row.name)}</b><small>${esc(row.class_key || "")}${row.admno ? ` · ${esc(row.admno)}` : ""}</small></div><div><strong>${numberValue(row.attendance_percentage).toFixed(2)}%</strong><small>${numberValue(row.actual_sessions)}/${numberValue(row.possible_sessions)} actual · ${numberValue(row.incomplete_sessions)} incomplete</small></div></div>`).join("") : `<div class="empty">No eligible pupil summaries for this period.</div>`;
    $("#classReportRows").innerHTML = classRows.length ? classRows.map((row) => `<div class="report-row"><div><b>${esc(row.class_key)}</b><small>${numberValue(row.incomplete_sessions)} incomplete sessions</small></div><div><strong>${numberValue(row.attendance_percentage).toFixed(2)}%</strong><small>${numberValue(row.actual_sessions)}/${numberValue(row.possible_sessions)} actual</small></div></div>`).join("") : `<div class="empty">No class summaries for this period.</div>`;
    $("#periodReportTitle").textContent = periodLabel;
    if (reportType === "session" || reportType === "term") {
      $("#periodReportRows").innerHTML = `<div class="report-row"><div><b>${reportType === "session" ? "Session total" : "Selected period total"}</b><small>${numberValue(summary.late_sessions)} late · ${numberValue(summary.absent_sessions)} absent · ${numberValue(summary.excused_sessions)} excused</small></div><div><strong>${numberValue(summary.possible_sessions) ? ((numberValue(summary.actual_sessions) / numberValue(summary.possible_sessions)) * 100).toFixed(2) : "0.00"}%</strong><small>${numberValue(summary.actual_sessions)}/${numberValue(summary.possible_sessions)} actual</small></div></div>`;
    } else {
      $("#periodReportRows").innerHTML = periodRows.length ? periodRows.map((row) => {
        const label = reportType === "weekly" ? `Week of ${displayDate(row.week_start)}` : displayDate(row.month_start);
        return `<div class="report-row"><div><b>${esc(label)}</b><small>${numberValue(row.school_days)} school days · ${numberValue(row.incomplete_sessions)} incomplete</small></div><div><strong>${numberValue(row.attendance_percentage).toFixed(2)}%</strong><small>${numberValue(row.actual_sessions)}/${numberValue(row.possible_sessions)} actual · ${numberValue(row.late_sessions)} late</small></div></div>`;
      }).join("") : `<div class="empty">No grouped attendance data for this period.</div>`;
    }
  }

  async function renderSettings() {
    const config = state.context?.config || {};
    $("#contextDetails").innerHTML = `<div><dt>School session</dt><dd>${esc(state.context?.session || config.operational_session || "—")}</dd></div><div><dt>Term</dt><dd>${esc(state.context?.term || config.operational_term || "—")}</dd></div><div><dt>People and classes</dt><dd>Come from the main school records</dd></div><div><dt>Ways to record attendance</dt><dd>Scan a QR code or tap an NFC card</dd></div><div><dt>Not present</dt><dd>Calculated from the expected class list and recorded scans</dd></div><div><dt>Parent messages</dt><dd>${config.parent_notifications_enabled ? "Turned on" : "Not turned on"}</dd></div>`;
    const permissions = state.context?.permissions || [];
    const accessLabels = {
      "*": "All Attendance areas",
      "dashboard.read": "See today's attendance",
      "class.attendance.read": "See class attendance",
      "class.attendance.write": "Work with class attendance",
      "attendance.register.confirm": "Confirm class attendance",
      "staff.read": "See staff attendance",
      "reports.read": "View reports",
      "credentials.manage": "Prepare ID cards",
      "devices.read": "See school devices",
      "devices.manage": "Set up school devices",
      "imports.read": "See uploaded records",
      "imports.manage": "Bring in device records",
      "corrections.create": "Ask for a record correction",
      "corrections.review": "Approve record corrections",
      "settings.manage": "Manage Attendance setup",
    };
    const friendlyAccess = [...new Set(permissions.map((item) => accessLabels[item]).filter(Boolean))];
    $("#roleDetails").innerHTML = friendlyAccess.length ? friendlyAccess.map((item) => `<span class="permission-chip">${esc(item)}</span>`).join("") : `<div class="empty">No Attendance areas are assigned to this account.</div>`;
    await loadRosterSyncStatus();
  }

  async function loadRosterSyncStatus() {
    const data = await rpc("attendance_roster_sync_status_api");
    state.rosterSync = data;
    const latest = data.latest_success && data.latest_success !== "null" ? data.latest_success : null;
    const completed = latest?.completed_at ? displayDate(latest.completed_at) : "Not available";
    $("#rosterSyncDetails").innerHTML = latest ? `<div><dt>Last successful sync</dt><dd>${esc(completed)}</dd></div><div><dt>Context</dt><dd>${esc(`${latest.academic_session || "—"} · ${latest.academic_term || "—"}`)}</dd></div><div><dt>Records added / updated</dt><dd>${numberValue(latest.records_added)} / ${numberValue(latest.records_updated)}</dd></div><div><dt>Deactivated for future rosters</dt><dd>${numberValue(latest.records_deactivated)}</dd></div><div><dt>Unresolved identities</dt><dd>${numberValue(latest.unresolved_identities)}</dd></div><div><dt>Failed mappings</dt><dd>${numberValue(latest.failed_mappings)}</dd></div>` : `<div class="empty">No successful roster synchronisation is recorded yet.</div>`;
    $("#retryRosterSync").disabled = !(data.retry_available && globalScope());
  }

  async function retryRosterSync() {
    if (!globalScope()) return toast("Roster synchronisation requires an authorised Attendance administrator.", "error");
    await rpc("attendance_roster_sync_api", "", { academic_session: state.context?.session, academic_term: state.context?.term, as_of_date: todayIso() });
    await loadRosterSyncStatus();
    toast("Central Registry roster re-synchronised safely.", "success");
  }

  function renderIdCardPair(card, index) {
    const person = card.person || {};
    const isStudent = person.personType === "student";
    const kind = isStudent ? "STUDENT" : "STAFF";
    const reference = text(person.reference);
    const session = text(state.context?.session, "Current session");
    const role = person.designation || person.group_name || person.staff_category || "Staff";
    const department = person.department || person.school_section || person.group_name || "School staff";
    const house = person.house || "School student";
    const frontClass = isStudent ? "student-card-front" : "staff-card-front";
    const fieldMarkup = isStudent
      ? '<div><dt>ADMISSION NO</dt><dd>' + esc(reference) + '</dd></div><div><dt>CLASS</dt><dd>' + esc(text(person.group_name)) + '</dd></div><div><dt>HOUSE</dt><dd>' + esc(house) + '</dd></div>'
      : '<div><dt>STAFF NO</dt><dd>' + esc(reference) + '</dd></div><div><dt>ROLE</dt><dd>' + esc(role) + '</dd></div><div><dt>DEPARTMENT</dt><dd>' + esc(department) + '</dd></div>';
    return '<div class="id-card-pair ' + (isStudent ? "student-card-pair" : "staff-card-pair") + '">' +
      '<section class="id-side-wrap"><span class="id-side-label">FRONT · ' + kind + ' IDENTITY</span>' +
        '<article class="id-card-face id-card-front ' + frontClass + '">' +
          '<header class="id-card-brand"><b class="school-crest"><img src="/assets/wts-school-logo.jpg" alt="Way to Success Standard Schools logo"></b><span>WAY TO SUCCESS STANDARD SCHOOLS<small>IFEDAPO COMMUNITY · EJIGBO</small></span><em class="id-card-type">' + kind + ' ID</em></header>' +
          '<div class="id-front-body"><div class="avatar id-avatar">' + avatarMarkup(person, isStudent ? "S" : "W") + '</div><div class="id-person-copy"><small>' + kind + ' IDENTITY</small><h2>' + esc(text(person.displayName, "WTS identity")) + '</h2><p>' + esc(isStudent ? "Student attendance profile" : role) + '</p></div></div>' +
          '<dl class="id-fields">' + fieldMarkup + '</dl>' +
          '<footer><span>Property of Way to Success Standard Schools</span><b>' + esc(session) + '</b></footer>' +
        '</article>' +
      '</section>' +
      '<section class="id-side-wrap"><span class="id-side-label">BACK · ATTENDANCE QR</span>' +
        '<article class="id-card-face id-card-back">' +
          '<header class="id-back-brand"><b class="school-crest"><img src="/assets/wts-school-logo.jpg" alt="Way to Success Standard Schools logo"></b><span>WTS ATTENDANCE<small>PERMANENT QR ID CARD</small></span><em class="id-back-kind">' + kind + '</em></header>' +
          '<div class="id-back-copy"><small>ATTENDANCE QR</small><h2>SCAN THIS SIDE</h2></div>' +
          '<div class="qr-frame"><img class="qr-preview" data-card-qr="' + index + '" alt="Secure attendance QR code"></div>' +
          '<p class="id-qr-hint">KEEP THE FULL CODE AND WHITE QUIET AREA CLEAR</p>' +
        '</article>' +
      '</section>' +
    '</div>';
  }

  async function showCardPreview(title, cards) {
    const safeCards = (cards || []).filter((card) => card && card.person && card.raw);
    if (!safeCards.length) throw new Error("No printable ID card was returned.");
    const printAreaNode = $("#cardPrintArea");
    if (!printAreaNode) throw new Error("The ID card preview is unavailable.");
    if (!window.WTS_VENDOR?.QRCode) throw new Error("The QR renderer is unavailable. Refresh the portal and try again.");

    printAreaNode.innerHTML = safeCards.map((card, index) => renderIdCardPair(card, index)).join("");
    $("#secretTitle").textContent = title;
    $("#secretIntro").textContent = safeCards.length === 1
      ? "This card uses the person's permanent attendance QR code. Print the front and the large QR-only back."
      : safeCards.length + " cards are ready. Each person keeps one permanent attendance QR code.";
    $("#secretValue").textContent = "";
    $("#copySecret").hidden = true;
    $("#printQrDialog").hidden = false;
    $("#printQrDialog").textContent = safeCards.length === 1 ? "Print / save ID card" : "Print / save ID cards";

    for (let index = 0; index < safeCards.length; index += 1) {
      const source = await window.WTS_VENDOR.QRCode.toDataURL(safeCards[index].raw, {
        width: 1000,
        margin: 4,
        errorCorrectionLevel: "M",
        color: { dark: "#0b1f3a", light: "#ffffff" },
      });
      const image = printAreaNode.querySelector('[data-card-qr="' + index + '"]');
      if (image) image.src = source;
    }

    state.lastQrCards = safeCards;
    state.lastQr = safeCards.length === 1 ? safeCards[0].raw : null;
    state.lastQrPersonId = safeCards.length === 1 ? safeCards[0].person.id : null;
    const dialog = $("#secretDialog");
    if (dialog.open) dialog.close();
    dialog.showModal();
  }

  function printArea(className) {
    document.body.classList.add(className);
    window.setTimeout(() => { window.print(); window.setTimeout(() => document.body.classList.remove(className), 300); }, 20);
  }

  function wireEvents() {
    $$(".nav").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
    document.addEventListener("click", (event) => {
      const go = event.target.closest("[data-go]");
      if (go) { openView(go.dataset.go); return; }
      const showCredential = event.target.closest("[data-show-credential]");
      if (showCredential) { issueQr().catch((error) => toast(error.message, "error")); return; }
      const replaceCredential = event.target.closest("[data-replace-credential]");
      if (replaceCredential) { replaceQrCard(replaceCredential.dataset.replaceCredential).catch((error) => toast(error.message, "error")); return; }
      const blockCredentialButton = event.target.closest("[data-block-credential]");
      if (blockCredentialButton) { blockCredential(blockCredentialButton.dataset.blockCredential).catch((error) => toast(error.message, "error")); return; }
      const person = event.target.closest("[data-person-id]");
      if (person) { selectCredentialPerson(person.dataset.personId).catch((error) => toast(error.message, "error")); return; }
      const mapPerson = event.target.closest("[data-map-person-id]");
      if (mapPerson) { mapSelectedImportRow(mapPerson.dataset.mapPersonId).catch((error) => toast(error.message, "error")); return; }
      const credential = event.target.closest("[data-suspend-credential]");
      if (credential) { blockCredential(credential.dataset.suspendCredential).catch((error) => toast(error.message, "error")); return; }
      if (event.target.closest("[data-review]")) { reviewCorrection(event).catch((error) => toast(error.message, "error")); return; }
      const importRow = event.target.closest("[data-import-row]");
      if (importRow) { state.import.selectedRowId = importRow.dataset.importRow; renderImportPreview(); }
    });
    $("#refresh").onclick = () => loadContext().catch((error) => toast(error.message, "error"));
    $("#login").onclick = signOut;
    $("#refreshScanEvents").onclick = () => loadOverview().then(() => renderEvents("#scanEvents", [...(state.summary?.latest_events || []), ...(state.summary?.staff?.latest_events || [])])).catch((error) => toast(error.message, "error"));
    $("#credentialPersonType").onchange = () => { state.selectedPerson = null; $("#credentialDetail").hidden = true; $("#credentialEmpty").hidden = false; loadCredentialPeople().catch((error) => toast(error.message, "error")); };
    $("#searchCredentials").onclick = () => loadCredentialPeople().catch((error) => toast(error.message, "error"));
    $("#credentialSearch").onkeydown = (event) => { if (event.key === "Enter") loadCredentialPeople().catch((error) => toast(error.message, "error")); };
    $("#issueQr").onclick = () => issueQr().catch((error) => toast(error.message, "error"));
    $("#downloadClassCards").onclick = () => prepareCardBatch("student", $("#cardBatchClass").value).catch((error) => toast(error.message, "error"));
    $("#downloadStaffCards").onclick = () => prepareCardBatch("staff").catch((error) => toast(error.message, "error"));
    $("#credentialAssignForm").onsubmit = (event) => assignCredential(event).catch((error) => toast(error.message, "error"));
    $("#printQr").onclick = () => issueQr().catch((error) => toast(error.message, "error"));
    $("#addDevice").onclick = openDeviceSetup;
    $("#deviceForm").onsubmit = (event) => addDevice(event).catch((error) => toast(error.message, "error"));
    $("#cancelDevice").onclick = () => $("#deviceDialog").close();
    $("#closeDeviceReady").onclick = () => $("#deviceReadyDialog").close();
    $("#copyDeviceLogin").onclick = () => navigator.clipboard?.writeText(`Device code: ${$("#readyDeviceCode").textContent}\nDevice secret: ${$("#readyDeviceSecret").textContent}`).then(() => toast("Device code and secret copied.", "success"));
    $("#importFile").onchange = () => { const file = $("#importFile").files?.[0]; $("#importFileStatus").textContent = file ? `${file.name} selected. Preview before processing.` : "No file selected."; };
    $("#previewImport").onclick = () => previewImport().catch((error) => toast(error.message, "error"));
    $("#mapImportRow").onclick = () => openMapImportRow().catch((error) => toast(error.message, "error"));
    $("#mapPersonSearchButton").onclick = () => loadMapPeople().catch((error) => toast(error.message, "error"));
    $("#mapPersonType").onchange = () => loadMapPeople().catch((error) => toast(error.message, "error"));
    $("#mapPersonSearch").onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); loadMapPeople().catch((error) => toast(error.message, "error")); } };
    $("#closeMapPerson").onclick = () => $("#mapPersonDialog").close();
    $("#confirmImport").onclick = () => confirmImport().catch((error) => toast(error.message, "error"));
    $("#refreshImports").onclick = () => loadImports().catch((error) => toast(error.message, "error"));
    $("#refreshCorrections").onclick = () => loadCorrections().catch((error) => toast(error.message, "error"));
    $("#runReport").onclick = () => runReport().catch((error) => toast(error.message, "error"));
    $("#retryRosterSync").onclick = () => retryRosterSync().catch((error) => toast(error.message, "error"));
    $("#printReport").onclick = () => printArea("print-report");
    $("#closeSecret").onclick = () => $("#secretDialog").close();
    $("#closeSecretButton").onclick = () => $("#secretDialog").close();
    $("#copySecret").onclick = () => navigator.clipboard?.writeText($("#secretValue").textContent).then(() => toast("Copied to clipboard.", "success"));
    $("#printQrDialog").onclick = () => printArea("print-qr");
    $("#reportFrom").value = monthStart();
    $("#reportTo").value = todayIso();
  }

  async function loadContext() {
    const data = await universalRead("context");
    state.context = data;
    applyNavigation();
    fillClassSelectors();
    connected(true);
    await loadOverview();
  }

  wireEvents();
  connected(false);
  Promise.resolve(window.WTS_AUTH_READY).then((authenticated) => {
    if (!authenticated) return;
    return loadContext().catch((error) => {
      connected(false, error.message || "Attendance access could not be loaded.");
      if (["RESULT_SESSION_NOT_ACTIVE", "RESULT_SESSION_REQUIRED", "ATTENDANCE_SESSION_REQUIRED", "CENTRAL_IDENTITY_NOT_ACTIVE"].includes(error.code)) void signOut();
    });
  });
})();
