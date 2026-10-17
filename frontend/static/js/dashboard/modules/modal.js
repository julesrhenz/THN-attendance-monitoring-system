// ─────────────────────────────────────────
// MODAL (assign from unassigned pool)
// ─────────────────────────────────────────

import { state, SECTIONS } from "./state.js";
import { manualMoveEmployee, updateEmployeeRemark, fetchDashboardData } from "./api.js";
import { render, classifyDepartment, mergeGroupsState, isGroupInUserScope, isEmployeeInUserScope } from "./render.js";
import { askSection } from "./employees.js";

// ── Access helper ─────────────────────────────────────────────
// LINE-level users (Line Leaders, etc.) can VIEW the summary modal but
// cannot make any changes from it (remarks, assignments, etc.) — view
// only. Any write action anywhere in this file should check this first.
function isViewOnlyUser() {
    return state.currentUser?.access_level === "LINE";
}

// Remarks are intentionally different from the rest of the line-summary
// controls: a Line Leader is view-only for grouping administration, but is
// the sole role allowed to record a member's remark.
function canEditRemarks() {
    return state.currentUser?.access_level === "LINE";
}

// ── No Work lookup (client-side) ─────────────────────────────────────────
// classifyStatus() below originally expected employee.status to already
// say "no_work" from the backend (see comment there), but that field
// never actually gets set correctly, so employees with a real No Work
// entry for today kept falling through to the time_in-based fallback and
// showing up as Absent. This fetches the no-work feed directly instead
// and checks it first, ahead of everything else — same fix already
// applied to attendance_dashboard.html.
let noWorkKeySet = new Set();

function normalizeEmpKey(id) {
    const s = (id || "").toString().trim().toUpperCase();
    const idx = s.indexOf("-");
    return idx === -1 ? s : s.slice(idx + 1);
}

function todayLocalIso() {
    // Local date, NOT toISOString() — toISOString() is UTC and returns
    // "yesterday" before 8AM in PH time (UTC+8).
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function refreshNoWorkSet() {
    try {
        const res = await fetch(`/api/no-work?date=${encodeURIComponent(todayLocalIso())}`);
        const data = await res.json();
        const records = Array.isArray(data) ? data : (data.data || data.records || []);
        const set = new Set();
        records.forEach(r => {
            if (!r) return;
            const key = r.emp_id || r.emp_no;
            if (key) set.add(normalizeEmpKey(key));
        });
        noWorkKeySet = set;
    } catch (err) {
        console.error("[No Work] fetch failed:", err);
    }
}

// Load once immediately, then keep refreshed every 5 minutes so it
// doesn't go stale across a long-open dashboard session.
refreshNoWorkSet();
setInterval(refreshNoWorkSet, 5 * 60 * 1000);

function normalizeEmployee(e) {
    return {
        id: e.emp_id || e.id || "",
        name: e.full_name || e.name || "Unknown",
        shift: (e.shift_name || e.shift || "").toLowerCase(),
        timeInRaw: e.time_in || null,
        section: e.section || "Unassigned"
    };
}
export function openModal(groupId) {
    if (isViewOnlyUser()) {
        Swal.fire("Access denied", "View-only access. You cannot assign employees.", "error");
        return;
    }

    const group = (state.data.groups || []).find(g => String(g.id) === String(groupId));
    if (!isGroupInUserScope(group)) {
        Swal.fire("Access denied", "You don't have access to this line.", "error");
        return;
    }

    state.selectedGroup = groupId;
    document.getElementById("modal").style.display = "block";
    state.selectedEmployees = [];
    // Scoped by department pa rin — para hindi makita ng user yung
    // unassigned employees ng ibang department kahit tama yung line.
    state.filteredEmployees = (state.data.unassigned || []).filter(isEmployeeInUserScope);
    renderEmployeeList(state.filteredEmployees);
}

export function closeModal() {
    document.getElementById("modal").style.display = "none";
}

export function renderEmployeeList(list) {
    const container = document.getElementById("employeeList");
    container.innerHTML = list.map(e => `
        <label style="display:flex;gap:10px;align-items:center;margin-bottom:6px;cursor:pointer;">
            <input type="checkbox" value="${e.id}"
                   onchange="toggleModalEmployee('${e.id}', this.checked)">
            ${e.name}
        </label>
    `).join("");
}

export function filterEmployees(value) {
    state.filteredEmployees = (state.data.unassigned || [])
        .filter(isEmployeeInUserScope)
        .filter(e => e.name.toLowerCase().includes(value.toLowerCase()));
    renderEmployeeList(state.filteredEmployees);
}

// Separate toggle for the assign modal (uses selectedEmployees differently
// than the transfer-mode toggleEmployee in employees.js — no visual row
// highlighting here, just a checkbox list).
export function toggleModalEmployee(empId, checked) {
    if (checked) {
        if (!state.selectedEmployees.includes(empId)) state.selectedEmployees.push(empId);
    } else {
        state.selectedEmployees = state.selectedEmployees.filter(id => id !== empId);
    }
}

export async function assignSelected() {
    if (isViewOnlyUser()) {
        Swal.fire("Access denied", "View-only access. You cannot assign employees.", "error");
        return;
    }

    if (state.selectedEmployees.length === 0) {
        Swal.fire("No employees selected", "Please check at least one employee.", "info");
        return;
    }

    // Guard BEFORE hitting the API — kung nag-race yung modal state
    // (e.g. openModal na-bypass, o naiwang bukas habang nagpalit ng
    // scope ang user session), hindi na tuloy ang assignment.
    const targetGroup = state.data.groups.find(g => g.id === state.selectedGroup);
    if (!isGroupInUserScope(targetGroup)) {
        Swal.fire("Access denied", "You don't have access to this line.", "error");
        return;
    }

    const hasOutOfScopeEmployee = state.selectedEmployees.some(empId => {
        const emp = (state.data.unassigned || []).find(e => e.id === empId);
        return !isEmployeeInUserScope(emp);
    });
    if (hasOutOfScopeEmployee) {
        Swal.fire("Access denied", "One or more selected employees are outside your access.", "error");
        return;
    }

    const section = await askSection();
    if (!section) return;

    try {
        state.localUpdate = true;
        const result = await manualMoveEmployee({
            group_id: state.selectedGroup,
            employee_ids: state.selectedEmployees,
            section: section
        });
        if (!result.success) {
            Swal.fire("Error", "Unable to assign employees", "error");
            return;
        }

        if (!targetGroup) return;

        state.selectedEmployees.forEach(empId => {
            const index = (state.data.unassigned || []).findIndex(e => e.id === empId);
            if (index !== -1) {
                const employee = state.data.unassigned.splice(index, 1)[0];
                targetGroup.employees.push({ ...employee, section });
            }
        });

        targetGroup.count = targetGroup.employees.length;
        state.selectedEmployees = [];
        render();
        closeModal();
        Swal.fire({ icon: "success", title: "Employees Assigned", timer: 1000, showConfirmButton: false });
    } catch (err) {
        console.error(err);
        Swal.fire("Error", "Something went wrong", "error");
    }
}
// ── Line Summary Modal ──────────────────────────────────────
// Computed entirely client-side from state.data.groups[].employees,
// which already carry a computed `.status` (see groups.js saveGroup()).

const SUMMARY_MODAL_PAGE_SIZE = 10;
const SUMMARY_STATUS_PRIORITY = { error: -1, absent: 0, late: 1, present: 2 };
const SUMMARY_DEFICIENCY_THRESHOLD_PCT = 20; // absence rate >= 20% flags a process

/**
 * Ranks a process/section name by its position in the app's canonical
 * SECTIONS order (Leader first, then the rest, in that defined sequence).
 * Anything not found in SECTIONS (e.g. "Unassigned") sorts after all
 * known sections.
 */
function processRank(process) {
    const idx = SECTIONS.indexOf(process);
    return idx === -1 ? SECTIONS.length : idx;
}

/**
 * Classifies a raw employee status string into one of the three canonical
 * buckets used throughout the dashboard. Anything that isn't explicitly
 * "present" or "late" (including "absent", "pending", or missing/unknown
 * status) is treated as Absent — mirrors the bucketing already used in
 * viewLineSummary/computeSheetSummary elsewhere in this app.
 */
function parseAttendanceTime(value) {
    if (!value) return null;

    let str = String(value).trim().toUpperCase();

    if (!str) return null;

    const hasAMPM = str.includes("AM") || str.includes("PM");

    if (hasAMPM) {
        const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/);

        if (!match) return null;

        let hour = parseInt(match[1], 10);
        const minute = parseInt(match[2], 10);

        if (match[4] === "PM" && hour !== 12) hour += 12;
        if (match[4] === "AM" && hour === 12) hour = 0;

        return hour * 60 + minute;
    }

    const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) return null;

    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function classifyStatus(employee) {
    try {
        // Client-side No Work override — checked FIRST, ahead of
        // backendStatus and everything else below. The backend's own
        // "no_work" status field on employee.status isn't reliably set,
        // so this consults the /api/no-work feed fetched directly by
        // this module (see refreshNoWorkSet() above) instead of trusting
        // employee.status for this particular case.
        if (noWorkKeySet.has(normalizeEmpKey(employee.id))) {
            return "no work";
        }

        const backendStatus = (employee.status || "").trim().toLowerCase();

        // "No Work" is an authoritative, date-specific HR declaration
        // (frontend.no_work_schedule via /api/data) -- it takes priority
        // over any stale/lingering remark text, unlike the on-leave check
        // below which only looks at remarks. Kept as a secondary check in
        // case the backend field ever does get populated correctly.
        if (backendStatus === "no_work" || backendStatus === "no work") {
            return "no work";
        }

        const remarkRaw = (employee.remarks || employee.remark || "").toString().trim();
        if (remarkRaw) {
            const remarkUpper = remarkRaw.toUpperCase();
            // A leave code must be the first token. This accepts a reason
            // after the code (for example "PL - newborn") without treating
            // unrelated text that merely contains a code as leave.
            if (/^(VL|SL|ML|SS|PL)(?:[\s:-]|$)/.test(remarkUpper) || remarkUpper.startsWith("ON LEAVE")) {
                return "on leave";
            }
            return "absent";
        }

        const shift = (
            employee.shift ||
            employee.shift_name ||
            ""
        ).toLowerCase();

        const timeIn = parseAttendanceTime(employee.time_in);

        if (backendStatus === "on leave") {
            if (timeIn === null) return "on leave";
            // Has a time_in despite being marked on leave — fall through
            // to the same present/late cutoff logic used below.
        } else {
            if (backendStatus === "present")
                return "present";

            if (backendStatus === "late")
                return "late";

            if (backendStatus === "pending")
                return "pending";

            if (backendStatus === "absent")
                return "absent";
        }

        // -------------------------------------------------
        // Fallback: calculate from time_in if backend
        // didn't provide a usable status (or on-leave got
        // overridden by an actual time_in above)
        // -------------------------------------------------
        console.log("[classifyStatus]", {
            id: employee.id,
            name: employee.name,
            backend_status: backendStatus,
            raw_time_in: employee.time_in,
            parsed_time_in: timeIn,
            shift
        });

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const DAY_START = 7 * 60;
        const DAY_LATE = 7 * 60 + 1;

        const NIGHT_START = 19 * 60;
        const NIGHT_LATE = 19 * 60 + 1;

        if (shift.includes("night")) {
            if (timeIn !== null)
                return timeIn >= NIGHT_LATE ? "late" : "present";

            if (currentMinutes < NIGHT_START)
                return "pending";

            return "absent";
        }

        if (timeIn !== null)
            return timeIn >= DAY_LATE ? "late" : "present";

        if (currentMinutes < DAY_START)
            return "pending";

        return "absent";

    } catch (err) {
        console.error("[classifyStatus] FAILED:", employee, err);
        return "error";
    }
}
function buildSortedEmployeeRows(employees) {

    const leaderPriority = {
        "Sr.  Leader": 1,
        "Sr. Leader": 1,
        "Sr.Leader": 1,
        "SR.LEADER": 1,
        "LINE LEADER": 2,
        "Line Leader": 2,
        "ASST.LEADER": 3,
        "Asst.Leader": 3,
        "Asst. Leader": 3,
        "ASSISTANT LEADER": 3,
        "ASST. LEADER": 3
    };

    const surname = (name = "") => {
        name = name.trim();

        if (name.includes(",")) {
            return name.split(",")[0].trim().toUpperCase();
        }

        const parts = name.split(/\s+/);
        return parts.length ? parts[parts.length - 1].toUpperCase() : "";
    };

    return employees
        .map(e => {

            const bucket = classifyStatus(e);

            return {
                id: e.id,
                name: e.name || "",
                department: classifyDepartment(e.department),
                process: e.section || "Unassigned",
                statusBucket: bucket,
                statusLabel: bucket.charAt(0).toUpperCase() + bucket.slice(1),
                timeIn: e.time_in || null,
                remarks: e.remarks || e.remark || "",
                gender: e.gender || ""
            };
        })
        .sort((a, b) => {

            // Department first
            if (a.department !== b.department) {
                return a.department.localeCompare(b.department);
            }

            // Leader hierarchy
            const pa = leaderPriority[(a.process || "").toUpperCase()] || 999;
            const pb = leaderPriority[(b.process || "").toUpperCase()] || 999;

            if (pa !== pb) {
                return pa - pb;
            }

            // Everyone else alphabetically by surname
            return surname(a.name).localeCompare(surname(b.name));
        });

}

/**
 * Groups employees by their process/section (e.g. Assembly, Welding, QC)
 * and flags any process whose absence rate meets or exceeds the
 * deficiency threshold — a labor-shortage signal for that station.
 */
function computeProcessDeficiencies(employees) {
    const byProcess = {};

    employees.forEach(e => {
        const process = e.section || "Unassigned";
        const status = classifyStatus({
            id: e.id ?? e.emp_id,
            name: e.full_name ?? e.name,
            status: e.status,
            time_in: e.time_in,
            shift_name: e.shift_name ?? e.shift,
            shift: e.shift,
            section: e.section,
            remarks: e.remarks || e.remark
        });

        if (!byProcess[process]) byProcess[process] = { total: 0, absent: 0 };
        byProcess[process].total += 1;
        if (status === "absent") byProcess[process].absent += 1;
    });

    return Object.entries(byProcess)
        .map(([process, { total, absent }]) => ({
            process,
            total,
            absentCount: absent,
            absentRate: total ? Math.round((absent / total) * 1000) / 10 : 0,
        }))
        .filter(p => p.absentRate >= SUMMARY_DEFICIENCY_THRESHOLD_PCT)
        .sort((a, b) => processRank(a.process) - processRank(b.process));
}

/** Clamps a page number into [1, totalPages] and slices the source list. */
function paginate(list, page, perPage) {
    const totalPages = Math.max(1, Math.ceil(list.length / perPage));
    const clampedPage = Math.min(Math.max(1, page), totalPages);
    const start = (clampedPage - 1) * perPage;
    return { page: clampedPage, totalPages, items: list.slice(start, start + perPage) };
}

/**
 * @param {string} groupId
 * @param {string} [department] - When provided (e.g. from the department
 *   view's per-line Summary button), scopes the entire summary — metrics,
 *   table rows, and deficiency analysis — to only that group's employees
 *   who classify into this department. Employees from other departments
 *   on the same line are excluded entirely, not just visually filtered.
 *   When omitted, behaves exactly as before: the full line, all departments.
 */
export async function viewLineSummary(groupId, department) {
    // Make sure we're checking against today's no-work list before
    // classifying anyone — avoids a stale/empty set on first open.
    await refreshNoWorkSet();

    const group = (state.data.groups || []).find(
        g => String(g.id) === String(groupId)
    );

    if (!group) {
        Swal.fire("Error", "Group not found.", "error");
        return;
    }

    if (!isGroupInUserScope(group)) {
        Swal.fire("Access denied", "You don't have access to this line.", "error");
        return;
    }

    // Kung meron nang department scope ang user (LINE + department), at
    // may ibang department na pinasa (e.g. galing sa department-view
    // Summary button ng ibang bucket), i-deny — hindi lang basta
    // i-filter, dahil pwedeng ma-guess/ma-type ang department string
    // direkta sa console.
    const user = state.currentUser;
    if (user && user.access_level === "LINE" && user.department
        && department && department.toUpperCase() !== user.department.toUpperCase()) {
        Swal.fire("Access denied", "You don't have access to this department.", "error");
        return;
    }

    const allGroupEmployees = group.employees || [];
    const employees = department
        ? allGroupEmployees.filter(e => classifyDepartment(e.department) === department)
        : allGroupEmployees;

    const total = employees.length;

const present = [];
const late = [];
const pending = [];
const onLeave = [];
const noWork = [];
const absent = [];

employees.forEach(e => {
    const status = classifyStatus({
        id: e.id ?? e.emp_id,
        name: e.full_name ?? e.name,
        status: e.status,
        time_in: e.time_in,
        shift_name: e.shift_name ?? e.shift,
        shift: e.shift,
        section: e.section,
        remarks: e.remarks || e.remark 
    });

    const payload = {
        id: e.emp_id || e.id,
        name: e.full_name || e.name,
        section: e.section || "Unassigned",
        time_in: e.time_in,
        shift: e.shift_name || e.shift,
        remarks: e.remarks || e.remark || ""
    };

    if (status === "present") {
        present.push(payload);
    }
    else if (status === "late") {
        late.push(payload);
    }
    else if (status === "pending") {
        pending.push(payload);
    }
    else if (status === "on leave") {
        onLeave.push(payload);
    }
    else if (status === "no work") {
        noWork.push(payload);
    }
    else if (status === "absent") {
        absent.push(payload);
    }
});

    state.summaryModalData = {
        line_name: group.line_name,
        shift: group.shift,
        department: department || null,
        _groupId: groupId,
        metrics: {
            total_employees: total,
            present_count: present.length,
            late_count: late.length,
            absent_count: absent.length,
            on_leave_count: onLeave.length,
            no_work_count: noWork.length,
            late_percentage: total ? (late.length / total * 100).toFixed(1) : 0,
            absent_percentage: total ? (absent.length / total * 100).toFixed(1) : 0
        },
        employees: {
            present,
            late,
            absent,
            pending,
            onLeave,
            noWork
        },
        allEmployees: buildSortedEmployeeRows(employees),
        deficiencies: computeProcessDeficiencies(employees),
    };

    state.summaryModalPage = 1;

    renderSummaryModal();
}
/** Prev/Next handler wired to the pagination buttons in renderSummaryModal. */
export function changeSummaryModalPage(delta) {
    const data = state.summaryModalData;
    if (!data) return;

    const totalPages = Math.max(1, Math.ceil(data.allEmployees.length / SUMMARY_MODAL_PAGE_SIZE));
    state.summaryModalPage = Math.min(Math.max(1, (state.summaryModalPage || 1) + delta), totalPages);
    renderSummaryModal();
}
export async function updateRemarkForEmployee(empId, remark) {
    // The API enforces this too. Keep the client guard so an input exposed
    // through devtools cannot mislead another access level into thinking the
    // update was permitted.
    if (!canEditRemarks()) {
        Swal.fire("Access denied", "Only Line Leaders can update employee remarks.", "error");
        const input = document.querySelector(`input[data-emp-id="${cssEscape(empId)}"]`);
        if (input) input.value = findEmployeeRemark(empId) || "";
        return;
    }

    const previousRemark = findEmployeeRemark(empId);
    const trimmedNew = (remark || "").trim();
    const label = trimmedNew || "(cleared)";

    const confirmResult = await Swal.fire({
        icon: "question",
        title: "Update remark?",
        html: `Set remark for this employee to <b>${escapeHtml(label)}</b>?` +
              (["VL", "SL", "ML", "SS", "PL"].includes(trimmedNew.toUpperCase())
                  ? `<div style="margin-top:6px;color:#64748b;font-size:13px;">This will classify them as <b>On Leave</b>.</div>`
                  : trimmedNew
                      ? `<div style="margin-top:6px;color:#64748b;font-size:13px;">This will classify them as <b>Absent</b>.</div>`
                      : `<div style="margin-top:6px;color:#64748b;font-size:13px;">Their status will be recalculated from today's check-in.</div>`),
        showCancelButton: true,
        confirmButtonText: "Yes, update",
        cancelButtonText: "Cancel",
        confirmButtonColor: "#2563eb",
        reverseButtons: true,
        // FIX: summaryModal container sits at z-index 4000, but SweetAlert2's
        // default container z-index is lower, so it was rendering underneath.
        // didOpen fires after Swal injects its container into the DOM, so we
        // grab it and push it above our modal.
        didOpen: () => {
            const container = document.querySelector(".swal2-container");
            if (container) container.style.zIndex = "5000";
        }
    });

    if (!confirmResult.isConfirmed) {
        const input = document.querySelector(`input[data-emp-id="${cssEscape(empId)}"]`);
        if (input) input.value = previousRemark || "";
        return;
    }

    try {
        await updateEmployeeRemark(empId, trimmedNew);

        const manualStatus = classifyManualRemark(trimmedNew);

        if (manualStatus) {
            (state.data.groups || []).forEach(g => {
                const emp = (g.employees || []).find(e => e.id === empId);
                if (emp) {
                    emp.remarks = trimmedNew;
                    emp.status = manualStatus;
                }
            });
        } else {
            const fresh = await fetchDashboardData();
            mergeGroupsState(fresh);
        }

        if (state.summaryModalData && state.summaryModalData._groupId) {
            viewLineSummary(state.summaryModalData._groupId, state.summaryModalData.department);
        }

        // Same z-index fix needed here — this success toast is also a Swal
        // popup rendering while the summary modal is still open.
        Swal.fire({
            icon: "success",
            title: "Remark updated",
            timer: 900,
            showConfirmButton: false,
            didOpen: () => {
                const container = document.querySelector(".swal2-container");
                if (container) container.style.zIndex = "5000";
            }
        });
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "Unable to update remark",
            didOpen: () => {
                const container = document.querySelector(".swal2-container");
                if (container) container.style.zIndex = "5000";
            }
        });
        const input = document.querySelector(`input[data-emp-id="${cssEscape(empId)}"]`);
        if (input) input.value = previousRemark || "";
    }
}
window.updateRemarkForEmployee = updateRemarkForEmployee;
function raiseSwalAboveModal() {
    const container = document.querySelector(".swal2-container");
    if (container) container.style.zIndex = "5000";
}
const MANUAL_LEAVE_CODES = ["VL", "SL", "ML", "SS", "PL"];

function classifyManualRemark(remark) {
    const clean = (remark || "").trim().toUpperCase();
    if (!clean) return null;
    if (MANUAL_LEAVE_CODES.some(code => new RegExp(`^${code}(?:[\\s:-]|$)`).test(clean))) return "on leave";
    return "absent";
}
// Looks up an employee's currently-known remark from state, used to
// revert the combobox input if the confirmation is cancelled or the save
// fails. Checks summaryModalData.allEmployees first (it's what's on
// screen), then falls back to state.data.groups.
function findEmployeeRemark(empId) {
    const rows = state.summaryModalData?.allEmployees || [];
    const row = rows.find(r => r.id === empId);
    if (row) return row.remarks || "";

    for (const g of (state.data.groups || [])) {
        const emp = (g.employees || []).find(e => e.id === empId);
        if (emp) return emp.remarks || "";
    }
    return "";
}

// Minimal escaping helpers — remark text is user-typed free text, so it
// needs escaping both for the Swal confirmation HTML and for building a
// CSS attribute selector safely.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function cssEscape(value) {
    return String(value).replace(/(["\\])/g, "\\$1");
}
window.updateRemarkForEmployee = updateRemarkForEmployee;
// Inline onclick="changeSummaryModalPage(...)" in renderSummaryModal's markup
// needs this on window explicitly — ES module exports aren't visible to
// inline HTML event handlers on their own.
window.changeSummaryModalPage = changeSummaryModalPage;

export function closeSummaryModal() {
    state.summaryModalOpen = false;
    state.summaryModalLine = null;
    state.summaryModalData = null;
    state.summaryModalPage = 1;
    const el = document.getElementById("summaryModal");
    if (el) el.style.display = "none";
}

function ensureSummaryModalContainer() {
    let el = document.getElementById("summaryModal");
    if (!el) {
        el = document.createElement("div");
        el.id = "summaryModal";
        el.className = "sm-overlay";
        el.style.cssText = `
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(15, 23, 42, 0.5);
            z-index: 4000;
            align-items: center;
            justify-content: center;
        `;
        el.addEventListener("click", (e) => { if (e.target === el) closeSummaryModal(); });
        document.body.appendChild(el);
    }
    return el;
}

function renderSummaryModal() {
    const data = state.summaryModalData;
    if (!data) return;

    const el = ensureSummaryModalContainer();
    const { metrics, line_name, shift, department, allEmployees, deficiencies } = data;
    const viewOnly = isViewOnlyUser();
    const remarksEditable = canEditRemarks();

    const deptBadge = department ? `
        <span class="sm-badge sm-badge-dept">🏢 ${department}</span>` : "";

    const viewOnlyBadge = viewOnly ? `
        <span class="sm-badge sm-badge-muted">📝 Remarks only</span>` : "";

    const deficiencyBanner = deficiencies.length ? `
        <div class="sm-banner">
            ⚠️ Critical Deficiency Detected in: ${deficiencies.map(d => `${d.process} (${d.absentRate}% absent)`).join(", ")}
        </div>` : "";

    const statusClass = { Present: "present", Late: "late", Pending: "pending", Absent: "absent", Error: "error", "No work": "nowork" };

    const pageInfo = paginate(allEmployees, state.summaryModalPage || 1, SUMMARY_MODAL_PAGE_SIZE);
    state.summaryModalPage = pageInfo.page; // keep in sync if list shrank below current page

    const tableRow = (e) => {
        const remarksCell = !remarksEditable
            ? `<span class="sm-muted">${escapeHtml(e.remarks || "—")}</span>`
            : `<input type="text" list="remarkPresetOptions" class="sm-input"
                    value="${(e.remarks || "").replace(/"/g, "&quot;")}"
                    placeholder="—"
                    data-emp-id="${e.id}"
                    onchange="updateRemarkForEmployee('${e.id}', this.value)">`;

        return `
        <tr class="sm-row">
            <td class="sm-muted">${e.id}</td>
            <td class="sm-name">${e.name}</td>
            <td class="sm-muted">${e.process}</td>
            <td class="sm-muted">${e.gender || "—"}</td>
            <td class="sm-status sm-st-${statusClass[e.statusLabel] || "nowork"}">${e.statusLabel}</td>
            <td class="sm-muted">${e.timeIn || "—"}</td>
            <td>${remarksCell}</td>
        </tr>`;
    };

    const bodyRows = (() => {
        if (!pageInfo.items.length) {
            return `<tr><td colspan="7" class="sm-empty">No employees</td></tr>`;
        }
        let html = "";
        let currentDepartment = "";
        pageInfo.items.forEach(emp => {
            if (emp.department !== currentDepartment) {
                currentDepartment = emp.department;
                html += `<tr><td colspan="7" class="sm-dept-row">${currentDepartment}</td></tr>`;
            }
            html += tableRow(emp);
        });
        return html;
    })();

    el.innerHTML = `
        <div class="sm-box">
            <datalist id="remarkPresetOptions">
                <option value="VL">
                <option value="SL">
                <option value="ML">
                <option value="SS">
                <option value="PL">
            </datalist>
            <div class="sm-head">
                <h2>${line_name} <small>(${shift})</small>${deptBadge}${viewOnlyBadge}</h2>
                <span class="sm-close" onclick="closeSummaryModal()">&times;</span>
            </div>

            ${deficiencyBanner}

            <div class="sm-cards">
                <div class="sm-card sm-card-present">
                    <div class="sm-card-label">PRESENT</div>
                    <div class="sm-card-value">${metrics.present_count}</div>
                </div>
                <div class="sm-card sm-card-late">
                    <div class="sm-card-label">LATE</div>
                    <div class="sm-card-value">${metrics.late_count}</div>
                    <div class="sm-card-pct">${metrics.late_percentage}%</div>
                </div>
                <div class="sm-card sm-card-absent">
                    <div class="sm-card-label">ABSENT</div>
                    <div class="sm-card-value">${metrics.absent_count}</div>
                    <div class="sm-card-pct">${metrics.absent_percentage}%</div>
                </div>
                <div class="sm-card sm-card-nowork">
                    <div class="sm-card-label">NO WORK</div>
                    <div class="sm-card-value">${metrics.no_work_count}</div>
                </div>
                <div class="sm-card sm-card-total">
                    <div class="sm-card-label">TOTAL</div>
                    <div class="sm-card-value">${metrics.total_employees}</div>
                </div>
            </div>

            <table class="sm-table">
                <thead>
                    <tr>
                        <th>ID</th><th>Name</th><th>Process</th><th>Gender</th>
                        <th>Status</th><th>Time In</th><th>Remarks</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>

            <div class="sm-pager">
                <button class="sm-btn" onclick="changeSummaryModalPage(-1)" ${pageInfo.page === 1 ? "disabled" : ""}>◀ Prev</button>
                <span class="sm-muted">Page ${pageInfo.page} of ${pageInfo.totalPages} (${allEmployees.length} total)</span>
                <button class="sm-btn" onclick="changeSummaryModalPage(1)" ${pageInfo.page === pageInfo.totalPages ? "disabled" : ""}>Next ▶</button>
            </div>
        </div>`;

    el.style.display = "flex";
}
window.viewLineSummary = viewLineSummary;
window.changeSummaryModalPage = changeSummaryModalPage;