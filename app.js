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
    lastQr: null,
    lastQrPersonId: null,
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
      const error = new Error(data?.message || data?.code || "Attendance request failed.");
      error.code = data?.code;
      throw error;
    }
    return data;
  }

  const universalRead = (action, payload = {}) => rpc("attendance_universal_admin_read_api", action, payload);
  const universalWrite = (action, payload = {}) => rpc("attendance_universal_admin_write_api", action, payload);
  const studentRead = (action, payload = {}) => rpc("attendance_admin_read_api", action, payload);
  const studentWrite = (action, payload = {}) => rpc("attendance_admin_write_api", action, payload);
  const staffRead = (action, payload = {}) => rpc("staff_attendance_admin_read_api", action, payload);
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
      overview: ["Today", "A clear view of attendance as it happens."],
      scan: ["Scan", "One secure scanner for QR passes and NFC cards."],
      credentials: ["ID Cards", "Issue QR passes and link NFC cards from the central office."],
      devices: ["Device Setup", "Register only school-owned QR and NFC equipment."],
      imports: ["Sync", "Real-time, offline retry, and device-file imports."],
      corrections: ["Exceptions", "Review unusual cases without changing original events."],
      reports: ["Attendance Reports", "Daily, weekly, monthly, term and session views."],
      settings: ["Access & Context", "Central Registry identity, roles and school period."],
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
      if (["ADMIN_AUTH_FAILED", "ADMIN_SESSION_EXPIRED", "ADMIN_PERMISSION_DENIED", "RESULT_SESSION_NOT_ACTIVE", "RESULT_SESSION_REQUIRED", "ATTENDANCE_SESSION_REQUIRED", "CENTRAL_IDENTITY_NOT_ACTIVE"].includes(error.code)) void signOut();
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

  async function loadCredentialPeople() {
    const type = $("#credentialPersonType").value;
    const search = $("#credentialSearch").value.trim();
    const data = type === "student" ? await studentRead("students", { search }) : await staffRead("staff", { search });
    const people = type === "student" ? (data.students || []).map((person) => ({ ...person, personType: "student", displayName: person.name, secondary: `${person.class_key || ""}${person.admno ? ` · ${person.admno}` : ""}` })) : (data.staff || []).map((person) => ({ ...person, personType: "staff", displayName: person.full_name, secondary: `${person.designation || person.staff_category || ""}${person.staff_number ? ` · ${person.staff_number}` : ""}` }));
    if (type === "student") state.students = people; else state.staff = people;
    $("#credentialPeople").innerHTML = people.length ? people.map((person) => `<button class="person-item ${state.selectedPerson?.id === person.id ? "active" : ""}" data-person-id="${esc(person.id)}"><span class="avatar small-avatar">${avatarMarkup(person, "P")}</span><span><b>${esc(person.displayName)}</b><small>${esc(person.secondary || "")}</small></span><span>›</span></button>`).join("") : `<div class="empty">No live ${type === "student" ? "students" : "staff"} match that search.</div>`;
  }

  async function selectCredentialPerson(id) {
    const type = $("#credentialPersonType").value;
    const people = type === "student" ? state.students : state.staff;
    state.selectedPerson = people.find((person) => person.id === id) || null;
    if (!state.selectedPerson) return;
    $("#credentialEmpty").hidden = true;
    $("#credentialDetail").hidden = false;
    $("#credentialKind").textContent = type === "student" ? "PUPIL · CENTRAL REGISTRY" : "STAFF · CENTRAL REGISTRY";
    $("#credentialName").textContent = state.selectedPerson.displayName;
    $("#credentialMeta").textContent = state.selectedPerson.secondary;
    $("#credentialAvatar").innerHTML = avatarMarkup(state.selectedPerson);
    const data = await universalRead("credentials", { personType: type, personId: id });
    renderCredentialList(data.credentials || []);
    if (permission("devices.read") || permission("devices.manage") || globalScope()) await loadDevices(true);
    else setOptions("#credentialDevice", [], "Device assignment restricted");
  }

  function renderCredentialList(credentials) {
    $("#credentialList").innerHTML = credentials.length ? credentials.map((credential) => `<div class="credential-row"><div><b>${esc(cleanStatus(credential.credential_type))}</b><small>${esc(credential.credential_label || "Attendance credential")} · ending ${esc(credential.token_last4 || "----")}${credential.external_user_id ? ` · external ${esc(credential.external_user_id)}` : ""}</small></div><div><span class="badge ${statusClass(credential.status)}">${esc(cleanStatus(credential.status))}</span>${["active", "pending"].includes(credential.status) ? `<button class="mini-button" data-suspend-credential="${esc(credential.id)}">Suspend</button>` : ""}</div></div>`).join("") : `<div class="empty">No Attendance credential is assigned yet.</div>`;
  }

  async function digest(value) {
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function issueQr() {
    if (!state.selectedPerson) return toast("Select a real person first.", "error");
    const type = state.selectedPerson.personType;
    const payload = type === "student" ? { studentId: state.selectedPerson.id, credentialType: "qr", label: `${state.selectedPerson.displayName} secure QR` } : { staffId: state.selectedPerson.id, credentialType: "qr", label: `${state.selectedPerson.displayName} secure QR` };
    const data = type === "student" ? await studentWrite("issueCredential", payload) : await rpc("staff_attendance_admin_write_api", "issueCredential", payload);
    const raw = data.credential?.raw_token;
    if (raw) await showSecret("Secure QR attendance token", raw, true);
    toast("QR credential issued. The raw token is shown once.", "success");
    await selectCredentialPerson(state.selectedPerson.id);
  }

  async function assignCredential(event) {
    event.preventDefault();
    if (!state.selectedPerson) return toast("Select a real person first.", "error");
    const raw = $("#credentialRaw").value.trim();
    if (!raw) return toast("Tap the NFC card or enter its reader UID.", "error");
    const type = "nfc_uid";
    const payload = {
      ...(state.selectedPerson.personType === "student" ? { studentId: state.selectedPerson.id } : { staffId: state.selectedPerson.id }),
      credentialType: type,
      rawIdentifier: raw,
      label: $("#credentialLabel").value.trim() || "WTS NFC ID card",
      deviceId: $("#credentialDevice").value || null,
      metadata: { raw_hash: await digest(raw), source: "attendance_operator" },
    };
    await universalWrite("assignCredential", payload);
    $("#credentialRaw").value = "";
    toast("NFC card linked and activated.", "success");
    await selectCredentialPerson(state.selectedPerson.id);
  }

  async function loadDevices(forCredential = false) {
    const data = await universalRead("devices");
    state.devices = data.devices || [];
    const options = state.devices.map((device) => ({ value: device.id, label: `${device.device_name} · ${device.device_code}` }));
    if (forCredential) setOptions("#credentialDevice", options, "No reader selected");
    setOptions("#importDevice", options, "No device selected");
    $("#deviceEmpty").style.display = state.devices.length ? "none" : "block";
    $("#deviceGrid").innerHTML = state.devices.length ? state.devices.map((device) => `<article class="device-card"><div class="device-top"><div><small class="eyebrow">${esc(device.device_code)}</small><h3>${esc(device.device_name)}</h3></div><span class="badge ${statusClass(device.computed_status || device.status)}">${esc(cleanStatus(device.computed_status || device.status || "unknown"))}</span></div><div class="device-details"><div><span>Category</span><b>${esc(cleanStatus(device.device_type || "—"))}</b></div><div><span>Location</span><b>${esc(device.assigned_gate || device.location || "Unassigned")}</b></div><div><span>Connection</span><b>${esc(device.connection_type || "—")}</b></div><div><span>Sources</span><b>${esc((device.supported_sources || []).join(", ") || "—")}</b></div><div><span>Last sync</span><b>${esc(displayTime(device.last_sync_at))}</b></div><div><span>Health</span><b>${esc(cleanStatus(device.health_status || "unknown"))}</b></div></div></article>`).join("") : "";
  }

  async function addDevice() {
    const deviceCode = window.prompt("Unique code printed on or assigned to this school device:", "");
    if (!deviceCode?.trim()) return;
    const deviceName = window.prompt("Device name:", "");
    if (!deviceName?.trim()) return;
    const modality = (window.prompt("Credential method: qr, nfc, or both", "both") || "").trim().toLowerCase();
    if (!['qr', 'nfc', 'both'].includes(modality)) return toast("Choose qr, nfc, or both.", "error");
    const assignedGate = window.prompt("School location (for example Main gate):", "") || "";
    const connectionType = (window.prompt("Connection: wifi, mobile, usb, bluetooth, or mixed", modality === "nfc" ? "usb" : "wifi") || "wifi").trim().toLowerCase();
    const sources = modality === "both" ? ["qr", "nfc"] : [modality];
    const deviceType = modality === "qr" ? "web_scanner" : modality === "nfc" ? "usb_hid_reader" : "android_scanner";
    const result = await studentWrite("registerDevice", { deviceCode: deviceCode.trim(), deviceName: deviceName.trim(), deviceType, assignedGate, supportedSources: sources, connectionType, offlineEnabled: window.confirm("Should this device queue encrypted scans while offline?"), deploymentMode: "production" });
    if (result.device?.raw_secret) await showSecret("Device credential", result.device.raw_secret, false);
    toast("Real device registered. Store the device secret securely.", "success");
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

  async function mapSelectedImportRow() {
    const row = state.import.rows.find((item) => String(item.id) === String(state.import.selectedRowId));
    if (!row) return toast("Select an unknown import row first.", "error");
    const personType = window.prompt("Person type: student or staff", "student");
    if (!personType || !["student", "staff"].includes(personType.toLowerCase())) return;
    const personId = window.prompt("Enter the exact Central Registry person ID for this real identity:", "");
    if (!personId?.trim()) return;
    await universalWrite("mapImportRow", { rowId: row.id, [personType.toLowerCase() === "student" ? "studentId" : "staffId"]: personId.trim(), credentialType: "nfc_uid", rawIdentifier: row.raw_identifier, externalUserId: row.external_user_id, deviceId: $("#importDevice").value || null });
    const refreshed = await universalRead("import_rows", { batchId: state.import.batchId });
    state.import.rows = refreshed.rows || [];
    renderImportPreview();
    toast("Unknown row mapped to the selected real identity.", "success");
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
    $("#contextDetails").innerHTML = `<div><dt>Academic session</dt><dd>${esc(state.context?.session || config.operational_session || "—")}</dd></div><div><dt>Academic term</dt><dd>${esc(state.context?.term || config.operational_term || "—")}</dd></div><div><dt>Configuration source</dt><dd>Central Registry promotion context</dd></div><div><dt>Operator methods</dt><dd>QR pass and NFC card</dd></div><div><dt>Absence</dt><dd>Derived from expected roster and confirmed events</dd></div><div><dt>Parent notifications</dt><dd>${config.parent_notifications_enabled ? "Enabled by approved contract" : "Not enabled"}</dd></div>`;
    const permissions = state.context?.permissions || [];
    $("#roleDetails").innerHTML = permissions.length ? permissions.map((item) => `<span class="permission-chip">${esc(item)}</span>`).join("") : `<div class="empty">No Attendance actions were granted.</div>`;
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

  async function showSecret(title, value, makeQr = false) {
    $("#secretTitle").textContent = title;
    $("#secretValue").textContent = value;
    $("#qrPreview").hidden = !makeQr;
    $("#printQrDialog").hidden = !makeQr;
    state.lastQr = makeQr ? value : null;
    state.lastQrPersonId = makeQr ? state.selectedPerson?.id || null : null;
    if (makeQr && state.selectedPerson) {
      $("#printAvatar").innerHTML = avatarMarkup(state.selectedPerson);
      $("#printKind").textContent = state.selectedPerson.personType === "student" ? "STUDENT" : "STAFF";
      $("#printName").textContent = state.selectedPerson.displayName;
      $("#printMeta").textContent = state.selectedPerson.secondary || "Central Registry identity";
    }
    if (makeQr && window.WTS_VENDOR?.QRCode) {
      try { $("#qrPreview").src = await window.WTS_VENDOR.QRCode.toDataURL(value, { width: 260, margin: 2, errorCorrectionLevel: "M" }); } catch { $("#qrPreview").hidden = true; }
    }
    $("#secretDialog").showModal();
  }

  function printArea(className) {
    document.body.classList.add(className);
    window.setTimeout(() => { window.print(); window.setTimeout(() => document.body.classList.remove(className), 300); }, 20);
  }

  function wireEvents() {
    $$(".nav").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
    document.addEventListener("click", (event) => {
      const go = event.target.closest("[data-go]");
      if (go) openView(go.dataset.go);
      const person = event.target.closest("[data-person-id]");
      if (person) selectCredentialPerson(person.dataset.personId).catch((error) => toast(error.message, "error"));
      const credential = event.target.closest("[data-suspend-credential]");
      if (credential) universalWrite("suspendCredential", { credentialId: credential.dataset.suspendCredential, reason: window.prompt("Reason for suspension:", "Lost, damaged or replaced") || "Credential suspended" }).then(() => { toast("Credential suspended.", "success"); return selectCredentialPerson(state.selectedPerson.id); }).catch((error) => toast(error.message, "error"));
      if (event.target.closest("[data-review]")) reviewCorrection(event).catch((error) => toast(error.message, "error"));
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
    $("#credentialAssignForm").onsubmit = (event) => assignCredential(event).catch((error) => toast(error.message, "error"));
    $("#printQr").onclick = () => state.lastQr && state.lastQrPersonId === state.selectedPerson?.id ? showSecret("Secure QR attendance token", state.lastQr, true) : toast("Generate this person's QR pass before printing.", "error");
    $("#addDevice").onclick = () => addDevice().catch((error) => toast(error.message, "error"));
    $("#importFile").onchange = () => { const file = $("#importFile").files?.[0]; $("#importFileStatus").textContent = file ? `${file.name} selected. Preview before processing.` : "No file selected."; };
    $("#previewImport").onclick = () => previewImport().catch((error) => toast(error.message, "error"));
    $("#mapImportRow").onclick = () => mapSelectedImportRow().catch((error) => toast(error.message, "error"));
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
