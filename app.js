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
    lastQrCodes: [],
    qrBatchBusy: false,
    rosterSync: null,
    dashboardSlot: "morning",
    register: { date: "", slot: "morning", classKey: "", rows: [], lock: {} },
    staffPeople: [],
    staffLogbook: [],
    staffHistory: [],
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
  const todayIso = () => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
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
        INVALID_DEVICE_METHOD: "Choose QR codes as the device source.",
        CREDENTIAL_ALREADY_ASSIGNED: "This credential is already linked to somebody else.",
        QR_USED_CARD_REQUIRES_REPLACEMENT: "This QR has already recorded attendance. Replace it only if the printed QR was lost or damaged.",
        QR_REPLACEMENT_NOT_ALLOWED_BEFORE_USE: "This QR has not been used yet. Generate or download it again; replacement is only for a used QR that was lost or damaged.",
        QR_INITIAL_RESET_NOT_ALLOWED_AFTER_USE: "This QR has already been used. It was not changed automatically; replace it only after loss or damage.",
        QR_REPRINT_UNAVAILABLE: "This older QR is being refreshed automatically because it has not been used yet.",
        QR_CREDENTIAL_NOT_REPLACEABLE: "That QR has already been replaced or expired.",
        QR_REPLACEMENT_FAILED: "The replacement did not complete, so the old QR was left unchanged.",
        PERSON_TYPE_REQUIRED: "Choose Students or Staff before searching.",
        REGISTER_LOCKED: "This attendance record is locked. Use the controlled correction workflow.",
        STAFF_INACTIVE: "That staff identity is no longer active in Central Registry.",
        STAFF_EVENT_TIME_REQUIRED: "Enter the actual arrival or closing time for this staff record.",
      };
      const error = new Error(data?.message || friendlyErrors[data?.code] || "Attendance could not complete that request.");
      error.code = data?.code;
      throw error;
    }
    return data;
  }

  const universalRead = (action, payload = {}) => rpc("attendance_universal_admin_read_api", action, payload);
  const notebookRead = (action, payload = {}) => rpc("attendance_notebook_read_api", action, payload);
  const universalWrite = (action, payload = {}) => rpc("attendance_universal_admin_write_api", action, payload);
  const notebookWrite = (action, payload = {}) => rpc("attendance_notebook_write_api", action, payload);
  const qrWrite = (action, payload = {}) => rpc("attendance_qr_card_api", action, payload);
  const controlsWrite = (action, payload = {}) => rpc("attendance_controls_admin_write_api", action, payload);
  const staffRead = (action, payload = {}) => rpc("staff_attendance_admin_read_api", action, payload);

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
    setOptions("#qrBatchClass", options, "Choose a class");
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
    if ($("#staffManualPanel")) {
      $("#staffManualPanel").hidden = !(permission("manual_entries.create") || permission("staff.manage") || permission("*"));
    }
  }

  function setTitle(viewName) {
    const titles = {
      overview: ["Dashboard", "Today's attendance in one place."],
      scan: ["Take Attendance", "Keep the QR scanner ready or open a class register."],
      credentials: ["QR Codes Generation", "Generate and print attendance QR codes for students and staff."],
      devices: ["Authorized QR Devices", "Register the devices allowed to send attendance."],
      imports: ["Import Centre", "Reconcile QR scanner records saved for later."],
      corrections: ["Corrections", "Review a controlled attendance change."],
      reports: ["Analysis", "See student and staff attendance by day, week, month, term, or session."],
      settings: ["Setup", "Manage QR capture, devices, imports and the official school context."],
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
      if (viewName === "scan") { await loadRegister(); await loadStaffManualPeople(); }
      if (viewName === "credentials") await loadCredentialPeople();
      if (viewName === "devices") await loadDevices();
      if (viewName === "imports") await loadImports();
      if (viewName === "corrections") await loadCorrections();
      if (viewName === "reports") { await runReport(); await loadStaffAnalysis(); }
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
    const date = todayIso();
    let summary;
    try {
      summary = await notebookRead("dashboard", { date, sessionSlot: state.dashboardSlot });
    } catch (error) {
      // Keep the dashboard usable while an older Supabase schema cache rolls
      // forward. The established whole-day snapshot is a safe read-only
      // fallback; the notebook contract is used as soon as it is available.
      if (error.code !== "ATTENDANCE_SERVICE_UNAVAILABLE" && error.code !== "ATTENDANCE_RPC_NOT_ALLOWED") throw error;
      summary = await universalRead("summary", { date });
    }
    const [devices, imports] = await Promise.all([
      permission("devices.read") || permission("devices.manage") || globalScope() ? universalRead("devices") : Promise.resolve({ devices: [] }),
      permission("imports.read") || permission("imports.manage") || globalScope() ? universalRead("imports") : Promise.resolve({ batches: [] }),
    ]);
    state.summary = summary;
    state.devices = devices.devices || [];
    const student = summary.student || summary;
    const staff = summary.staff || {};
    const slotLabel = state.dashboardSlot === "afternoon" ? "Afternoon closing" : "Morning arrival";
    $$("[data-dashboard-slot]").forEach((button) => button.classList.toggle("active", button.dataset.dashboardSlot === state.dashboardSlot));
    $("#todayHeading").textContent = `${slotLabel} attendance`;
    $("#sExpected").textContent = numberValue(student.expected);
    $("#sPresent").textContent = numberValue(student.present);
    $("#sLate").textContent = numberValue(student.late);
    $("#sAbsent").textContent = numberValue(student.absent);
    $("#sUnconfirmed").textContent = numberValue(student.unconfirmed_classes ?? (student.class_summary || []).filter((item) => numberValue(item.waiting) > 0 || !["confirmed", "closed"].includes(item.register_status)).length);
    $("#tPresent").textContent = numberValue(staff.present);
    $("#today").textContent = `${new Date(`${date}T00:00:00`).toLocaleDateString("en-NG", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${slotLabel}`;
    $("#studentPresenceNote").textContent = state.dashboardSlot === "afternoon" ? "Valid closing scan" : "First valid arrival scan";
    $("#staffPresenceNote").textContent = state.dashboardSlot === "afternoon" ? "Staff closing records" : "Staff arrival records";
    const events = [...(student.latest_events || []), ...(staff.latest_events || [])].sort((a, b) => String(b.event_time || b.recorded_at).localeCompare(String(a.event_time || a.recorded_at)));
    renderEvents("#recentEvents", events);
    const classRows = student.class_summary || student.classes || [];
    $("#classSummary").innerHTML = classRows.length ? classRows.map((item) => `<div class="class-row"><div><strong>${esc(item.class_key || item.class || "Class")}</strong><small>${numberValue(item.expected)} expected · ${numberValue(item.waiting)} unconfirmed</small></div><div class="class-progress"><span style="width:${Math.min(100, numberValue(item.expected) ? ((numberValue(item.present) + numberValue(item.late)) / numberValue(item.expected)) * 100 : 0)}%"></span></div><b>${numberValue(item.present) + numberValue(item.late)}/${numberValue(item.expected)}</b></div>`).join("") : `<div class="empty">No active class placements are available.</div>`;
    const attention = [];
    if (numberValue(student.unconfirmed_classes) > 0 || numberValue(student.waiting) > 0) attention.push(["Class registers need review", `${numberValue(student.unconfirmed_classes || student.waiting)} class/session record(s) are still unresolved.`, "scan"]);
    if (numberValue(staff.waiting) > 0) attention.push(["Staff records need review", `${staff.waiting} staff record(s) are still unresolved.`, "reports"]);
    if (!attention.length) attention.push(["No open attention items", "Confirmed data will appear here as the school records attendance.", "reports"]);
    $("#attentionList").innerHTML = attention.map(([title, copy, viewName]) => `<button class="attention-item" data-go="${viewName}"><span class="attention-icon">!</span><span><b>${esc(title)}</b><small>${esc(copy)}</small></span><span>→</span></button>`).join("");
    const importCount = (imports.batches || []).length;
    $("#healthList").innerHTML = `<div class="health-item"><span class="health-check ${state.devices.length ? "good" : "muted"}">${state.devices.length ? "✓" : "–"}</span><div><b>${state.devices.length ? `${state.devices.length} authorized QR device${state.devices.length === 1 ? "" : "s"}` : "QR camera ready"}</b><small>${state.devices.length ? "Status comes from the protected Device Registry." : "Register a school device when a dedicated scanner is ready."}</small></div></div><div class="health-item"><span class="health-check ${importCount ? "good" : "muted"}">${importCount ? "✓" : "–"}</span><div><b>${importCount ? `${importCount} import batch${importCount === 1 ? "" : "es"}` : "No saved scanner imports yet"}</b><small>Saved records are previewed, matched and administrator-confirmed.</small></div></div>`;
  }

  const registerStatuses = [
    ["present", "Present"],
    ["late", "Late"],
    ["absent", "Absent"],
    ["excused", "Excused"],
    ["official_activity", "Official activity"],
    ["sick_leave", "Sick leave"],
    ["not_expected", "Not expected"],
    ["incomplete", "Incomplete"],
  ];

  function registerStatusLabel(value) {
    return registerStatuses.find(([status]) => status === value)?.[1] || cleanStatus(value || "Incomplete");
  }

  function registerLocked() {
    return ["confirmed", "closed", "archived"].includes(String(state.register.lock?.status || "").toLowerCase());
  }

  function renderRegister() {
    const rows = state.register.rows || [];
    const locked = registerLocked();
    const lockStatus = String(state.register.lock?.status || "open").toLowerCase();
    const incomplete = rows.filter((row) => !row.status || row.status === "incomplete").length;
    const label = state.register.slot === "afternoon" ? "Afternoon closing" : "Morning arrival";
    const lockLabel = ["confirmed", "closed", "archived"].includes(lockStatus) ? cleanStatus(lockStatus) : incomplete ? `${incomplete} incomplete` : "Open";
    const stateNode = $("#registerState");
    if (stateNode) {
      stateNode.textContent = lockLabel;
      stateNode.className = `pill ${statusClass(lockStatus === "open" && incomplete ? "pending" : lockStatus)}`;
    }
    if ($("#registerHeading")) $("#registerHeading").textContent = `${state.register.classKey || "Class"} · ${label}`;
    if ($("#registerSubheading")) $("#registerSubheading").textContent = `${displayDate(state.register.date)} · ${rows.length} pupil record(s) · ${state.context?.session || "Current session"} · ${state.context?.term || "Current term"}`;
    ["#markAllPresent", "#saveRegister", "#confirmRegister", "#printRegister"].forEach((selector) => {
      if ($(selector)) $(selector).disabled = !rows.length || locked;
    });
    $("#registerList").innerHTML = rows.length ? rows.map((row, index) => {
      const current = row.status || "incomplete";
      const person = { displayName: row.name, photo: row.photo };
      return `<div class="register-row ${current === "incomplete" ? "needs-entry" : ""}"><span class="pupil-avatar">${avatarMarkup(person, row.name || "P")}</span><span class="person-copy"><strong>${esc(row.name || "Unnamed pupil")}</strong><small>${esc(row.admno || "No admission number")}${row.gender ? ` · ${esc(row.gender)}` : ""}</small></span><label class="register-status-control"><span class="sr-only">Attendance status for ${esc(row.name || "pupil")}</span><select class="status-select" data-register-status="${index}" ${locked ? "disabled" : ""}>${registerStatuses.map(([value, name]) => `<option value="${value}" ${value === current ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label><input class="register-note-input" data-register-note="${index}" value="${esc(row.note || "")}" placeholder="Note" aria-label="Note for ${esc(row.name || "pupil")}" ${locked ? "disabled" : ""}><span class="row-check" aria-hidden="true">${current === "incomplete" ? "–" : "✓"}</span></div>`;
    }).join("") : `<div class="empty">Open a class register to begin. The active Central Registry roster will appear here.</div>`;
  }

  async function loadRegister() {
    const date = $("#registerDate")?.value || todayIso();
    const slot = $("#registerSlot")?.value || "morning";
    let classKey = $("#registerClass")?.value || "";
    if (!classKey) {
      classKey = contextClasses()[0]?.value || "";
      if ($("#registerClass") && classKey) $("#registerClass").value = classKey;
    }
    if (!classKey) {
      state.register = { date, slot, classKey: "", rows: [], lock: {} };
      renderRegister();
      return;
    }
    const data = await universalRead("register", { date, sessionSlot: slot, classKey });
    state.register = { date, slot, classKey, rows: data.students || [], lock: data.lock || {} };
    renderRegister();
  }

  function registerRowsFromDom() {
    return (state.register.rows || []).map((row, index) => ({
      studentId: row.id,
      status: $("[data-register-status=\"" + index + "\"]")?.value || row.status || "incomplete",
      note: $("[data-register-note=\"" + index + "\"]")?.value.trim() || null,
    }));
  }

  async function saveManualRegister({ silent = false } = {}) {
    if (!state.register.classKey || !state.register.rows.length) return toast("Open a class register first.", "warning");
    if (registerLocked()) return toast("This register is locked. Use the controlled correction workflow.", "warning");
    const rows = registerRowsFromDom();
    await universalWrite("saveRegister", { date: state.register.date, sessionSlot: state.register.slot, classKey: state.register.classKey, rows });
    if (!silent) toast("Register saved. Confirm it after every row is complete.", "success");
    await loadRegister();
    await loadOverview();
  }

  async function confirmManualRegister() {
    if (!state.register.classKey || !state.register.rows.length) return toast("Open a class register first.", "warning");
    if (registerLocked()) return toast("This register is already locked.", "warning");
    const rows = registerRowsFromDom();
    if (rows.some((row) => row.status === "incomplete")) return toast("Complete every pupil row before confirming the register.", "error");
    await universalWrite("saveRegister", { date: state.register.date, sessionSlot: state.register.slot, classKey: state.register.classKey, rows });
    await universalWrite("confirmRegister", { date: state.register.date, sessionSlot: state.register.slot, classKey: state.register.classKey });
    toast("Register confirmed and locked.", "success");
    await loadRegister();
    await loadOverview();
  }

  function markAllRegisterPresent() {
    if (registerLocked()) return toast("This register is locked.", "warning");
    $$('[data-register-status]').forEach((select) => { select.value = "present"; });
    toast("All rows are marked present. Save or confirm to record the change.", "success");
  }

  const canRecordStaffManually = () => permission("manual_entries.create") || permission("staff.manage") || permission("*");

  function localClock() {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
  }

  async function loadStaffManualPeople() {
    if (!canRecordStaffManually()) return;
    let data;
    try {
      data = await staffRead("staff");
    } catch (error) {
      if (error.code !== "ADMIN_PERMISSION_DENIED") throw error;
      const fallback = await universalRead("people", { personType: "staff" });
      data = { staff: fallback.people || [] };
    }
    state.staffPeople = data.staff || [];
    setOptions("#staffManualPerson", state.staffPeople.map((person) => ({
      value: person.id,
      label: `${person.full_name || person.display_name || "Staff"}${person.staff_number ? ` · ${person.staff_number}` : ""}`,
    })), "Choose a staff member");
  }

  async function saveManualStaff(event) {
    event?.preventDefault();
    if (!canRecordStaffManually()) return toast("Manual staff attendance is restricted to authorized Attendance officers.", "error");
    const staffId = $("#staffManualPerson")?.value;
    const attendanceDate = $("#staffManualDate")?.value || todayIso();
    const sessionSlot = $("#staffManualSlot")?.value || "morning";
    const eventType = $("#staffManualEventType")?.value || "check_in";
    const eventClock = $("#staffManualTime")?.value || "";
    const status = $("#staffManualStatus")?.value || "auto";
    const note = $("#staffManualNote")?.value.trim() || null;
    const noTimeStatuses = new Set(["absent", "leave", "official_assignment", "sick_leave", "half_day", "excused", "not_expected", "school_closed"]);
    if (!staffId) return toast("Choose a real staff member first.", "warning");
    if (!eventClock && (status === "auto" || !noTimeStatuses.has(status))) return toast("Enter the actual arrival or closing time.", "warning");
    const result = await notebookWrite("manualStaffAttendance", {
      staffId,
      attendanceDate,
      sessionSlot,
      eventType,
      eventClock: eventClock || null,
      status,
      note,
    });
    const personName = result.staff?.name || "Staff record";
    toast(`${personName} recorded: ${cleanStatus(result.attendance?.status || status)}.`, "success");
    $("#staffManualNote").value = "";
    $("#staffManualStatus").value = "auto";
    $("#staffManualTime").value = localClock();
    await Promise.all([loadStaffLogbook(), loadOverview()]);
  }

  async function loadStaffLogbook() {
    const date = $("#staffLogbookDate")?.value || todayIso();
    try {
      const data = await universalRead("staff_logbook", { date });
      state.staffLogbook = data.staff || [];
    } catch (error) {
      state.staffLogbook = [];
      if ($("#staffLogbookRows")) $("#staffLogbookRows").innerHTML = `<tr><td colspan="9" class="empty">Staff logbook is not available for this account.</td></tr>`;
      throw error;
    }
    const rows = [...state.staffLogbook].sort((a, b) => String(a.arrival || "9999").localeCompare(String(b.arrival || "9999")) || String(a.full_name || "").localeCompare(String(b.full_name || "")));
    $("#staffLogbookRows").innerHTML = rows.length ? rows.map((row, index) => {
      const hasDeparture = Boolean(row.departure);
      const status = row.status || "incomplete";
      return `<tr><td>${index + 1}</td><td><strong>${esc(row.full_name || "Unnamed staff")}</strong>${row.department ? `<small>${esc(row.department)}</small>` : ""}</td><td>${esc(row.staff_number || "—")}</td><td>${esc(row.designation || "—")}</td><td>${esc(displayTime(row.arrival))}</td><td><span class="badge ${statusClass(status)}">${esc(cleanStatus(status))}</span></td><td>${esc(displayTime(row.departure))}</td><td><span class="badge ${hasDeparture ? "recorded" : "incomplete"}">${hasDeparture ? "Recorded" : "Not yet recorded"}</span></td><td>${esc(row.method || "QR / manual")}</td></tr>`;
    }).join("") : `<tr><td colspan="9" class="empty">No staff attendance has been recorded for this date.</td></tr>`;
    return rows;
  }

  async function loadStaffAnalysis() {
    const date = $("#staffLogbookDate")?.value || todayIso();
    if ($("#staffLogbookDate") && !$("#staffLogbookDate").value) $("#staffLogbookDate").value = date;
    if ($("#staffHistoryFrom") && !$("#staffHistoryFrom").value) $("#staffHistoryFrom").value = monthStart();
    if ($("#staffHistoryTo") && !$("#staffHistoryTo").value) $("#staffHistoryTo").value = date;
    try {
      const [snapshot, people] = await Promise.all([staffRead("snapshot", { date, session: state.context?.session }), staffRead("staff")]);
      const summary = snapshot.staff || snapshot || {};
      $("#staffExpected").textContent = numberValue(summary.expected);
      $("#staffPresent").textContent = numberValue(summary.present);
      $("#staffLate").textContent = numberValue(summary.late);
      $("#staffWaiting").textContent = numberValue(summary.waiting);
      state.staffPeople = people.staff || [];
      setOptions("#staffAnalysisPerson", state.staffPeople.map((person) => ({ value: person.id, label: `${person.full_name || person.display_name || "Staff"}${person.staff_number ? ` · ${person.staff_number}` : ""}` })), "Choose a staff member for history");
      $("#staffHistoryRows").innerHTML = `<div class="empty">Choose a staff member to view daily history.</div>`;
    } catch (error) {
      $("#staffExpected").textContent = "—";
      $("#staffPresent").textContent = "—";
      $("#staffLate").textContent = "—";
      $("#staffWaiting").textContent = "—";
      $("#staffHistoryRows").innerHTML = `<div class="empty">Staff analysis requires the staff attendance read permission.</div>`;
      if (error.code !== "ADMIN_PERMISSION_DENIED") throw error;
    }
    try {
      await loadStaffLogbook();
    } catch (error) {
      if (error.code !== "ADMIN_PERMISSION_DENIED") throw error;
    }
  }

  async function loadStaffHistory() {
    const staffId = $("#staffAnalysisPerson")?.value;
    if (!staffId) return toast("Choose a staff member first.", "warning");
    const from = $("#staffHistoryFrom")?.value || monthStart();
    const to = $("#staffHistoryTo")?.value || todayIso();
    const data = await staffRead("history", { staffId, from, to });
    state.staffHistory = data.history || [];
    const person = state.staffPeople.find((item) => String(item.id) === String(staffId));
    $("#staffHistoryRows").innerHTML = state.staffHistory.length ? state.staffHistory.map((row) => `<div class="report-row"><div><b>${esc(displayDate(row.attendance_date))}</b><small>${esc(person?.full_name || "Selected staff")}${row.note ? ` · ${esc(row.note)}` : ""}</small></div><div><strong class="history-status">${esc(cleanStatus(row.daily_status || "incomplete"))}</strong><small>${esc(displayTime(row.first_check_in))} arrival · ${esc(displayTime(row.last_check_out))} closing${numberValue(row.late_minutes) ? ` · ${numberValue(row.late_minutes)} min late` : ""}</small></div></div>`).join("") : `<div class="empty">No daily staff records for the selected period.</div>`;
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
      const hasBeenUsed = Boolean(credential.last_used_at);
      const method = isQr ? "Permanent attendance QR" : "Legacy credential";
      const label = credential.credential_label || (isQr ? "Attendance QR code" : "Previously registered credential");
      const detail = label + (credential.token_last4 ? " · ending " + credential.token_last4 : "");
      const actions = [];
      if (isQr && ["active", "pending"].includes(status)) actions.push('<button class="mini-button" data-show-credential="' + esc(id) + '">Show QR code</button>');
      if (["active", "pending"].includes(status)) actions.push('<button class="mini-button reject" data-block-credential="' + esc(id) + '">Block ' + (isQr ? "QR" : "credential") + '</button>');
      if (isQr && hasBeenUsed && !["replaced", "expired"].includes(status)) actions.push('<button class="mini-button approve" data-replace-credential="' + esc(id) + '">Replace used QR</button>');
      return '<div class="credential-row"><div><b>' + method + '</b><small>' + esc(detail) + '</small></div><div class="credential-actions"><span class="badge ' + statusClass(status) + '">' + esc(cleanStatus(status)) + "</span>" + actions.join("") + "</div></div>";
    }).join("") : '<div class="empty">No attendance credential has been prepared yet.</div>';
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
      ? { studentId: person.id, credentialType: "qr_token", label: person.displayName + " attendance QR" }
      : { staffId: person.id, credentialType: "qr_token", label: person.displayName + " attendance QR" };
    const data = await qrWrite("issueQr", payload);
    const raw = data.credential?.raw_token;
    if (!raw) throw new Error("The QR value was not returned.");
    await showQrPreview(data.credential?.existing ? "Attendance QR ready" : "Attendance QR created", [{ person, raw }]);
    toast(data.credential?.existing ? "The same permanent QR code was loaded." : "Permanent QR code created and saved for reprinting.", "success");
    await selectCredentialPerson(person.id);
  }

  async function replaceQrCard(credentialId) {
    if (!state.selectedPerson) return toast("Select a real person first.", "error");
    if (!window.confirm("This QR has already been used for attendance. Block it and create a replacement for a lost or damaged QR?")) return;
    const reason = window.prompt("Why is this QR being replaced?", "Lost or damaged QR");
    if (reason === null) return;
    const person = state.selectedPerson;
    const payload = {
      credentialId,
      reason: reason.trim() || "Lost or damaged attendance QR",
      label: person.displayName + " attendance QR",
    };
    const data = await qrWrite("replaceQr", payload);
    const raw = data.credential?.raw_token;
    if (!raw) throw new Error("The replacement QR value was not returned.");
    await showQrPreview("Replacement attendance QR ready", [{ person, raw }]);
    toast("The old QR is blocked and the replacement QR is ready.", "success");
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
    toast("Credential blocked. A used QR can be replaced if the printed QR was lost or damaged.", "success");
    if (state.selectedPerson) await selectCredentialPerson(state.selectedPerson.id);
  }

  function setQrBatchStatus(message, kind) {
    const node = $("#qrBatchStatus");
    if (!node) return;
    node.textContent = message;
    node.className = "small-note" + (kind ? " " + kind : "");
  }

  async function prepareQrBatch(type, classKey = "") {
    if (state.qrBatchBusy) return toast("A QR set is already being prepared.", "warning");
    if (type === "student" && !classKey) return toast("Choose a student class first.", "error");
    state.qrBatchBusy = true;
    const label = type === "student" ? classKey + " student" : "all staff";
    try {
      setQrBatchStatus("Loading " + label + " records…");
      const data = await universalRead("people", { personType: type, search: classKey || "" });
      let people = (data.people || []).map((person) => normalizeCredentialPerson(person, type));
      if (type === "student" && classKey) {
        people = people.filter((person) => String(person.group_name || person.class_name || person.class || person.level || "").toLowerCase() === String(classKey).toLowerCase());
      }
      if (!people.length) return toast("No active " + (type === "student" ? "students" : "staff") + " were found for that set.", "warning");
      const codes = [];
      const skipped = [];
      for (let index = 0; index < people.length; index += 1) {
        const person = people[index];
        setQrBatchStatus("Preparing " + label + " QR codes · " + (index + 1) + " of " + people.length + "…");
        try {
          const payload = person.personType === "student"
            ? { studentId: person.id, credentialType: "qr_token", label: person.displayName + " attendance QR" }
            : { staffId: person.id, credentialType: "qr_token", label: person.displayName + " attendance QR" };
          const result = await qrWrite("issueQr", payload);
          if (result.credential?.raw_token) codes.push({ person, raw: result.credential.raw_token });
          else skipped.push({ person, message: "QR value was not returned" });
        } catch (error) {
          skipped.push({ person, message: error.message || "QR code unavailable" });
        }
      }
      if (!codes.length) {
        setQrBatchStatus("No QR codes are ready. Used credentials with a missing value need a loss/damage replacement.", "error");
        return toast("No printable QR codes were returned for this set.", "error");
      }
      await showQrPreview((type === "student" ? "Class " + classKey : "All staff") + " attendance QR codes ready", codes);
      const suffix = skipped.length ? " " + skipped.length + " QR code(s) need review because their credential was already used." : "";
      setQrBatchStatus(codes.length + " QR code(s) ready for print." + suffix, skipped.length ? "warning" : "success");
      toast(codes.length + " attendance QR code(s) are ready. Download the PNG or print the complete QR sheet.", "success");
    } finally {
      state.qrBatchBusy = false;
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
      const reads = (device.supported_sources || []).includes("qr") ? "QR codes" : "QR source not enabled";
      const connects = ({ wifi: "Wi-Fi", cellular: "mobile data", usb: "wireless reader link", mixed: "more than one way", ethernet: "network cable", offline: "file transfer only" })[device.connection_type] || cleanStatus(device.connection_type);
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
    $("#newDeviceMethod").value = "qr";
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
      deploymentMode: "gate_fixed",
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
    $("#contextDetails").innerHTML = `<div><dt>School session</dt><dd>${esc(state.context?.session || config.operational_session || "—")}</dd></div><div><dt>Term</dt><dd>${esc(state.context?.term || config.operational_term || "—")}</dd></div><div><dt>People and classes</dt><dd>Come from the main school records</dd></div><div><dt>Attendance method</dt><dd>QR-first capture with live or offline synchronization</dd></div><div><dt>Not yet scanned</dt><dd>Calculated from the expected class list and recorded QR scans</dd></div><div><dt>Parent messages</dt><dd>${config.parent_notifications_enabled ? "Turned on" : "Not turned on"}</dd></div>`;
    const permissions = state.context?.permissions || [];
    const accessLabels = {
      "*": "All Attendance areas",
      "dashboard.read": "See today's attendance",
      "class.attendance.read": "See class attendance",
      "class.attendance.write": "Work with class attendance",
      "attendance.register.confirm": "Confirm class attendance",
      "staff.read": "See staff attendance",
      "reports.read": "View reports",
      "credentials.manage": "Generate attendance QR codes",
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

  function renderQrBlock(code, index, { inlineQr = false } = {}) {
    const person = code.person || {};
    const isStudent = person.personType === "student";
    const kind = isStudent ? "STUDENT" : "STAFF";
    const reference = text(person.reference, "No school number");
    const groupOrRole = isStudent
      ? text(person.class_name || person.class || person.level || person.group_name, "No class")
      : text(person.designation || person.role || person.staff_role || person.position || person.staff_category || person.group_name, "Staff");
    const departmentOrGroup = isStudent
      ? text(person.house || person.house_name, "—")
      : text(person.department || person.school_section || person.unit, "School staff");
    const qrImage = inlineQr && code.qrDataUrl
      ? '<img class="qr-preview" data-qr-index="' + index + '" src="' + esc(code.qrDataUrl) + '" alt="Attendance QR code for ' + esc(text(person.displayName, "person")) + '">'
      : '<span class="qr-placeholder" data-qr-index="' + index + '">QR</span>';
    return '<article class="attendance-qr-block ' + (isStudent ? "student-qr-block" : "staff-qr-block") + '">' +
      '<header class="qr-block-heading"><span class="qr-block-mark">QR</span><div class="qr-block-title"><small>WTS ATTENDANCE · ' + kind + '</small><h2>' + esc(text(person.displayName, "WTS person")) + '</h2><p>' + esc(reference) + ' · ' + esc(groupOrRole) + '</p></div></header>' +
      '<div class="qr-block-meta"><div><span>IDENTIFIER</span><b>' + esc(reference) + '</b></div><div><span>' + (isStudent ? "HOUSE" : "DEPARTMENT") + '</span><b>' + esc(departmentOrGroup) + '</b></div></div>' +
      '<div class="qr-block-code"><span>SCAN THIS CODE</span>' + qrImage + '</div>' +
      '<footer class="qr-block-footer"><span>Attendance QR only · place on the back of the school ID card</span><b>' + kind + '</b></footer>' +
    '</article>';
  }

  function renderQrBackCover(code, index) {
    const person = code.person || {};
    const isStudent = person.personType === "student";
    const kind = isStudent ? "STUDENT" : "STAFF";
    const reference = text(person.reference, "No school number");
    const groupOrRole = isStudent
      ? text(person.class_name || person.class || person.level || person.group_name, "No class")
      : text(person.designation || person.role || person.staff_role || person.position || person.staff_category, "Staff");
    const qrImage = code.qrDataUrl
      ? '<img class="qr-back-image" data-qr-back-index="' + index + '" src="' + esc(code.qrDataUrl) + '" alt="Attendance QR code for ' + esc(text(person.displayName, "person")) + '">'
      : '<span class="qr-back-placeholder">QR</span>';
    return '<article class="qr-back-cover ' + (isStudent ? "student-qr-back-cover" : "staff-qr-back-cover") + '">' +
      '<header class="qr-back-brand"><span class="qr-back-crest"><img src="/assets/wts-school-logo.jpg" alt=""></span><span><b>WAY TO SUCCESS STANDARD SCHOOLS</b><small>EJIGBO · ATTENDANCE</small></span></header>' +
      '<div class="qr-back-copy"><small>ATTENDANCE IDENTIFIER</small><h2>SCAN TO RECORD ATTENDANCE</h2></div>' +
      '<div class="qr-back-frame"><span>SCAN THIS CODE</span>' + qrImage + '</div>' +
      '<div class="qr-back-person"><strong>' + esc(text(person.displayName, "WTS person")) + '</strong><span>' + esc(kind + ' · ' + reference + ' · ' + groupOrRole) + '</span></div>' +
      '<p class="qr-back-hint">Keep this QR cover on the back of the school ID card. Report a lost or damaged QR to the school office.</p>' +
      '</article>';
  }

  async function showQrPreview(title, codes) {
    const safeCodes = (codes || []).filter((code) => code && code.person && code.raw);
    if (!safeCodes.length) throw new Error("No printable QR code was returned.");
    const printAreaNode = $("#qrPrintArea");
    if (!printAreaNode) throw new Error("The QR preview is unavailable.");
    if (!window.WTS_VENDOR?.QRCode) throw new Error("The QR renderer is unavailable. Refresh the portal and try again.");

    const preparedCodes = [];
    for (const code of safeCodes) {
      const qrDataUrl = await window.WTS_VENDOR.QRCode.toDataURL(code.raw, {
        width: 1600,
        margin: 6,
        errorCorrectionLevel: "H",
        color: { dark: "#000000", light: "#ffffff" },
      });
      preparedCodes.push({ ...code, qrDataUrl });
    }

    printAreaNode.innerHTML = preparedCodes.map((code, index) => renderQrBlock(code, index, { inlineQr: true })).join("");
    $("#qrTitle").textContent = title;
    $("#qrIntro").textContent = preparedCodes.length === 1
      ? "This attendance QR is ready to download or print. The code stays the same for this person until an authorised replacement is issued."
      : preparedCodes.length + " complete attendance QR codes are ready. Every selected person is included in this print document.";
    $("#downloadQrPng").hidden = preparedCodes.length !== 1;
    $("#printQrDialog").hidden = false;
    $("#printQrBackCovers").hidden = false;
    $("#printQrDialog").textContent = preparedCodes.length === 1 ? "Print / save QR PDF" : "Print / save all QR codes";

    state.lastQrCodes = preparedCodes;
    state.lastQr = preparedCodes.length === 1 ? preparedCodes[0].raw : null;
    state.lastQrPersonId = preparedCodes.length === 1 ? preparedCodes[0].person.id : null;
    const dialog = $("#qrDialog");
    if (dialog.open) dialog.close();
    dialog.showModal();
  }

  function filenamePart(value, fallback) {
    const cleaned = String(value || fallback || "item").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return cleaned || fallback || "item";
  }

  function downloadQrPng() {
    const code = (state.lastQrCodes || [])[0];
    if (!code?.qrDataUrl) return toast("Prepare one person’s QR code first.", "warning");
    const person = code.person || {};
    const link = document.createElement("a");
    link.href = code.qrDataUrl;
    link.download = `WTS-attendance-QR-${filenamePart(person.displayName, "person")}-${filenamePart(person.reference, "number")}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    toast("QR PNG download started.", "success");
  }

  async function printQrBatch() {
    const codes = (state.lastQrCodes || []).filter((code) => code?.person && code?.qrDataUrl);
    if (!codes.length) return toast("Prepare the attendance QR codes first.", "warning");

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      printArea("print-qr");
      return;
    }

    const printBase = esc(window.location.origin + "/");
    const stylesheet = esc(window.location.origin + "/styles.css");
    const markup = codes.map((code, index) => renderQrBlock(code, index, { inlineQr: true })).join("");
    printWindow.document.open();
    printWindow.document.write(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WTS attendance QR codes</title><base href="' + printBase + '"><link rel="stylesheet" href="' + stylesheet + '"></head><body class="print-qr"><main class="qr-print-sheet"><div class="qr-print-area">' + markup + '</div></main></body></html>',
    );
    printWindow.document.close();

    const styleLinks = [...printWindow.document.querySelectorAll('link[rel="stylesheet"]')];
    const styleReady = styleLinks.map((link) => new Promise((resolve) => {
      if (link.sheet) return resolve();
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
    }));
    const imageReady = [...printWindow.document.images].map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    });
    await Promise.all([...styleReady, ...imageReady]);
    printWindow.addEventListener("afterprint", () => window.setTimeout(() => printWindow.close(), 250), { once: true });
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 120);
  }

  async function printQrBackCovers() {
    const codes = (state.lastQrCodes || []).filter((code) => code?.person && code?.qrDataUrl);
    if (!codes.length) return toast("Prepare the attendance QR codes first.", "warning");
    const printWindow = window.open("", "_blank");
    if (!printWindow) return toast("Allow the print preview window to open, then try again.", "warning");
    const stylesheet = esc(window.location.origin + "/styles.css");
    const markup = codes.map((code, index) => renderQrBackCover(code, index)).join("");
    printWindow.document.open();
    printWindow.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WTS QR ID-card back covers</title><link rel="stylesheet" href="' + stylesheet + '"></head><body class="print-qr-back"><main class="qr-back-print-sheet">' + markup + '</main></body></html>');
    printWindow.document.close();
    const styleLinks = [...printWindow.document.querySelectorAll('link[rel="stylesheet"]')];
    const styleReady = styleLinks.map((link) => new Promise((resolve) => {
      if (link.sheet) return resolve();
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
    }));
    const imageReady = [...printWindow.document.images].map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    });
    await Promise.all([...styleReady, ...imageReady]);
    printWindow.addEventListener("afterprint", () => window.setTimeout(() => printWindow.close(), 250), { once: true });
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 120);
  }

  function openPrintWindow(title, markup) {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return toast("Allow pop-ups to print this register.", "warning");
    const stylesheet = esc(window.location.origin + "/styles.css");
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="${stylesheet}"></head><body class="print-document"><main>${markup}</main></body></html>`);
    printWindow.document.close();
    printWindow.addEventListener("afterprint", () => window.setTimeout(() => printWindow.close(), 250), { once: true });
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 180);
  }

  function printRegisterSheet() {
    if (!state.register.classKey || !state.register.rows.length) return toast("Open a class register before printing.", "warning");
    const rows = registerRowsFromDom();
    const label = state.register.slot === "afternoon" ? "Afternoon closing" : "Morning arrival";
    const markup = `<header class="print-heading"><small>WAY TO SUCCESS STANDARD SCHOOLS, EJIGBO</small><h1>Student attendance register</h1><p>${esc(state.register.classKey)} · ${esc(label)} · ${esc(displayDate(state.register.date))}</p><p>${esc(state.context?.session || "Current session")} · ${esc(state.context?.term || "Current term")}</p></header><table class="print-table"><thead><tr><th>S/N</th><th>Pupil name</th><th>Admission number</th><th>Status</th><th>Note</th></tr></thead><tbody>${state.register.rows.map((row, index) => `<tr><td>${index + 1}</td><td>${esc(row.name || "Unnamed pupil")}</td><td>${esc(row.admno || "—")}</td><td>${esc(registerStatusLabel(rows[index]?.status || row.status || "incomplete"))}</td><td>${esc(rows[index]?.note || row.note || "")}</td></tr>`).join("")}</tbody></table><footer class="print-signatures"><span>Class teacher: __________________________</span><span>Signature: __________________________</span><span>Administrator / principal: __________________________</span></footer>`;
    openPrintWindow("WTS student attendance register", markup);
  }

  async function printStaffLogbook() {
    if (!state.staffLogbook.length) {
      try { await loadStaffLogbook(); } catch { return; }
    }
    const date = $("#staffLogbookDate")?.value || todayIso();
    const markup = `<header class="print-heading"><small>WAY TO SUCCESS STANDARD SCHOOLS, EJIGBO</small><h1>Daily staff attendance register</h1><p>${esc(displayDate(date))} · ${esc(state.context?.session || "Current session")} · ${esc(state.context?.term || "Current term")}</p></header><table class="print-table"><thead><tr><th>S/N</th><th>Staff name</th><th>Staff number</th><th>Position</th><th>Morning arrival</th><th>Arrival status</th><th>Afternoon closing</th><th>Closing status</th><th>Method</th></tr></thead><tbody>${state.staffLogbook.map((row, index) => `<tr><td>${index + 1}</td><td>${esc(row.full_name || "Unnamed staff")}</td><td>${esc(row.staff_number || "—")}</td><td>${esc(row.designation || "—")}</td><td>${esc(displayTime(row.arrival))}</td><td>${esc(cleanStatus(row.status || "incomplete"))}</td><td>${esc(displayTime(row.departure))}</td><td>${row.departure ? "Recorded" : "Not yet recorded"}</td><td>${esc(row.method || "QR / manual")}</td></tr>`).join("")}</tbody></table><footer class="print-signatures"><span>Staff signatures: __________________________</span><span>Class teacher / supervisor: __________________________</span><span>Administrator / principal: __________________________</span></footer>`;
    openPrintWindow("WTS daily staff attendance register", markup);
  }

  function printArea(className) {
    document.body.classList.add(className);
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => document.body.classList.remove(className), 300);
    }, 20);
  }

  function wireEvents() {
    $$(".nav").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
    document.addEventListener("click", (event) => {
      const go = event.target.closest("[data-go]");
      if (go) { openView(go.dataset.go); return; }
      const slotButton = event.target.closest("[data-dashboard-slot]");
      if (slotButton) { state.dashboardSlot = slotButton.dataset.dashboardSlot === "afternoon" ? "afternoon" : "morning"; loadOverview().catch((error) => toast(error.message, "error")); return; }
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
    document.addEventListener("change", (event) => {
      const status = event.target.closest("[data-register-status]");
      if (status) {
        const row = state.register.rows[Number(status.dataset.registerStatus)];
        if (row) row.status = status.value;
        const check = status.closest(".register-row")?.querySelector(".row-check");
        if (check) check.textContent = status.value === "incomplete" ? "–" : "✓";
      }
    });
    $("#refresh").onclick = () => loadContext().catch((error) => toast(error.message, "error"));
    $("#login").onclick = signOut;
    $("#refreshScanEvents").onclick = () => loadOverview().then(() => renderEvents("#scanEvents", [...(state.summary?.student?.latest_events || state.summary?.latest_events || []), ...(state.summary?.staff?.latest_events || [])])).catch((error) => toast(error.message, "error"));
    $("#registerDate").value = todayIso();
    $("#registerDate").onchange = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#registerSlot").onchange = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#registerClass").onchange = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#loadRegister").onclick = () => loadRegister().catch((error) => toast(error.message, "error"));
    $("#markAllPresent").onclick = markAllRegisterPresent;
    $("#saveRegister").onclick = () => saveManualRegister().catch((error) => toast(error.message, "error"));
    $("#confirmRegister").onclick = () => confirmManualRegister().catch((error) => toast(error.message, "error"));
    $("#printRegister").onclick = printRegisterSheet;
    $("#staffManualForm").onsubmit = (event) => saveManualStaff(event).catch((error) => toast(error.message, "error"));
    $("#staffManualEventType").onchange = () => {
      const checkOut = $("#staffManualEventType").value === "check_out";
      $("#staffManualSlot").value = checkOut ? "afternoon" : "morning";
    };
    $("#credentialPersonType").onchange = () => { state.selectedPerson = null; $("#credentialDetail").hidden = true; $("#credentialEmpty").hidden = false; loadCredentialPeople().catch((error) => toast(error.message, "error")); };
    $("#searchCredentials").onclick = () => loadCredentialPeople().catch((error) => toast(error.message, "error"));
    $("#credentialSearch").onkeydown = (event) => { if (event.key === "Enter") loadCredentialPeople().catch((error) => toast(error.message, "error")); };
    $("#issueQr").onclick = () => issueQr().catch((error) => toast(error.message, "error"));
    $("#downloadClassQr").onclick = () => prepareQrBatch("student", $("#qrBatchClass").value).catch((error) => toast(error.message, "error"));
    $("#downloadStaffQr").onclick = () => prepareQrBatch("staff").catch((error) => toast(error.message, "error"));
    if ($("#credentialAssignForm")) $("#credentialAssignForm").onsubmit = (event) => assignCredential(event).catch((error) => toast(error.message, "error"));
    $("#showQrAgain").onclick = () => issueQr().catch((error) => toast(error.message, "error"));
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
    $("#loadStaffAnalysis").onclick = () => loadStaffAnalysis().catch((error) => toast(error.message, "error"));
    $("#loadStaffHistory").onclick = () => loadStaffHistory().catch((error) => toast(error.message, "error"));
    $("#refreshStaffLogbook").onclick = () => loadStaffAnalysis().catch((error) => toast(error.message, "error"));
    $("#retryRosterSync").onclick = () => retryRosterSync().catch((error) => toast(error.message, "error"));
    $("#printReport").onclick = () => printArea("print-report");
    $("#printStaffLogbook").onclick = () => printStaffLogbook().catch((error) => toast(error.message, "error"));
    $("#closeQr").onclick = () => $("#qrDialog").close();
    $("#closeQrButton").onclick = () => $("#qrDialog").close();
    $("#downloadQrPng").onclick = downloadQrPng;
    $("#printQrDialog").onclick = () => printQrBatch().catch((error) => toast(error.message, "error"));
    $("#printQrBackCovers").onclick = () => printQrBackCovers().catch((error) => toast(error.message, "error"));
    $("#reportFrom").value = monthStart();
    $("#reportTo").value = todayIso();
    $("#staffManualDate").value = todayIso();
    $("#staffManualTime").value = localClock();
    $("#staffLogbookDate").value = todayIso();
    $("#staffHistoryFrom").value = monthStart();
    $("#staffHistoryTo").value = todayIso();
  }

  async function loadContext() {
    const data = await universalRead("context");
    state.context = data;
    applyNavigation();
    fillClassSelectors();
    connected(true);
    if (permission("credentials.manage") || globalScope()) {
      try {
        const refreshed = await qrWrite("refreshUnusedQr");
        const resetCount = Number(refreshed.reset_count || 0);
        if (resetCount > 0) toast(`${resetCount} unused legacy QR code${resetCount === 1 ? "" : "s"} refreshed and ready to download.`, "success");
      } catch (error) {
        console.warn("Unused QR refresh was not completed", error);
      }
    }
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
