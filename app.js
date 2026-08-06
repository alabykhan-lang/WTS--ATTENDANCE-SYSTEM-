"use strict";
(() => {
  const CFG = window.WTS_CONFIG;
  const STORE = "wts_attendance_session";
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
    register: { students: [], date: "", classKey: "", slot: "morning", lock: {} },
    staffRows: [],
    import: { batchId: null, rows: [], selectedRowId: null, file: null },
    lastQr: null,
  };

  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
  const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
  const cleanStatus = (value) => String(value || "incomplete").replaceAll("_", " ");
  const statusClass = (value) => String(value || "incomplete").toLowerCase().replace(/[^a-z0-9-]/g, "-");
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

  function auth() {
    try {
      const session = JSON.parse(sessionStorage.getItem(STORE) || "null");
      if (session?.code && session?.secret) return session;
    } catch {}
    throw new Error("Central Attendance access is required.");
  }

  async function rpc(name, action, payload = {}) {
    const session = auth();
    const response = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", apikey: CFG.publishableKey },
      body: JSON.stringify({ p_client_code: session.code, p_client_secret: session.secret, p_action: action, p_payload: payload }),
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
  const controlsRead = (action, payload = {}) => rpc("attendance_controls_admin_read_api", action, payload);
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

  function signOut() {
    sessionStorage.removeItem(STORE);
    state.connected = false;
    state.context = null;
    state.summary = null;
    connected(false);
    $("#adminSecret").value = "";
    $("#adminCode").focus();
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
    setOptions("#registerClass", options, "Choose class");
    setOptions("#reportClass", options, globalScope() ? "All classes" : "Choose class");
    if (!$("#registerClass").value && options[0]) $("#registerClass").value = options[0].value;
    if (!globalScope() && !$("#reportClass").value && options[0]) $("#reportClass").value = options[0].value;
  }

  function applyNavigation() {
    const gated = {
      register: permission("class.attendance.read") || permission("class.attendance.write") || permission("manual_entries.create"),
      staff: permission("staff.read") || permission("personal.attendance.read"),
      manual: permission("class.attendance.write") || permission("manual_entries.create"),
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
      overview: ["Attendance Overview", "One honest view of today’s school attendance."],
      register: ["Student Register", "Morning and afternoon records remain separate."],
      staff: ["Staff Logbook", "Arrival, departure and authorised exceptions."],
      manual: ["Manual Marking", "A supported input method with an audit trail."],
      scan: ["Scan / Live Events", "Server-confirmed capture from QR, cards and adapters."],
      credentials: ["Credentials", "Flexible identifiers linked to Central Registry people."],
      devices: ["Devices & Adapters", "Register only real hardware and approved sources."],
      imports: ["Import Centre", "Preview, resolve and process terminal exports safely."],
      corrections: ["Corrections", "Review requests without deleting original events."],
      reports: ["Attendance Reports", "Daily, weekly, monthly, term and session views."],
      settings: ["Attendance Settings", "Roles, schedule context and protected contracts."],
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
      if (viewName === "register") await loadRegister();
      if (viewName === "staff") await loadStaffLogbook();
      if (viewName === "manual") await loadManualPeople();
      if (viewName === "credentials") await loadCredentialPeople();
      if (viewName === "devices") await loadDevices();
      if (viewName === "imports") await loadImports();
      if (viewName === "corrections") await loadCorrections();
      if (viewName === "reports") await runReport();
      if (viewName === "settings") renderSettings();
    } catch (error) {
      toast(error.message, "error");
      if (["ADMIN_AUTH_FAILED", "ADMIN_SESSION_EXPIRED", "ADMIN_PERMISSION_DENIED"].includes(error.code)) signOut();
    }
  }

  function numberValue(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function summaryPart(summary, key) {
    return summary?.[key] ?? summary?.student?.[key] ?? 0;
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
    if (numberValue(student.waiting) > 0) attention.push(["Incomplete student registers", `${student.waiting} expected records are still waiting for confirmation.`, "register"]);
    if (numberValue(staff.waiting) > 0) attention.push(["Staff records need review", `${staff.waiting} staff records are not yet resolved for today.`, "staff"]);
    if (!attention.length) attention.push(["No open attention items", "Confirmed data will appear here as the school records attendance.", "reports"]);
    $("#attentionList").innerHTML = attention.map(([title, copy, viewName]) => `<button class="attention-item" data-go="${viewName}"><span class="attention-icon">!</span><span><b>${esc(title)}</b><small>${esc(copy)}</small></span><span>→</span></button>`).join("");
    const importCount = (imports.batches || []).length;
    $("#healthList").innerHTML = `<div class="health-item"><span class="health-check ${state.devices.length ? "good" : "muted"}">${state.devices.length ? "✓" : "–"}</span><div><b>${state.devices.length ? `${state.devices.length} registered device${state.devices.length === 1 ? "" : "s"}` : "No physical devices registered"}</b><small>${state.devices.length ? "Health status comes from the live Device Registry." : "Manual and QR workflows remain available."}</small></div></div><div class="health-item"><span class="health-check ${importCount ? "good" : "muted"}">${importCount ? "✓" : "–"}</span><div><b>${importCount ? `${importCount} import batch${importCount === 1 ? "" : "es"}` : "No imports yet"}</b><small>Imports are previewed and checksum-protected.</small></div></div>`;
  }

  function renderRegister() {
    const list = $("#registerList");
    const query = $("#registerSearch").value.trim().toLowerCase();
    const rows = state.register.students.filter((student) => !query || `${student.name} ${student.admno || ""}`.toLowerCase().includes(query));
    $("#registerCount").textContent = `${state.register.students.length} pupil${state.register.students.length === 1 ? "" : "s"}`;
    $("#registerHelp").textContent = state.register.lock?.status && state.register.lock.status !== "open" ? `Register is ${cleanStatus(state.register.lock.status)}.` : "Mark all present, then adjust exceptions.";
    $("#registerState").innerHTML = state.register.classKey ? `<span class="pill ${statusClass(state.register.lock?.status || "open")}">${esc(cleanStatus(state.register.lock?.status || "open"))}</span><span>${esc(state.register.classKey)} · ${displayDate(state.register.date)} · ${esc(state.register.slot)}</span>` : "";
    $("#registerEmpty").style.display = rows.length ? "none" : "block";
    list.innerHTML = rows.map((student) => `<div class="register-row ${student.id === state.register.selectedId ? "selected" : ""}" data-register-id="${esc(student.id)}"><div class="pupil-avatar">${esc((student.name || "P").slice(0, 1).toUpperCase())}</div><div class="person-copy"><strong>${esc(student.name)}</strong><small>${esc(student.admno || "No admission number")} · ${esc(student.class_key || state.register.classKey)}</small></div><div class="status-options">${["present", "absent", "late", "excused"].map((status) => `<button class="status-choice ${student.status === status ? `chosen ${statusClass(status)}` : ""}" data-status="${status}" title="${status}">${status === "present" ? "P" : status === "absent" ? "A" : status === "late" ? "L" : "E"}</button>`).join("")}<select class="status-select" data-status-select aria-label="More statuses"><option value="">More</option>${["official_activity", "sick_leave", "early_departure", "half_day", "school_activity", "not_expected", "school_closed", "incomplete"].map((status) => `<option value="${status}" ${student.status === status ? "selected" : ""}>${esc(cleanStatus(status))}</option>`).join("")}</select></div><button class="row-action" data-select-correction="${esc(student.id)}" title="Select for correction">⋯</button></div>`).join("");
  }

  async function loadRegister() {
    if (!$("#registerClass").value) fillClassSelectors();
    state.register.date = $("#registerDate").value || todayIso();
    state.register.classKey = $("#registerClass").value;
    state.register.slot = $("#registerSlot").value || "morning";
    if (!state.register.classKey) { renderRegister(); return; }
    const data = await universalRead("register", { date: state.register.date, classKey: state.register.classKey, sessionSlot: state.register.slot });
    state.register.students = data.students || [];
    state.register.lock = data.lock || {};
    state.register.classKey = data.class_key || state.register.classKey;
    renderRegister();
  }

  async function saveRegister() {
    if (!state.register.students.length) return toast("Load an expected class register first.", "error");
    const data = await universalWrite("saveRegister", { date: state.register.date, classKey: state.register.classKey, sessionSlot: state.register.slot, rows: state.register.students.map((student) => ({ studentId: student.id, status: student.status || "incomplete", note: student.note || null })) });
    toast(`${data.updated_count || 0} register row(s) saved.`, "success");
    await loadRegister();
  }

  async function confirmRegister() {
    if (!state.register.classKey) return toast("Choose a class first.", "error");
    try {
      await universalWrite("confirmRegister", { date: state.register.date, classKey: state.register.classKey, sessionSlot: state.register.slot });
      toast("Register confirmed and locked from casual editing.", "success");
      await loadRegister();
    } catch (error) {
      toast(error.code === "REGISTER_INCOMPLETE" ? "Complete every expected pupil before confirming." : error.message, "error");
    }
  }

  function renderStaff() {
    const query = $("#staffSection").value.trim().toLowerCase();
    const filter = $("#staffStatus").value;
    const rows = state.staffRows.filter((staff) => (!query || `${staff.department || ""} ${staff.designation || ""}`.toLowerCase().includes(query)) && (!filter || staff.status === filter));
    const counts = { present: 0, late: 0, absent: 0, incomplete: 0 };
    state.staffRows.forEach((row) => { if (row.status === "late") counts.late += 1; else if (row.status === "absent") counts.absent += 1; else if (row.status === "incomplete" || !row.departure) counts.incomplete += 1; else if (row.status === "present") counts.present += 1; });
    $("#staffPresentCount").textContent = counts.present;
    $("#staffLateCount").textContent = counts.late;
    $("#staffAbsentCount").textContent = counts.absent;
    $("#staffIncompleteCount").textContent = counts.incomplete;
    $("#staffEmpty").style.display = rows.length ? "none" : "block";
    $("#staffTable").innerHTML = rows.length ? `<div class="table-scroll"><table><thead><tr><th>Staff member</th><th>Position</th><th>Arrival</th><th>Departure</th><th>Status</th><th>Method</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${esc(row.full_name)}</strong><small>${esc(row.staff_number || "No staff number")}</small></td><td>${esc(row.designation || row.department || "—")}</td><td>${esc(displayTime(row.arrival))}</td><td>${esc(displayTime(row.departure))}</td><td><span class="badge ${statusClass(row.status)}">${esc(cleanStatus(row.status))}</span></td><td>${esc(cleanStatus(row.method || "manual"))}</td></tr>`).join("")}</tbody></table></div>` : "";
  }

  async function loadStaffLogbook() {
    $("#staffDate").value ||= todayIso();
    const data = await universalRead("staff_logbook", { date: $("#staffDate").value });
    state.staffRows = data.staff || [];
    renderStaff();
    setOptions("#manualStaffPerson", state.staffRows.map((staff) => ({ value: staff.id, label: `${staff.full_name}${staff.staff_number ? ` · ${staff.staff_number}` : ""}` })), "Choose staff member");
  }

  async function loadManualPeople() {
    if (!state.staffRows.length) await loadStaffLogbook();
    $("#manualStaffDate").value ||= todayIso();
    $("#manualStaffTime").value ||= new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  async function loadCredentialPeople() {
    const type = $("#credentialPersonType").value;
    const search = $("#credentialSearch").value.trim();
    const data = type === "student" ? await studentRead("students", { search }) : await staffRead("staff", { search });
    const people = type === "student" ? (data.students || []).map((person) => ({ ...person, personType: "student", displayName: person.name, secondary: `${person.class_key || ""}${person.admno ? ` · ${person.admno}` : ""}` })) : (data.staff || []).map((person) => ({ ...person, personType: "staff", displayName: person.full_name, secondary: `${person.designation || person.staff_category || ""}${person.staff_number ? ` · ${person.staff_number}` : ""}` }));
    if (type === "student") state.students = people; else state.staff = people;
    $("#credentialPeople").innerHTML = people.length ? people.map((person) => `<button class="person-item ${state.selectedPerson?.id === person.id ? "active" : ""}" data-person-id="${esc(person.id)}"><span class="avatar small-avatar">${esc((person.displayName || "P").slice(0, 1).toUpperCase())}</span><span><b>${esc(person.displayName)}</b><small>${esc(person.secondary || "")}</small></span><span>›</span></button>`).join("") : `<div class="empty">No live ${type === "student" ? "pupils" : "staff"} match that search.</div>`;
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
    $("#credentialAvatar").textContent = (state.selectedPerson.displayName || "W").slice(0, 1).toUpperCase();
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
    if (!raw) return toast("Enter the reader value or external device ID.", "error");
    const type = $("#credentialType").value;
    const payload = {
      ...(state.selectedPerson.personType === "student" ? { studentId: state.selectedPerson.id } : { staffId: state.selectedPerson.id }),
      credentialType: type,
      rawIdentifier: raw,
      label: $("#credentialLabel").value.trim() || "Attendance credential",
      deviceId: $("#credentialDevice").value || null,
      metadata: { raw_hash: await digest(raw), source: "attendance_operator" },
    };
    await universalWrite("assignCredential", payload);
    $("#credentialRaw").value = "";
    toast("Credential assigned and activated.", "success");
    await selectCredentialPerson(state.selectedPerson.id);
  }

  async function loadDevices(forCredential = false) {
    const data = await universalRead("devices");
    state.devices = data.devices || [];
    if (forCredential) setOptions("#credentialDevice", state.devices.map((device) => ({ value: device.id, label: `${device.device_name} · ${device.device_code}` })), "No device selected");
    $("#deviceEmpty").style.display = state.devices.length ? "none" : "block";
    $("#deviceGrid").innerHTML = state.devices.length ? state.devices.map((device) => `<article class="device-card"><div class="device-top"><div><small class="eyebrow">${esc(device.device_code)}</small><h3>${esc(device.device_name)}</h3></div><span class="badge ${statusClass(device.computed_status || device.status)}">${esc(cleanStatus(device.computed_status || device.status || "unknown"))}</span></div><div class="device-details"><div><span>Category</span><b>${esc(cleanStatus(device.device_type || "—"))}</b></div><div><span>Location</span><b>${esc(device.assigned_gate || device.location || "Unassigned")}</b></div><div><span>Connection</span><b>${esc(device.connection_type || "—")}</b></div><div><span>Sources</span><b>${esc((device.supported_sources || []).join(", ") || "—")}</b></div><div><span>Last sync</span><b>${esc(displayTime(device.last_sync_at))}</b></div><div><span>Health</span><b>${esc(cleanStatus(device.health_status || "unknown"))}</b></div></div></article>`).join("") : "";
  }

  async function addDevice() {
    const deviceCode = window.prompt("Exact device code from the purchased terminal (required):", "");
    if (!deviceCode?.trim()) return;
    const deviceName = window.prompt("Device name:", "");
    if (!deviceName?.trim()) return;
    const deviceType = window.prompt("Device category (standalone_terminal, usb_hid_reader, usb_ccid_reader, android_scanner, web_scanner):", "standalone_terminal");
    if (!deviceType?.trim()) return;
    const assignedGate = window.prompt("Physical location:", "") || "";
    const connectionType = window.prompt("Connection (wifi, ethernet, cellular, usb or mixed):", "wifi") || "wifi";
    const sources = deviceType === "standalone_terminal" ? ["standalone_terminal"] : deviceType === "usb_hid_reader" ? ["usb_hid"] : deviceType === "usb_ccid_reader" ? ["usb_ccid"] : ["qr", "nfc", "rfid"];
    const result = await studentWrite("registerDevice", { deviceCode: deviceCode.trim(), deviceName: deviceName.trim(), deviceType: deviceType.trim(), assignedGate, supportedSources: sources, connectionType, offlineEnabled: window.confirm("Will this device store logs while offline?"), deploymentMode: "production" });
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
    const credentialType = window.prompt("Credential type (external_device_user_id, nfc_uid, rfid_uid, generic_card_uid):", "external_device_user_id");
    if (!credentialType?.trim()) return;
    await universalWrite("mapImportRow", { rowId: row.id, [personType.toLowerCase() === "student" ? "studentId" : "staffId"]: personId.trim(), credentialType: credentialType.trim(), rawIdentifier: row.raw_identifier, externalUserId: row.external_user_id, deviceId: $("#importDevice").value || null });
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
    const data = await universalRead("report", { from, to, classKey: $("#reportClass").value || null, reportType: $("#reportType").value });
    const studentRows = data.student_rows || [];
    const classRows = data.class_rows || [];
    $("#reportSummary").innerHTML = `<b>${esc(displayDate(from))} – ${esc(displayDate(to))}</b><span>${esc(data.session || state.context?.session || "Current session")} · ${esc(data.term || state.context?.term || "Current term")}</span><span>${studentRows.length} pupil summaries · possible sessions are eligible AM/PM sessions.</span>`;
    $("#studentReportRows").innerHTML = studentRows.length ? studentRows.map((row) => `<div class="report-row"><div><b>${esc(row.name)}</b><small>${esc(row.class_key || "")}${row.admno ? ` · ${esc(row.admno)}` : ""}</small></div><div><strong>${numberValue(row.attendance_percentage).toFixed(2)}%</strong><small>${numberValue(row.actual_sessions)}/${numberValue(row.possible_sessions)} actual · ${numberValue(row.incomplete_sessions)} incomplete</small></div></div>`).join("") : `<div class="empty">No eligible pupil summaries for this period.</div>`;
    $("#classReportRows").innerHTML = classRows.length ? classRows.map((row) => `<div class="report-row"><div><b>${esc(row.class_key)}</b><small>${numberValue(row.incomplete_sessions)} incomplete sessions</small></div><div><strong>${numberValue(row.attendance_percentage).toFixed(2)}%</strong><small>${numberValue(row.actual_sessions)}/${numberValue(row.possible_sessions)} actual</small></div></div>`).join("") : `<div class="empty">No class summaries for this period.</div>`;
  }

  function renderSettings() {
    const config = state.context?.config || {};
    $("#contextDetails").innerHTML = `<div><dt>Academic session</dt><dd>${esc(state.context?.session || config.operational_session || "—")}</dd></div><div><dt>Academic term</dt><dd>${esc(state.context?.term || config.operational_term || "—")}</dd></div><div><dt>Configuration source</dt><dd>Central Registry promotion context</dd></div><div><dt>Enabled modalities</dt><dd>${esc((config.enabled_modalities || []).join(", ") || "Manual / QR / card ready")}</dd></div><div><dt>Automatic absence</dt><dd>${config.automatic_absence_enabled ? "Enabled by policy" : "Not enabled"}</dd></div><div><dt>Parent notifications</dt><dd>${config.parent_notifications_enabled ? "Enabled by approved contract" : "Not enabled"}</dd></div>`;
    const permissions = state.context?.permissions || [];
    $("#roleDetails").innerHTML = permissions.length ? permissions.map((item) => `<span class="permission-chip">${esc(item)}</span>`).join("") : `<div class="empty">No Attendance actions were granted.</div>`;
  }

  async function showSecret(title, value, makeQr = false) {
    $("#secretTitle").textContent = title;
    $("#secretValue").textContent = value;
    $("#qrPreview").hidden = !makeQr;
    $("#printQrDialog").hidden = !makeQr;
    state.lastQr = makeQr ? value : null;
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
      const statusButton = event.target.closest("[data-register-id] [data-status]");
      if (statusButton) { const row = state.register.students.find((student) => student.id === statusButton.closest("[data-register-id]").dataset.registerId); if (row) { row.status = statusButton.dataset.status; renderRegister(); } }
      const statusSelect = event.target.closest("[data-status-select]");
      if (statusSelect) { const row = state.register.students.find((student) => student.id === statusSelect.closest("[data-register-id]").dataset.registerId); if (row && statusSelect.value) { row.status = statusSelect.value; renderRegister(); } }
      const selectCorrection = event.target.closest("[data-select-correction]");
      if (selectCorrection) { state.register.selectedId = selectCorrection.dataset.selectCorrection; $("#correctionRecordId").value = state.register.students.find((student) => student.id === state.register.selectedId)?.record_id || ""; toast("Register row selected for correction request."); }
    });
    $("#refresh").onclick = () => loadContext().catch((error) => toast(error.message, "error"));
    $("#login").onclick = signOut;
    $("#loadRegister").onclick = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#registerDate").onchange = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#registerClass").onchange = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#registerSlot").onchange = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#registerSearch").oninput = renderRegister;
    $("#markAllPresent").onclick = () => { state.register.students.forEach((student) => { student.status = "present"; }); renderRegister(); };
    $("#saveRegister").onclick = () => saveRegister().catch((error) => toast(error.message, "error"));
    $("#confirmRegister").onclick = () => confirmRegister().catch((error) => toast(error.message, "error"));
    $("#printRegister").onclick = () => printArea("print-register");
    $("#registerCorrectionForm").onsubmit = async (event) => { event.preventDefault(); const recordId = $("#correctionRecordId").value; if (!recordId) return toast("Select a saved register row first.", "error"); await universalWrite("createRegisterCorrection", { personType: "student", recordId, requestedStatus: $("#correctionStatus").value, requestedNote: "Register correction requested", reason: $("#correctionReason").value.trim() }); $("#correctionReason").value = ""; toast("Correction request submitted.", "success"); };
    $("#loadStaffLogbook").onclick = () => loadStaffLogbook().catch((error) => toast(error.message, "error"));
    $("#staffDate").onchange = () => loadStaffLogbook().catch((error) => toast(error.message, "error"));
    $("#staffSection").oninput = renderStaff;
    $("#staffStatus").onchange = renderStaff;
    $("#printStaff").onclick = () => printArea("print-staff");
    $("#manualStaffForm").onsubmit = async (event) => { event.preventDefault(); const date = $("#manualStaffDate").value, time = $("#manualStaffTime").value; await controlsWrite("createManualEntry", { personType: "staff", personId: $("#manualStaffPerson").value, attendanceDate: date, eventType: $("#manualStaffEvent").value, eventTime: `${date}T${time}:00+01:00`, reasonCode: "manual_operator", reason: $("#manualStaffReason").value.trim(), session: state.context?.session, term: state.context?.term }); $("#manualStaffReason").value = ""; toast("Staff manual entry submitted for review.", "success"); };
    $("#refreshScanEvents").onclick = () => loadOverview().then(() => renderEvents("#scanEvents", [...(state.summary?.latest_events || []), ...(state.summary?.staff?.latest_events || [])])).catch((error) => toast(error.message, "error"));
    $("#credentialPersonType").onchange = () => { state.selectedPerson = null; $("#credentialDetail").hidden = true; $("#credentialEmpty").hidden = false; loadCredentialPeople().catch((error) => toast(error.message, "error")); };
    $("#searchCredentials").onclick = () => loadCredentialPeople().catch((error) => toast(error.message, "error"));
    $("#credentialSearch").onkeydown = (event) => { if (event.key === "Enter") loadCredentialPeople().catch((error) => toast(error.message, "error")); };
    $("#issueQr").onclick = () => issueQr().catch((error) => toast(error.message, "error"));
    $("#credentialAssignForm").onsubmit = (event) => assignCredential(event).catch((error) => toast(error.message, "error"));
    $("#printQr").onclick = () => state.lastQr ? showSecret("Secure QR attendance token", state.lastQr, true) : toast("Issue a QR credential first.", "error");
    $("#addDevice").onclick = () => addDevice().catch((error) => toast(error.message, "error"));
    $("#importFile").onchange = () => { const file = $("#importFile").files?.[0]; $("#importFileStatus").textContent = file ? `${file.name} selected. Preview before processing.` : "No file selected."; };
    $("#previewImport").onclick = () => previewImport().catch((error) => toast(error.message, "error"));
    $("#mapImportRow").onclick = () => mapSelectedImportRow().catch((error) => toast(error.message, "error"));
    $("#confirmImport").onclick = () => confirmImport().catch((error) => toast(error.message, "error"));
    $("#refreshImports").onclick = () => loadImports().catch((error) => toast(error.message, "error"));
    $("#refreshCorrections").onclick = () => loadCorrections().catch((error) => toast(error.message, "error"));
    $("#runReport").onclick = () => runReport().catch((error) => toast(error.message, "error"));
    $("#printReport").onclick = () => printArea("print-report");
    $("#closeSecret").onclick = () => $("#secretDialog").close();
    $("#closeSecretButton").onclick = () => $("#secretDialog").close();
    $("#copySecret").onclick = () => navigator.clipboard?.writeText($("#secretValue").textContent).then(() => toast("Copied to clipboard.", "success"));
    $("#printQrDialog").onclick = () => printArea("print-qr");
    $("#registerDate").value = todayIso();
    $("#staffDate").value = todayIso();
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

  $("#gateForm").onsubmit = async (event) => {
    event.preventDefault();
    $("#authError").textContent = "Checking central Attendance access…";
    sessionStorage.setItem(STORE, JSON.stringify({ code: $("#adminCode").value.trim(), secret: $("#adminSecret").value }));
    try { await loadContext(); $("#authError").textContent = ""; toast("Attendance workspace opened.", "success"); }
    catch (error) { sessionStorage.removeItem(STORE); connected(false, error.message); $("#adminSecret").value = ""; }
  };

  wireEvents();
  connected(false);
  try { const existing = auth(); $("#adminCode").value = existing.code; loadContext().catch(() => signOut()); } catch { $("#adminCode").focus(); }
})();
