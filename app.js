"use strict";
(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = {
    connected: false,
    dashboard: null,
    dashboardSlot: "morning",
    personType: "student",
    analysisMode: "general",
    people: { student: [], staff: [] },
    qrPeople: [],
    analysisRows: [],
    qrCodes: [],
  };
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dateLabel = (value) => value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const timeLabel = (value) => value ? new Date(value).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" }) : "—";
  const cleanStatus = (value) => String(value || "not recorded").replaceAll("_", " ");

  function toast(message, tone = "") {
    const item = document.createElement("div");
    item.className = `toast ${tone}`;
    item.textContent = message;
    $("#toasts").append(item);
    setTimeout(() => item.remove(), 4500);
  }

  async function rpc(name, action, payload = {}) {
    const response = await fetch("/api/rpc", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name, action, payload }),
    });
    const result = await response.json().catch(() => ({ ok: false, code: "INVALID_RESPONSE" }));
    if (!response.ok || result?.ok === false) {
      const friendly = {
        ADMIN_AUTH_OR_PERMISSION_FAILED: "Your WTS account cannot use this section.",
        ADMIN_PASSWORD_INVALID: "The administrative password is incorrect.",
        PASSWORD_TOO_SHORT: "Choose a longer password.",
        CLASS_REQUIRED: "Choose a class.", PERSON_REQUIRED: "Choose a person.",
        QR_USED_CARD_REQUIRES_REPLACEMENT: "This used QR must be replaced before a new copy can be issued.",
      };
      const error = new Error(friendly[result?.code] || String(result?.code || "Attendance request failed").replaceAll("_", " "));
      error.code = result?.code;
      error.data = result;
      throw error;
    }
    return result;
  }
  const read = (action, payload) => rpc("attendance_strict_read_api", action, payload);
  const write = (action, payload) => rpc("attendance_strict_write_api", action, payload);
  const qrWrite = (action, payload) => rpc("attendance_qr_card_api", action, payload);

  function setConnected(value, message = "") {
    state.connected = value;
    document.body.classList.toggle("locked", !value);
    $("#dot")?.classList.toggle("on", value);
    if ($("#connectionText")) $("#connectionText").textContent = value ? "Live attendance" : "Central access required";
    if ($("#authError")) $("#authError").textContent = message;
  }

  async function signOut() {
    await fetch("/api/sso-logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    window.location.assign(window.WTS_CONFIG.postLogoutUri);
  }

  function openView(name) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
    $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    const titles = { overview: ["Dashboard", "Today’s attendance."], scan: ["Take Attendance", "QR scanner."], reports: ["Analysis", "Attendance records."], settings: ["Setup", "Passwords, phones, location, and offline sync."], credentials: ["QR Codes Generation", "Create and print attendance QRs."] };
    [$("#title").textContent, $("#subtitle").textContent] = titles[name] || titles.overview;
    if (name === "overview") loadDashboard().catch(showError);
    if (name === "settings") loadSetup().catch(showError);
    if (name === "reports") prepareAnalysis().catch(showError);
    if (name === "credentials") loadPeople("student").then(fillQrClasses).catch(showError);
  }
  const showError = (error) => toast(error.message || "Attendance request failed.", "error");

  async function loadDashboard() {
    const data = await read("dashboard", { date: today() });
    state.dashboard = data;
    const slot = data[state.dashboardSlot] || {};
    $("#staffCount").textContent = slot.staff || 0;
    $("#studentCount").textContent = slot.students || 0;
    const morning = state.dashboardSlot === "morning";
    $("#staffCountLabel").textContent = morning ? "arrived this morning" : "closed this afternoon";
    $("#studentCountLabel").textContent = morning ? "arrived this morning" : "closed this afternoon";
    $("#todayHeading").textContent = dateLabel(data.date);
    $("#today").textContent = dateLabel(data.date);
    $("#contextPill").textContent = `${data.session || "Current session"} · ${data.term || "Current term"}`;
  }

  async function loadPeople(type, search = "") {
    const data = await read("people", { personType: type, search });
    state.people[type] = data.people || [];
    return state.people[type];
  }

  function fillSelect(selector, rows, placeholder) {
    const node = $(selector);
    const previous = node.value;
    node.innerHTML = `<option value="">${esc(placeholder)}</option>${rows.map((row) => `<option value="${esc(row.id || row.value)}">${esc(row.display_name || row.label)}</option>`).join("")}`;
    if ([...node.options].some((option) => option.value === previous)) node.value = previous;
  }

  function fillQrClasses() {
    const classes = [...new Set(state.people.student.map((person) => person.group_name).filter(Boolean))].sort();
    fillSelect("#qrBatchClass", classes.map((value) => ({ value, label: value })), "Choose class");
    fillSelect("#analysisClass", classes.map((value) => ({ value, label: value })), "Choose class");
  }

  async function prepareAnalysis() {
    await Promise.all([loadPeople("student"), loadPeople("staff")]);
    fillQrClasses();
    fillSelect("#analysisPerson", state.people[state.personType], `Choose ${state.personType}`);
    updateAnalysisFilters();
  }

  function updateAnalysisFilters() {
    $("#analysisClassWrap").hidden = !(state.personType === "student" && state.analysisMode === "general");
    $("#analysisPersonWrap").hidden = state.analysisMode !== "individual";
    if (state.analysisMode === "individual") fillSelect("#analysisPerson", state.people[state.personType], `Choose ${state.personType}`);
  }

  function sortByArrival(rows) {
    return [...rows].sort((left, right) => {
      if (left.arrival && right.arrival) return new Date(left.arrival) - new Date(right.arrival) || String(left.name).localeCompare(String(right.name));
      if (left.arrival) return -1;
      if (right.arrival) return 1;
      return String(left.name).localeCompare(String(right.name));
    });
  }

  async function runAnalysis() {
    const payload = {
      personType: state.personType, mode: state.analysisMode,
      period: $("#analysisPeriod").value, anchorDate: $("#analysisDate").value,
      classKey: $("#analysisClass").value, personId: $("#analysisPerson").value,
    };
    const data = await read("analysis", payload);
    state.analysisRows = data.period === "day" && data.mode === "general" ? sortByArrival(data.rows || []) : (data.rows || []);
    $("#analysisSummary").innerHTML = `<strong>${esc(data.personType === "student" ? "Student" : "Staff")} ${esc(data.mode)} attendance</strong><span>${esc(dateLabel(data.startDate))}${data.startDate !== data.endDate ? ` – ${esc(dateLabel(data.endDate))}` : ""} · ${state.analysisRows.length} record(s)</span>`;
    renderAnalysis(data);
  }

  function renderAnalysis(data) {
    const day = data.period === "day";
    const isStaffBook = day && data.personType === "staff" && data.mode === "general";
    const isStudentBook = day && data.personType === "student" && data.mode === "general";
    let headers;
    if (isStaffBook) headers = ["S/N", "Staff Name", "Morning Arrival", "Signature", "Afternoon Closing", "Signature"];
    else if (isStudentBook) headers = ["S/N", "Student Name", "Admission No.", "Morning Arrival", "Afternoon Closing", "Status"];
    else headers = ["Date", "Name", "Group", "Arrival", "Closing", "Status"];
    $("#analysisHead").innerHTML = `<tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr>`;
    if (!state.analysisRows.length) {
      $("#analysisRows").innerHTML = `<tr><td colspan="${headers.length}" class="empty">No attendance record for this selection.</td></tr>`;
      return;
    }
    $("#analysisRows").innerHTML = state.analysisRows.map((row, index) => {
      if (isStaffBook) {
        const signature = row.official_signature ? `<img class="official-signature" src="${esc(row.official_signature)}" alt="Official signature">` : "";
        return `<tr><td>${index + 1}</td><td>${esc(row.name)}</td><td>${esc(timeLabel(row.arrival))}</td><td>${signature}</td><td>${esc(timeLabel(row.closing))}</td><td>${signature}</td></tr>`;
      }
      if (isStudentBook) return `<tr><td>${index + 1}</td><td>${esc(row.name)}</td><td>${esc(row.reference || "—")}</td><td>${esc(timeLabel(row.arrival))}</td><td>${esc(timeLabel(row.closing))}</td><td>${esc(cleanStatus(row.session_status || row.status))}</td></tr>`;
      return `<tr><td>${esc(dateLabel(row.attendance_date))}</td><td>${esc(row.name)}</td><td>${esc(row.group_name || "—")}</td><td>${esc(timeLabel(row.arrival))}</td><td>${esc(timeLabel(row.closing))}</td><td>${esc(cleanStatus(row.session_status || row.status))}</td></tr>`;
    }).join("");
  }

  async function loadSetup() {
    const data = await read("setup");
    const settings = data.settings || {};
    $("#locationLabel").value = settings.locationLabel || "";
    $("#locationLatitude").value = settings.latitude ?? "";
    $("#locationLongitude").value = settings.longitude ?? "";
    $("#locationRadius").value = settings.radiusMetres ?? "";
    $("#installationList").innerHTML = (data.installations || []).length ? (data.installations || []).map((item) => `<div class="batch-row"><div><b>${esc(item.deviceName)}</b><small>${esc(cleanStatus(item.status))} · Last seen ${item.lastSeenAt ? esc(new Date(item.lastSeenAt).toLocaleString("en-NG")) : "never"}</small></div>${item.status === "active" ? `<button class="mini-button reject" data-revoke-installation="${esc(item.id)}">Disconnect</button>` : ""}</div>`).join("") : '<div class="empty">No phone has been registered.</div>';
  }

  async function savePassword(event, type) {
    event.preventDefault();
    const admin = type === "admin";
    const first = $(admin ? "#newAdminPassword" : "#newScannerPassword");
    const confirm = $(admin ? "#confirmAdminPassword" : "#confirmScannerPassword");
    if (first.value !== confirm.value) return toast("The passwords do not match.", "error");
    await write(admin ? "setAdminPassword" : "setScannerPassword", { newPassword: first.value, adminPassword: admin ? "" : $("#scannerAdminPassword").value });
    event.target.reset();
    toast(admin ? "Administrative password saved." : "Scanner password saved. Every phone must register again.", "success");
    await loadSetup();
  }

  async function saveLocation(event) {
    event.preventDefault();
    await write("setLocation", { adminPassword: $("#locationAdminPassword").value, locationLabel: $("#locationLabel").value, latitude: $("#locationLatitude").value, longitude: $("#locationLongitude").value, radiusMetres: $("#locationRadius").value });
    $("#locationAdminPassword").value = "";
    toast("School location saved.", "success");
  }

  function parseOfflineFile(text, name) {
    if (name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text);
      return (Array.isArray(parsed) ? parsed : parsed.rows || []).map((row) => ({ credential: row.credential || row.qr || row.qrCode, recordedAt: row.recordedAt || row.timestamp || row.time, eventType: row.eventType || row.event || row.direction, reason: row.reason || "", clientEventId: row.clientEventId || crypto.randomUUID() }));
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return [];
    const delimiter = lines[0].includes("\t") ? "\t" : ",";
    const headers = lines[0].split(delimiter).map((cell) => cell.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
    const find = (...names) => headers.findIndex((header) => names.includes(header));
    const qr = find("qr", "qrcode", "credential", "token");
    const stamp = find("recordedat", "timestamp", "time", "eventtime");
    const event = find("eventtype", "event", "direction");
    const reason = find("reason", "note");
    if (qr < 0 || stamp < 0 || event < 0) throw new Error("The file needs QR, timestamp, and event columns.");
    return lines.slice(1).map((line) => {
      const cells = line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ""));
      const direction = String(cells[event] || "").toLowerCase();
      return { credential: cells[qr], recordedAt: cells[stamp], eventType: ["out", "checkout", "check_out"].includes(direction) ? "check_out" : "check_in", reason: reason >= 0 ? cells[reason] : "", clientEventId: crypto.randomUUID() };
    }).filter((row) => row.credential && row.recordedAt);
  }

  async function importOffline() {
    const file = $("#offlineFile").files?.[0];
    if (!file) return toast("Choose a scanner file.", "error");
    const rows = parseOfflineFile(await file.text(), file.name);
    if (!rows.length) return toast("No QR records were found.", "error");
    $("#offlineStatus").textContent = `Importing ${rows.length} QR record(s)…`;
    const data = await write("importRows", { adminPassword: $("#offlineAdminPassword").value, fileName: file.name, rows });
    const results = data.results || [];
    const accepted = results.filter((item) => item.ok && !item.duplicate).length;
    const duplicates = results.filter((item) => item.duplicate).length;
    const failed = results.length - accepted - duplicates;
    $("#offlineStatus").textContent = `${accepted} saved · ${duplicates} duplicate · ${failed} rejected`;
    $("#offlineAdminPassword").value = "";
    toast("Offline synchronization finished.", failed ? "warning" : "success");
  }

  function normalPerson(person, type) {
    return { id: person.id, personType: type, displayName: person.display_name, reference: person.reference, groupName: person.group_name, photo: person.photo };
  }

  async function searchQrPeople() {
    const type = $("#credentialPersonType").value;
    const people = await loadPeople(type, $("#credentialSearch").value.trim());
    state.qrPeople = people.map((person) => normalPerson(person, type));
    $("#credentialPeople").innerHTML = state.qrPeople.length ? state.qrPeople.map((person) => `<button class="person-item" data-issue-person="${esc(person.id)}"><span><b>${esc(person.displayName)}</b><small>${esc(person.reference || "")} · ${esc(person.groupName || "")}</small></span><span>Generate QR ›</span></button>`).join("") : '<div class="empty">No matching person.</div>';
  }

  async function issueForPerson(person, allowReplacement = false) {
    const payload = person.personType === "student" ? { studentId: person.id, credentialType: "qr_token", label: `${person.displayName} attendance QR` } : { staffId: person.id, credentialType: "qr_token", label: `${person.displayName} attendance QR` };
    let data;
    try {
      data = await qrWrite("issueQr", payload);
    } catch (error) {
      if (!allowReplacement || error.code !== "QR_USED_CARD_REQUIRES_REPLACEMENT" || !error.data?.credential_id) throw error;
      if (!confirm("This used QR can only be replaced if the printed code was lost or damaged. Replace it now?")) throw error;
      const reason = prompt("Reason for replacement", "Lost or damaged QR");
      if (reason === null) throw error;
      data = await qrWrite("replaceQr", { credentialId: error.data.credential_id, reason: reason.trim() || "Lost or damaged QR", label: `${person.displayName} attendance QR` });
    }
    if (!data.credential?.raw_token) throw new Error("The QR could not be displayed. Replace it only if the used card is lost or damaged.");
    return { person, raw: data.credential.raw_token };
  }

  async function issueBatch(type, className = "") {
    const people = (await loadPeople(type)).map((person) => normalPerson(person, type)).filter((person) => !className || person.groupName === className);
    if (!people.length) throw new Error("No active people found for this set.");
    const codes = [];
    for (const person of people) {
      try { codes.push(await issueForPerson(person)); } catch (error) { console.warn("QR unavailable", person.id, error); }
    }
    if (!codes.length) throw new Error("No printable QR values were returned.");
    await showQr(codes);
  }

  function qrCard(code, back = false) {
    const person = code.person;
    return `<article class="${back ? "qr-back-cover" : "attendance-qr-block"}"><header><small>WAY TO SUCCESS STANDARD SCHOOLS · ATTENDANCE QR</small><h2>${esc(person.displayName)}</h2><p>${esc(person.reference || "")} · ${esc(person.groupName || "")}</p></header><img class="${back ? "qr-back-image" : "qr-preview"}" src="${esc(code.qrDataUrl)}" alt="Attendance QR"><footer>Place this complete QR on the back of the school ID card.</footer></article>`;
  }

  async function showQr(codes) {
    if (!window.WTS_VENDOR?.QRCode) throw new Error("QR renderer unavailable.");
    state.qrCodes = [];
    for (const code of codes) state.qrCodes.push({ ...code, qrDataUrl: await window.WTS_VENDOR.QRCode.toDataURL(code.raw, { width: 1600, margin: 6, errorCorrectionLevel: "H" }) });
    $("#qrPrintArea").innerHTML = state.qrCodes.map((code) => qrCard(code)).join("");
    $("#qrTitle").textContent = `${state.qrCodes.length} attendance QR${state.qrCodes.length === 1 ? "" : "s"} ready`;
    $("#downloadQrPng").hidden = state.qrCodes.length !== 1;
    $("#qrDialog").showModal();
  }

  function printQr(back = false) {
    const popup = window.open("", "_blank");
    if (!popup) return toast("Allow the print window to open.", "warning");
    popup.document.write(`<!doctype html><html><head><title>WTS Attendance QR</title><link rel="stylesheet" href="${location.origin}/styles.css"></head><body class="${back ? "print-qr-back" : "print-qr"}"><main class="${back ? "qr-back-print-sheet" : "qr-print-area"}">${state.qrCodes.map((code) => qrCard(code, back)).join("")}</main></body></html>`);
    popup.document.close();
    setTimeout(() => { popup.focus(); popup.print(); }, 500);
  }

  function wire() {
    $("#analysisDate").value = today();
    $$(".nav").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
    $$('[data-dashboard-slot]').forEach((button) => button.addEventListener("click", () => { state.dashboardSlot = button.dataset.dashboardSlot; $$('[data-dashboard-slot]').forEach((item) => item.classList.toggle("active", item === button)); loadDashboard().catch(showError); }));
    $$('[data-person-type]').forEach((button) => button.addEventListener("click", () => { state.personType = button.dataset.personType; $$('[data-person-type]').forEach((item) => item.classList.toggle("active", item === button)); updateAnalysisFilters(); }));
    $$('[data-analysis-mode]').forEach((button) => button.addEventListener("click", () => { state.analysisMode = button.dataset.analysisMode; $$('[data-analysis-mode]').forEach((item) => item.classList.toggle("active", item === button)); updateAnalysisFilters(); }));
    $("#refresh").onclick = () => openView($(".nav.active").dataset.view);
    $("#login").onclick = signOut;
    $("#runAnalysis").onclick = () => runAnalysis().catch(showError);
    $("#printAnalysis").onclick = () => window.print();
    $("#adminPasswordForm").onsubmit = (event) => savePassword(event, "admin").catch(showError);
    $("#scannerPasswordForm").onsubmit = (event) => savePassword(event, "scanner").catch(showError);
    $("#locationForm").onsubmit = (event) => saveLocation(event).catch(showError);
    $("#openScanner").onclick = () => window.open("/scanner", "_blank");
    $("#offlineFile").onchange = () => { const file = $("#offlineFile").files?.[0]; $("#offlineStatus").textContent = file ? `${file.name} selected.` : "No file selected."; };
    $("#importOffline").onclick = () => importOffline().catch(showError);
    $("#searchCredentials").onclick = () => searchQrPeople().catch(showError);
    $("#credentialSearch").onkeydown = (event) => { if (event.key === "Enter") searchQrPeople().catch(showError); };
    $("#downloadClassQr").onclick = () => issueBatch("student", $("#qrBatchClass").value).catch(showError);
    $("#downloadAllStudentQr").onclick = () => issueBatch("student").catch(showError);
    $("#downloadStaffQr").onclick = () => issueBatch("staff").catch(showError);
    $("#closeQr").onclick = $("#closeQrButton").onclick = () => $("#qrDialog").close();
    $("#downloadQrPng").onclick = () => { const link = document.createElement("a"); link.href = state.qrCodes[0].qrDataUrl; link.download = `WTS-attendance-${state.qrCodes[0].person.reference || "QR"}.png`; link.click(); };
    $("#printQrDialog").onclick = () => printQr(false);
    $("#printQrBackCovers").onclick = () => printQr(true);
    document.addEventListener("click", (event) => {
      const personButton = event.target.closest("[data-issue-person]");
      if (personButton) { const person = state.qrPeople.find((item) => item.id === personButton.dataset.issuePerson); if (person) issueForPerson(person, true).then((code) => showQr([code])).catch(showError); }
      const revoke = event.target.closest("[data-revoke-installation]");
      if (revoke) { const password = prompt("Administrative password"); if (password !== null) write("revokeInstallation", { adminPassword: password, installationId: revoke.dataset.revokeInstallation }).then(loadSetup).catch(showError); }
    });
  }

  wire();
  setConnected(false);
  Promise.resolve(window.WTS_AUTH_READY).then(async (authenticated) => {
    if (!authenticated) return;
    try {
      setConnected(true);
      await loadDashboard();
      await loadPeople("student");
      fillQrClasses();
    } catch (error) {
      setConnected(false, error.message);
    }
  });
})();
