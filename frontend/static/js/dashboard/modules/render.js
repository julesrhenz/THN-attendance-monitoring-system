// ─────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────
// Pure(ish) DOM output. Reads from `state` and the DOM, writes to the DOM.
// Does not call fetch and does not mutate state itself (selection toggling
// in toggleEmployee lives in employees.js, but the toolbar repaint here is
// shared by both transfer mode and the modal).

import { state, SECTIONS } from "./state.js";
import { fetchDashboardSummary, fetchAttendanceValidation as fetchAttendanceValidationApi } from "./api.js";

// ── Department classification ──────────────────────────────
// Anything that isn't one of the 4 known departments automatically
// falls under PRODUCTION.
const KNOWN_DEPARTMENTS = ["QUALITY", "ADMINISTRATION", "TECHNICAL"];
const DEPARTMENT_ORDER  = ["PRODUCTION", "ADMINISTRATION", "TECHNICAL", "QUALITY"];

export function classifyDepartment(rawDept) {
    const normalized = (rawDept || "").trim().toUpperCase();
    return KNOWN_DEPARTMENTS.includes(normalized) ? normalized : "PRODUCTION";
}

// ── User access scoping ──────────────────────────────────────
// Narrows down state.data.groups (and per-group employees) to only what
// the logged-in user is allowed to see, based on state.currentUser
// (populated from /api/me on app init — see api.js:getCurrentUser).
//
// Matching rules:
//   - line:   assigned_line "Line 3" must match somewhere inside the full
//             line_name "LINE 3 DS MQ4 PE MAIN" — matched by line NUMBER,
//             not full string, so any line_name containing "LINE 3" as a
//             whole token qualifies.
//   - shift:  exact match against assigned_shift, if the user has one set.
//   - dept:   applied per-employee (not per-group), since a single line
//             group can contain employees from multiple departments —
//             e.g. same "LINE 3 DS MQ4 PE MAIN" group can have both
//             PRODUCTION and QUALITY employees, and a QUALITY-scoped user
//             should still see that group, just filtered to QUALITY employees.
//
// Only applied when access_level === "LINE". Any other access_level
// (e.g. "ADMIN", "ALL") bypasses scoping entirely — adjust the check below
// if more restricted access_level values get added later.
function extractLineKey(lineName) {
    const match = (lineName || "").match(/line\s*(\d+)/i);
    return match ? `LINE ${match[1]}` : (lineName || "").trim().toUpperCase();
}

function normalizeShift(shift) {
    const s = (shift || "").trim().toUpperCase();
    if (["DS", "DAY", "DAY SHIFT", "D"].includes(s)) return "DAY";
    if (["NS", "NIGHT", "NIGHT SHIFT", "N"].includes(s)) return "NIGHT";
    if (s.includes("NIGHT")) return "NIGHT";
    if (s.includes("DAY")) return "DAY";
    return s;
}

export function applyUserAccessScope(groups) {
    const user = state.currentUser;
    if (!user || user.access_level !== "LINE") return groups;

    const userLineKey = user.assigned_line ? extractLineKey(user.assigned_line) : null;
    const userShift    = user.assigned_shift ? normalizeShift(user.assigned_shift) : null;
    const userDept     = user.department ? user.department.trim().toUpperCase() : null;

    return groups
        .filter(g => !userLineKey || extractLineKey(g.line_name) === userLineKey)
        .filter(g => !userShift || normalizeShift(g.shift) === userShift)
        .map(g => {
            if (!userDept) return g;
            const scopedEmployees = (g.employees || []).filter(
                e => classifyDepartment(e.department) === userDept
            );
            return {
                ...g,
                employees: scopedEmployees,
                count: scopedEmployees.length,
            };
        });
}

function statusColor(status) {
    const s = (status || "").toLowerCase();
    if (s === "present")  return "#16a34a";
    if (s === "late")     return "#d97706";
    if (s === "absent")   return "#dc2626";
    if (s === "no_work" || s === "no work") return "#64748b";
    return "#94a3b8";
}

export function populateLineFilter() {
    const select = document.getElementById("lineFilter");
    const currentValue = select.value;
    let optionsHtml = '<option value="all">All Sheets</option>';

    // Scope the dropdown too — a LINE-restricted user shouldn't see other
    // lines as filter options even though they can't reach them via render().
    const scopedGroups = applyUserAccessScope(state.data.groups || []);
    const sortedGroups = [...scopedGroups].sort((a, b) =>
        a.line_name.localeCompare(b.line_name) || a.shift.localeCompare(b.shift)
    );

    sortedGroups.forEach(group => {
        // Use sheet-level key: line_name + shift
        const sheetKey = `${group.line_name}||${group.shift}`;
        optionsHtml += `<option value="${sheetKey}">${group.line_name} (${group.shift})</option>`;
    });

    select.innerHTML = optionsHtml;
    if ([...select.options].some(o => o.value === currentValue)) select.value = currentValue;
}

export async function loadAttendanceValidation() {
    try {
        const data = await fetchAttendanceValidationApi();

        const card = document.getElementById("gtValidationCard");
        const total = document.getElementById("gtValidationTotal");
        const status = document.getElementById("gtValidationStatus");

        // These elements may not exist on every page this module is loaded
        // on — bail out quietly instead of throwing on a null textContent set.
        if (!card || !total || !status) return;

        total.textContent = `${data.total_present_late_absent} / ${data.expected_benchmark}`;

        if (data.validation_passed) {
            card.classList.remove("validation-fail");
            card.classList.add("validation-pass");
            status.textContent = "✓ Matches benchmark";
        } else {
            card.classList.remove("validation-pass");
            card.classList.add("validation-fail");
            const sign = data.discrepancy > 0 ? "+" : "";
            status.textContent = `⚠ Off by ${sign}${data.discrepancy}`;
        }

    } catch (err) {
        console.error("loadAttendanceValidation error:", err);
    }
}

export function render() {
    const grid = document.getElementById("grid");
    let gridHtml = "";

    const selectedLine = document.getElementById("lineFilter").value;
    const selectedShift = document.getElementById("shiftFilter").value;

    // Apply user access scoping FIRST, before the existing toolbar filters —
    // everything downstream (line filter, shift filter, department view)
    // now operates only on what this user is allowed to see.
    let groups = applyUserAccessScope(state.data.groups || []);

    if (selectedShift !== "all") {
    groups = groups.filter(g => (g.shift || "").trim() === selectedShift);
}
    if (selectedLine !== "all") {
        const [filterLine, filterShiftVal] = selectedLine.split("||");
        groups = groups.filter(g => g.line_name === filterLine && g.shift === filterShiftVal);
    }

    // ── DEPARTMENT VIEW ──────────────────────────────────────
    // Branches away from the normal line-card grid entirely, reusing the
    // same shift/line-filtered `groups` so it stays consistent with
    // whatever the toolbar filters currently say.
    if (state.departmentViewActive) {
        renderDepartmentGrid(groups);
        renderTransferToolbar();
        return;
    }

    // Restore normal .grid layout for line view — department view forces
    // block display for its full-width sections, so this undoes that
    // when switching back to "Show All Lines".
    grid.style.display = "";

    groups.forEach(g => {
            const isFixed = !!g.fixed;
            const dragAttrs = isFixed ? "" : `
                    ondragover="allowDrop(event)"
                    ondragenter="dragEnter(event)"
                    ondragleave="dragLeave(event)"
                    ondrop="dropEmployee(event, '${g.id}')"`;

            gridHtml += `
                <div class="card${isFixed ? ' card-fixed' : ''}"
                    id="group-card-${g.id}"
                    data-group-id="${g.id}"${dragAttrs}>

                <div class="title">
                    <span>${g.line_name}${isFixed ? ' 🔒' : ''} <small style="color:var(--text-muted);font-size:11px;">(${g.shift})</small></span>
                    <span class="badge">${g.count} Employees</span>
                </div>

                <div class="action-bar">
                    <button class="btn-save" onclick="viewLineSummary('${g.id}')">Summary</button>
                </div>

                <div class="employee-container">
                    ${renderEmployees(g)}
                </div>
            </div>`;
        });

    // ── UNASSIGNED CARD ──────────────────────────────────────
    // Skipped entirely for LINE-scoped users — "Unassigned" spans every
    // line/department, so it can't be meaningfully filtered down to a
    // single line+shift+department slice without misleadingly showing
    // people who were never on this user's line to begin with.
    const isLineScoped = !!(state.currentUser && state.currentUser.access_level === "LINE");
    if (!isLineScoped) {
        const unassignedList = state.data.unassigned || [];
        gridHtml += `
        <div class="card" id="unassigned-card"
            ondragover="allowDrop(event)"
            ondragenter="dragEnter(event)"
            ondragleave="dragLeave(event)"
            ondrop="dropToUnassigned(event)">

            <div class="title">
                <span>📋 Unassigned</span>
                <span class="badge" style="background:var(--surface);border:1px solid var(--border);color:var(--text-muted);">${unassignedList.length} Employees</span>
            </div>

            <div class="employee-container">
                ${unassignedList.length === 0
                    ? `<div class="dept-empty">No unassigned employees</div>`
                    : unassignedList.map(e => `
                        <div class="emp" id="emp-row-${e.id}" data-emp-id="${e.id}"
                            draggable="${state.editMode}"
                            ondragstart="dragEmployee(event, '${e.id}')">
                            <span class="emp-name" onclick="showEmployeeHistory('${e.id}','${e.name}')">
                                👤 ${e.name}
                            </span>
                        </div>
                    `).join("")
                }
            </div>
        </div>`;
    }
    grid.innerHTML = gridHtml;
    renderTransferToolbar();
}

// ── DEPARTMENT GRID ──────────────────────────────────────────
// Buckets employees into the 4 department cards, splitting each
// department into per-line groups (with their own Summary button).
// Each line group is a collapsible row: closed by default (just the line
// name, shift, and count show), expand on click to reveal the employee
// list. This replaces the old per-department pagination entirely — since
// closed groups take almost no vertical space, there's no need to page.
//
// Layout is a flat stack of cards (accent color lives only in the left
// border + header text/icon), not a nested "tree" — easier to scan at a
// glance and far less markup per row.
//
// Note: `groups` arriving here is already access-scoped (render() applies
// applyUserAccessScope before calling this), so no extra filtering needed —
// a LINE+department-scoped user will naturally see near-empty buckets for
// the 3 departments that aren't theirs, and a fully-scoped bucket for
// their own.

const DEPARTMENT_STYLES = {
    QUALITY:        { color: "#dc2626", icon: "🔍" },
    ADMINISTRATION: { color: "#1e3a8a", icon: "🗂️" },
    TECHNICAL:      { color: "#16a34a", icon: "⚙️" },
    PRODUCTION:     { color: "#b45309", icon: "🏭" },
};

function renderDepartmentGrid(groups) {
    const grid = document.getElementById("grid");

    // dept -> lineKey -> { line_name, shift, group_id, employees[] }
    const buckets = { QUALITY: {}, ADMINISTRATION: {}, TECHNICAL: {}, PRODUCTION: {} };

    groups.forEach(g => {
        (g.employees || []).forEach(e => {
            const dept = classifyDepartment(e.department);
            const lineKey = g.id;
            if (!buckets[dept][lineKey]) {
                buckets[dept][lineKey] = {
                    line_name: g.line_name,
                    shift: g.shift,
                    group_id: g.id,
                    employees: []
                };
            }
            buckets[dept][lineKey].employees.push(e);
        });
    });

    // Skip the "Unassigned" bucket for LINE-scoped users, same reasoning
    // as the Unassigned card in render() above.
    const isLineScoped = !!(state.currentUser && state.currentUser.access_level === "LINE");
    if (!isLineScoped) {
        (state.data.unassigned || []).forEach(e => {
            const dept = classifyDepartment(e.department);
            const lineKey = "unassigned";
            if (!buckets[dept][lineKey]) {
                buckets[dept][lineKey] = {
                    line_name: "Unassigned",
                    shift: "",
                    group_id: null,
                    employees: []
                };
            }
            buckets[dept][lineKey].employees.push(e);
        });
    }

    // Tracks which line groups are expanded, keyed by "dept::lineKey", so
    // state survives filter changes and re-renders (e.g. a status update
    // coming in over the socket shouldn't collapse what the person had open).
    if (!state.deptExpanded) state.deptExpanded = {};

    // Override the shared .grid layout for department view — each
    // department is a full-width stacked card, not a grid cell.
    grid.style.display = "block";

    grid.innerHTML = DEPARTMENT_ORDER.map(dept => {
        const style = DEPARTMENT_STYLES[dept];
        const lineBuckets = Object.values(buckets[dept]);
        const totalCount = lineBuckets.reduce((sum, l) => sum + l.employees.length, 0);
        const isCollapsed = !!(state.deptCardCollapsed && state.deptCardCollapsed[dept]);

        const lineGroups = lineBuckets.length === 0
            ? `<div class="dept-empty">No employees in this department</div>`
            : lineBuckets.map(line => {
                const lineKey = line.group_id ?? "unassigned";
                const expandKey = `${dept}::${lineKey}`;
                const isExpanded = !!state.deptExpanded[expandKey];

                const rows = line.employees.map(e => `
                    <div class="emp" id="dept-emp-row-${e.id}" data-emp-id="${e.id}">
                        <span class="emp-name" onclick="showEmployeeHistory('${e.id}','${e.name}')">
                            👤 ${e.name}
                        </span>
                        <span class="badge" style="background:${statusColor(e.status)};color:white;">
                            ${e.status || "—"}
                        </span>
                    </div>
                `).join("");

                return `
                    <div class="dept-line-group${isExpanded ? ' expanded' : ''}" id="dept-line-group-${expandKey}">
                        <div class="dept-line-header" onclick="toggleDeptLine('${expandKey}')">
                            <span><span class="dept-chevron">▶</span>${line.line_name}${line.shift ? ` <span style="color:var(--text-faint);font-weight:500;font-size:11px;">(${line.shift})</span>` : ""}</span>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span class="badge">${line.employees.length}</span>
                                ${line.group_id ? `
                                    <button class="btn-save" style="padding:3px 10px;font-size:11px;"
                                        onclick="event.stopPropagation(); viewLineSummary('${line.group_id}', '${dept}')">Summary</button>
                                ` : ""}
                            </div>
                        </div>
                        <div class="dept-line-body">
                            ${rows}
                        </div>
                    </div>`;
            }).join("");

        return `
            <div class="dept-card${isCollapsed ? ' collapsed' : ''}" id="dept-card-${dept}" style="--dept-color:${style.color};">
                <div class="dept-card-header" onclick="toggleDeptCard('${dept}')">
                    <span class="dept-card-title">
                        <span class="dept-card-chevron">▼</span>
                        <span>${style.icon}</span> ${dept}
                    </span>
                    <span class="badge" style="background:${style.color};color:white;">
                        ${totalCount} Employees
                    </span>
                </div>

                <div class="dept-card-body">
                    ${lineGroups}
                </div>
            </div>`;
    }).join("");
}

// Expand/collapse an entire department card. Defaults to expanded (only
// tracked once the person actually collapses one), toggled via a DOM
// class swap rather than a full re-render for the same reason as
// toggleDeptLine below — snappy, and doesn't disturb other open sections.
export function toggleDeptCard(dept) {
    if (!state.deptCardCollapsed) state.deptCardCollapsed = {};
    state.deptCardCollapsed[dept] = !state.deptCardCollapsed[dept];

    const el = document.getElementById(`dept-card-${dept}`);
    if (el) el.classList.toggle("collapsed", state.deptCardCollapsed[dept]);
}

// Expand/collapse a single line group within a department card. Toggles
// the DOM directly (cheap class swap) rather than a full re-render, so
// opening one line doesn't reset scroll position or repaint every card.
export function toggleDeptLine(expandKey) {
    if (!state.deptExpanded) state.deptExpanded = {};
    state.deptExpanded[expandKey] = !state.deptExpanded[expandKey];

    const el = document.getElementById(`dept-line-group-${expandKey}`);
    if (el) el.classList.toggle("expanded", state.deptExpanded[expandKey]);
}

export function renderEmployees(group) {
    const perPage = 5;
    if (!state.currentPages[group.id]) state.currentPages[group.id] = 1;

    const employeesArray = [...(group.employees || [])];
    employeesArray.sort((a, b) => {
        const getPriority = (emp) => {
            const s = (emp.section || "").toUpperCase();
            if (s === "SR.LEADER") return 1;
            if (s === "LINE LEADER") return 2;
            if (s === "ASST LEADER") return 3;
            return 4;
        };
        return getPriority(a) - getPriority(b);
    });

    if (employeesArray.length === 0) {
        return `<div class="dept-empty">No employees assigned</div>`;
    }

    const totalPages = Math.max(1, Math.ceil(employeesArray.length / perPage));
    if (state.currentPages[group.id] > totalPages) state.currentPages[group.id] = totalPages;

    const page = state.currentPages[group.id];
    const start = (page - 1) * perPage;
    const pageEmployees = employeesArray.slice(start, start + perPage);

    const sectionMap = {};
    pageEmployees.forEach(e => {
        const sec = e.section || "UNASSIGNED SECTION";
        if (!sectionMap[sec]) sectionMap[sec] = [];
        sectionMap[sec].push(e);
    });

    const orderedKeys = [...SECTIONS, "UNASSIGNED SECTION"].filter(s => sectionMap[s]);
    Object.keys(sectionMap).forEach(k => { if (!orderedKeys.includes(k)) orderedKeys.push(k); });

    let html = `<div class="section-list">`;
    orderedKeys.forEach(sectionName => {
        const emps = sectionMap[sectionName];
        html += `
            <div class="section-block">
                <div class="section-header">
                    <span class="section-label">📌 ${sectionName}</span>
                    <span class="section-count">${emps.length}</span>
                </div>
                <div class="section-employees">
        `;

        const isFixed = !!group.fixed;

        emps.forEach(e => {
            const checked = state.selectedEmployees.includes(e.id);
            const canTransfer = state.transferMode && !isFixed;
            const canEdit     = state.editMode && !isFixed;

            html += `
                <div class="emp ${checked ? 'emp-selected' : ''}"
                    id="emp-row-${e.id}"
                    data-emp-id="${e.id}"
                    draggable="${canEdit}"
                    ${isFixed ? "" : `ondragstart="dragEmployee(event, '${e.id}')"`}>

                    ${canTransfer ? `
                        <input type="checkbox"
                            ${checked ? "checked" : ""}
                            onchange="toggleEmployee('${e.id}')"
                            style="margin-right:8px;cursor:pointer;width:14px;height:14px;">
                    ` : ""}

                    <span class="emp-name"
                        onclick="${canTransfer
                            ? `toggleEmployee('${e.id}')`
                            : `showEmployeeHistory('${e.id}','${e.name}')`
                        }">
                        👤 ${e.name}${e.gender ? ` <span class="emp-gender">(${e.gender})</span>` : ""}
                    </span>

                    ${canEdit ? `<span class="remove" onclick="removeEmp('${e.id}', '${group.id}')">×</span>` : ""}
                </div>
            `;
        });

        html += `</div></div>`;
    });
    html += `</div>`;

    html += `
        <div class="pagination-row">
            <button onclick="changePage('${group.id}', -1)" ${page === 1 ? "disabled" : ""}>◀ Prev</button>
            <span>${page} / ${totalPages} (${employeesArray.length} total)</span>
            <button onclick="changePage('${group.id}', 1)" ${page === totalPages ? "disabled" : ""}>Next ▶</button>
        </div>
    `;
    return html;
}

export function renderTransferToolbar() {
    let bar = document.getElementById("transferToolbar");
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "transferToolbar";
        bar.className = "transfer-toolbar";
        document.body.appendChild(bar);
    }

    if (!state.transferMode) {
        bar.style.display = "none";
        return;
    }

    bar.style.display = "flex";

    bar.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
            <span class="count-pill">${state.selectedEmployees.length}</span>
            <span style="color:rgba(255,255,255,.8);">employee(s) selected</span>
        </div>
        <div style="display:flex;gap:10px;">
            <button class="transfer-toolbar-btn-primary" onclick="openTransferModal()"
                ${state.selectedEmployees.length === 0 ? "disabled" : ""}>
                🔄 Transfer
            </button>
            <button class="transfer-toolbar-btn-cancel" onclick="toggleTransferMode()">
                Cancel
            </button>
        </div>
    `;
}
// ─────────────────────────────────────────
// SHEET-LEVEL SUMMARY (dashboard panel)
// ─────────────────────────────────────────
// Mirrors viewLineSummary's tally logic exactly: same status
// normalization, same present/late/absent bucketing (with absent as the
// fallback for "absent", "pending", and unknown/missing status), and the
// same percentage rounding (round to 1 decimal via *1000/1000... /10).

export function computeSheetSummary(group) {
    const employees = group.employees || [];
    const total = employees.length;

    const present = [];
    const late = [];
    const absent = [];
    const noWork = [];

    employees.forEach(e => {
        const status = (e.status || "").trim().toLowerCase();

        const payload = {
            id: e.id,
            name: e.name,
            process: e.section || "Unassigned"
        };

        if (status === "present") {
            present.push(payload);
        }
        else if (status === "late") {
            late.push(payload);
        }
        else if (status === "absent") {
            absent.push(payload);
        }
        else if (status === "no_work" || status === "no work") {
            noWork.push(payload);
        }

        // pending and on leave are intentionally excluded
    });

    const presentPct = total ? Math.round((present.length / total) * 1000) / 10 : 0;
    const latePct     = total ? Math.round((late.length    / total) * 1000) / 10 : 0;
    const absentPct   = total ? Math.round((absent.length  / total) * 1000) / 10 : 0;

    return {
        line_name: group.line_name,
        shift: group.shift,
        sheet_key: `${group.line_name}||${group.shift}`,
        metrics: {
            total_employees:    total,
            present_count:      present.length,
            late_count:         late.length,
            absent_count:       absent.length,
            no_work_count:      noWork.length,
            present_percentage: presentPct,
            late_percentage:    latePct,
            absent_percentage:  absentPct,
        },
    };
}

export function renderSheetSummaries(containerId = "sheetSummaryGrid") {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Scope the dashboard summary cards too, so a LINE-restricted user
    // doesn't see summary tiles for lines/departments they can't access.
    const groups = applyUserAccessScope(state.data.groups || []);

    if (groups.length === 0) {
        container.innerHTML = `<div class="dept-empty">No sheets loaded</div>`;
        return;
    }

    container.innerHTML = groups.map(g => {
        const s = computeSheetSummary(g);
        return `
            <div class="sheet-summary-card" data-sheet-key="${s.sheet_key}" onclick="viewLineSummary('${g.id}')">
                <div class="sheet-summary-header">
                    <span class="sheet-summary-name">${s.line_name}</span>
                    <span class="sheet-summary-shift">${s.shift}</span>
                </div>

                <div class="sheet-summary-total">${s.metrics.total_employees} employees</div>

                <div class="sheet-summary-breakdown">
                    <div class="sb-stat sb-present">
                        <span class="sb-label">Present</span>
                        <span class="sb-count">${s.metrics.present_count}</span>
                        <span class="sb-pct">${s.metrics.present_percentage}%</span>
                    </div>
                    <div class="sb-stat sb-late">
                        <span class="sb-label">Late</span>
                        <span class="sb-count">${s.metrics.late_count}</span>
                        <span class="sb-pct">${s.metrics.late_percentage}%</span>
                    </div>
                    <div class="sb-stat sb-absent">
                        <span class="sb-label">Absent</span>
                        <span class="sb-count">${s.metrics.absent_count}</span>
                        <span class="sb-pct">${s.metrics.absent_percentage}%</span>
                    </div>
                    <div class="sb-stat sb-no-work">
                        <span class="sb-label">No Work</span>
                        <span class="sb-count">${s.metrics.no_work_count}</span>
                    </div>
                </div>
            </div>
        `;
    }).join("");
}
export function mergeGroupsState(payload) {
    // Backend now returns the full global group list on every import
    // (see fetch_current_state in groupings.py), keyed by line_name+shift.
    // This merges it into local state in place — new sheet name gets
    // added, existing sheet name gets overwritten, nothing already in
    // state.data.groups is ever dropped.
    const incomingGroups = payload.lines || payload.groups || [];
    const incomingUnassigned = payload.unassigned || [];

    const existingByKey = new Map(
        (state.data.groups || []).map(g => [`${g.line_name}||${g.shift}`, g])
    );

    incomingGroups.forEach(incoming => {
        const key = incoming.id || `${incoming.line_name}||${incoming.shift}`;
        if (!incoming.id) incoming.id = key;
        existingByKey.set(key, incoming); // add if new, overwrite if same key
    });

    state.data.groups = [...existingByKey.values()];
    state.data.unassigned = incomingUnassigned;
}
// ── Single-group / single-employee scope check ──────────────────────
// Defense-in-depth guard for modal.js (viewLineSummary, openModal,
// assignSelected) — even kung ma-trigger ang mga functions na ito
// nang direkta (console, stale reference, atbp.) gamit ang group/employee
// na labas sa scope ng user, dapat ma-reject, hindi tahimik na tumagos.
// Same rules lang ng applyUserAccessScope, pero para sa iisang item.
export function isGroupInUserScope(group) {
    const user = state.currentUser;
    if (!user || user.access_level !== "LINE") return true;
    if (!group) return false;

    const userLineKey = user.assigned_line ? extractLineKey(user.assigned_line) : null;
    const userShift    = user.assigned_shift ? normalizeShift(user.assigned_shift) : null;

    if (userLineKey && extractLineKey(group.line_name) !== userLineKey) return false;
    if (userShift && normalizeShift(group.shift) !== userShift) return false;
    return true;
}

// Employee-level check — para sa unassigned pool, na walang kinalaman sa
// anumang line group, kaya department na lang ang dimensyong na-che-check.
export function isEmployeeInUserScope(employee) {
    const user = state.currentUser;
    if (!user || user.access_level !== "LINE") return true;
    if (!employee) return false;

    const userDept = user.department ? user.department.trim().toUpperCase() : null;
    if (userDept && classifyDepartment(employee.department) !== userDept) return false;
    return true;
}
// Inline onclick="toggleDeptLine(...)" / "toggleDeptCard(...)" handlers in
// renderDepartmentGrid's markup need these on window explicitly — ES
// module exports aren't visible to inline HTML event handlers on their own.
window.toggleDeptLine = toggleDeptLine;
window.toggleDeptCard = toggleDeptCard;