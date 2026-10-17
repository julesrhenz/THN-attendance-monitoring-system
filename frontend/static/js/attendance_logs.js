// ======================================================
// ATTENDANCE LOGS DASHBOARD
// ======================================================

const HISTORY_PAGE_SIZE = 7;
let TABLE_PAGE_SIZE = 25;
const TREND_MAX_BARS = 30;
const ATTENDANCE_LOGS_URL = "/api/attendance-logs";
const ON_LEAVE_SOURCE_URL = "/api/data";
const NO_WORK_SOURCE_URL = "/api/no-work";
const TIME_IN_REQUESTS_URL = "/api/attendance/time-in-request";
const NOTIFICATIONS_URL = "/api/notifications";
const APPROVAL_POLL_INTERVAL_MS = 8 * 1000; // 8s
const TIME_SORT_KEYS = new Set(["time_in", "time_out"]);
const DAY_CUTOFF_MINUTES = 7 * 60 + 1;    // 07:01 AM — Day Shift Present/Late boundary
const NIGHT_CUTOFF_MINUTES = 19 * 60 + 1; // 07:01 PM — Night Shift Present/Late boundary
const NIGHT_SHIFT_START_MINUTES = 19 * 60; // 07:00 PM — shift considered "begun"
// Upper bound on how many days a single date-range export can cover, so a
// mistaken/huge range (e.g. a typo'd year) doesn't fire off hundreds of
// sequential fetches against the server. ~2 months is generous for a
// payroll-period-style export while staying safe.
const MAX_EXPORT_RANGE_DAYS = 62;
// ── Actual shift windows (before OT) ───────────────────────────────────
const DAY_SHIFT_START_MINUTES = 7 * 60;    // 7:00 AM
const DAY_SHIFT_BASE_END_MINUTES = 16 * 60; // 4:00 PM (OT onwards after this)
const NIGHT_SHIFT_BASE_END_MINUTES = 4 * 60; // 4:00 AM next day (OT onwards after this)
// ── Missing-punch OT deadline ──────────────────────────────────────────
const DAY_SHIFT_OT_END_HOUR = 19;   // 7:00 PM same day
const NIGHT_SHIFT_OT_END_HOUR = 7;  // 7:00 AM next day

const MISSING_PUNCH_EXCLUDED_STATUSES = new Set(["on leave", "no work", "pending", "absent"]);

let historyRecordsAll = [];
let historyRangeValue = "all";

const CLAIMED_DEPTS = new Set(["QUALITY", "TECHNICAL", "ADMINISTRATION"]);

let currentUser = { role: null, department: null, access_level: null, is_admin: false, is_hr_approver: false, username: null };

function canViewDepartment(empDepartment) {
    const empDept = (empDepartment || "").toString().trim().toUpperCase();
    const userDept = (currentUser.department || "").toString().trim().toUpperCase();

    if (!userDept) return false;
    if (userDept === "ADMINISTRATION") return true;
    if (userDept === "QUALITY") return empDept === "QUALITY";
    if (userDept === "TECHNICAL") return empDept === "TECHNICAL";
    if (userDept === "PRODUCTION") return !CLAIMED_DEPTS.has(empDept);

    return false;
}

function canViewApprovalRequest(reqDepartment) {
    return canViewDepartment(reqDepartment);
}

function isHrApprover() {
    return !!currentUser.is_hr_approver;
}

function canActOnHrApproval() {
    return canReviewRequests();
}

function isViewer() {
    return (currentUser.role || "").toString().trim() === "Viewer";
}

// Anyone can submit a time-in/time-out change request now — no longer
// restricted to access_level === "LINE". (Backend must allow it too.)
function canSubmitTimeInRequest() {
    return true;
}

function canReviewRequests() {
    const level = (currentUser.access_level || "").toString().trim().toUpperCase();
    return currentUser.is_admin || ["SECTION", "DEPARTMENT", "GLOBAL"].includes(level);
}

function notifyPendingApprovalChange(kind, newCount, prevCount) {
    if (typeof Swal === "undefined") return;
    if (newCount <= prevCount) return;
    if (newCount === 0) return;

    const isFirst = kind === "first";
    const label = isFirst ? "First Approval" : "HR (Final) Approval";
    const delta = newCount - prevCount;

    const title = prevCount === 0
        ? `${newCount} pending ${label} request${newCount === 1 ? "" : "s"}`
        : `${delta} new ${label} request${delta === 1 ? "" : "s"} pending`;

    const ApprovalToast = Swal.mixin({
        toast: true,
        position: "top-end",
        showConfirmButton: false,
        timer: 7000,
        timerProgressBar: true,
        didOpen: (toastEl) => {
            toastEl.addEventListener("mouseenter", Swal.stopTimer);
            toastEl.addEventListener("mouseleave", Swal.resumeTimer);
            toastEl.style.cursor = "pointer";
            toastEl.addEventListener("click", () => {
                Swal.close();
                if (isFirst) {
                    openFirstApprovalModal();
                } else {
                    openPendingRequestsModal();
                }
            });
        },
    });

    ApprovalToast.fire({
        icon: "warning",
        title,
        text: "Click to review",
    });
}

async function loadCurrentUser() {
    try {
        const res = await fetch("/api/me", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();
        currentUser = {
            role: data.role || null,
            department: data.department || null,
            access_level: data.access_level || null,
            is_admin: !!data.is_admin,
            is_hr_approver: !!data.is_hr_approver,
            username: data.username || data.id || data.emp_id || null,
        };
    } catch (err) {
        console.error(err);
    }
}

let currentEmployees = [];
let selectedEmployee = null;

let tableFilteredEmployees = [];
let tablePage = 1;

let statusFilterValue = "";
let positionFilterValue = "";
let currentSort = { key: null, dir: 1 };

let historyRecords = [];
let historyPage = 1;
let historyEmployee = null;

let pendingFirstApprovalRequests = [];

let pendingTimeInRequests = [];
const selectedHrRequestIds = new Set();
let missingPunchRows = [];
let missingPunchesRange = { start: "", end: "" };
let missingPunchesLoadedAt = 0; // Date.now() timestamp of the last successful load for missingPunchesRange

// ── Missing-punches performance helpers ────────────────────────────────
// Short-lived per-date cache for /api/attendance-logs responses. The
// modal's "Refresh" button, the auto-load on open, and "Export Excel"
// all pull from the same date range most of the time (user opens the
// modal, glances at it, then exports) — without this they'd each fire
// their own full set of network requests for the exact same dates.
// A small TTL keeps the dashboard "live enough" while letting an
// export right after a refresh (or vice versa) skip the network
// entirely and jump straight to building the file.
const ATTENDANCE_CACHE_TTL_MS = 45 * 1000; // 45s
const attendanceLogsCache = new Map(); // dateISO -> { data, ts }

// Short-lived cache for the employee roster + on-leave remarks used to
// enrich the Missing Punches report/export. Without this, the roster
// (which is the SAME for every date in the range) would be re-fetched
// once per date in the range instead of once for the whole report.
let missingPunchesRosterCache = null;
const MISSING_PUNCHES_ROSTER_CACHE_TTL_MS = 45 * 1000;

async function getRosterAndRemarksForMissingPunches({ bypassCache = false } = {}) {
    if (!bypassCache && missingPunchesRosterCache &&
        (Date.now() - missingPunchesRosterCache.ts) < MISSING_PUNCHES_ROSTER_CACHE_TTL_MS) {
        return missingPunchesRosterCache;
    }

    const [rosterData, onLeaveData] = await Promise.all([
        fetch("/api/employee-groupings", { credentials: "same-origin" })
            .then(res => res.ok ? res.json() : null)
            .catch(() => null),
        fetch(ON_LEAVE_SOURCE_URL, { credentials: "same-origin" })
            .then(res => res.ok ? res.json() : null)
            .catch(() => null),
    ]);

    const rosterRecords = rosterData
        ? (Array.isArray(rosterData) ? rosterData : (rosterData.employees || rosterData.data || []))
        : [];
    const remarksMap = extractRemarksMap(onLeaveData);

    missingPunchesRosterCache = { rosterRecords, remarksMap, ts: Date.now() };
    return missingPunchesRosterCache;
}

// Tracks the in-flight request for the missing-punches modal so a new
// refresh/export/date-change can cancel a stale one instead of letting
// both run to completion (which only makes everything slower and can
// let an old response overwrite a newer one).
let missingPunchesAbortController = null;

async function fetchAttendanceLogsCached(dateISO, { bypassCache = false, signal } = {}) {
    const cached = attendanceLogsCache.get(dateISO);
    if (!bypassCache && cached && (Date.now() - cached.ts) < ATTENDANCE_CACHE_TTL_MS) {
        return cached.data;
    }

    const data = await fetch(`${ATTENDANCE_LOGS_URL}?date=${encodeURIComponent(dateISO)}`, {
        credentials: "same-origin",
        signal,
    }).then(res => res.json());

    attendanceLogsCache.set(dateISO, { data, ts: Date.now() });
    return data;
}

let lastNotifiedFirstApprovalCount = 0;
let lastNotifiedHrApprovalCount = 0;

let myNotifications = [];
let lastNotifiedMyNotificationsCount = 0;

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("shiftFilter").addEventListener("change", loadData);
    document.getElementById("dateFilter").value = todayISODate();
    document.getElementById("dateFilter").addEventListener("change", loadData);
    document.getElementById("globalSearch").addEventListener("input", debouncedFilterTable);

    document.getElementById("statusFilter").addEventListener("change", (e) => {
        statusFilterValue = e.target.value;
        filterTable();
    });
    document.getElementById("historyRangeFilter").addEventListener("change", (e) => {
        historyRangeValue = e.target.value;
        applyHistoryRangeFilter();
    });
    document.getElementById("positionFilter").addEventListener("change", (e) => {
        positionFilterValue = e.target.value;
        filterTable();
    });

    document.querySelectorAll(".attendance-table th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
            const key = th.dataset.sort;
            currentSort.dir = (currentSort.key === key) ? currentSort.dir * -1 : 1;
            currentSort.key = key;
            updateSortArrows();
            filterTable();
        });
    });
    document.getElementById("closeModal").addEventListener("click", closeModal);
    document.getElementById("saveAttendance").addEventListener("click", saveAttendance);
    initEditTimePickers();

    document.getElementById("closeHistoryModal").addEventListener("click", closeHistoryModal);
    document.getElementById("closeHistoryModalX").addEventListener("click", closeHistoryModal);
    document.getElementById("historyPrevPage").addEventListener("click", () => changeHistoryPage(-1));
    document.getElementById("historyNextPage").addEventListener("click", () => changeHistoryPage(1));

    document.getElementById("tablePrevPage").addEventListener("click", () => changeTablePage(-1));
    document.getElementById("tableNextPage").addEventListener("click", () => changeTablePage(1));
    document.getElementById("tablePageSize").addEventListener("change", (e) => {
        TABLE_PAGE_SIZE = parseInt(e.target.value, 10) || 25;
        tablePage = 1;
        renderTablePage();
    });
    document.getElementById("missingPunchesBtn").addEventListener("click", openMissingPunchesModal);
    document.getElementById("closeMissingPunchesModal").addEventListener("click", closeMissingPunchesModal);
    document.getElementById("closeMissingPunchesX").addEventListener("click", closeMissingPunchesModal);
    document.getElementById("refreshMissingPunchesBtn").addEventListener("click", refreshMissingPunchesReport);
    document.getElementById("exportMissingPunchesBtn").addEventListener("click", exportMissingPunchesToExcel);

    document.getElementById("firstApprovalBtn").addEventListener("click", openFirstApprovalModal);
    document.getElementById("closeFirstApprovalModal").addEventListener("click", closeFirstApprovalModal);
    document.getElementById("closeFirstApprovalX").addEventListener("click", closeFirstApprovalModal);

    document.getElementById("pendingRequestsBtn").addEventListener("click", handlePendingRequestsClick);
    document.getElementById("closePendingRequestsModal").addEventListener("click", closePendingRequestsModal);
    document.getElementById("closePendingRequestsX").addEventListener("click", closePendingRequestsModal);

    document.getElementById("notificationsBtn").addEventListener("click", openNotificationsModal);
    document.getElementById("closeNotificationsModal").addEventListener("click", closeNotificationsModal);
    document.getElementById("closeNotificationsX").addEventListener("click", closeNotificationsModal);

    window.addEventListener("click", (e) => {
        if (e.target === document.getElementById("editModal")) closeModal();
        if (e.target === document.getElementById("historyModal")) closeHistoryModal();
        if (e.target === document.getElementById("missingPunchesModal")) closeMissingPunchesModal();
        if (e.target === document.getElementById("firstApprovalModal")) closeFirstApprovalModal();
        if (e.target === document.getElementById("pendingRequestsModal")) closePendingRequestsModal();
        if (e.target === document.getElementById("notificationsModal")) closeNotificationsModal();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const historyModal = document.getElementById("historyModal");
        const editModal = document.getElementById("editModal");
        const missingModal = document.getElementById("missingPunchesModal");
        const firstApprovalModal = document.getElementById("firstApprovalModal");
        const pendingRequestsModal = document.getElementById("pendingRequestsModal");
        const notificationsModal = document.getElementById("notificationsModal");
        if (notificationsModal.style.display === "flex") {
            closeNotificationsModal();
        } else if (pendingRequestsModal.style.display === "flex") {
            closePendingRequestsModal();
        } else if (firstApprovalModal.style.display === "flex") {
            closeFirstApprovalModal();
        } else if (missingModal.style.display === "flex") {
            closeMissingPunchesModal();
        } else if (historyModal.style.display === "flex") {
            closeHistoryModal();
        } else if (editModal.style.display === "flex") {
            closeModal();
        }
    });

    (async () => {
        await loadCurrentUser();

        if (!isHrApprover()) {
            const btn = document.getElementById("pendingRequestsBtn");
            if (btn) btn.style.display = "none";
        } else {
            // HR approvers only handle the final (HR) approval step --
            // the Pending First Approval pill is hidden for them.
            const firstBtn = document.getElementById("firstApprovalBtn");
            if (firstBtn) firstBtn.style.display = "none";
        }

        loadData();
        loadPendingFirstApprovalRequests();
        if (isHrApprover()) {
            loadPendingTimeInRequests();
        }
        loadMyNotifications();

        setInterval(() => {
            loadPendingFirstApprovalRequests();
            if (isHrApprover()) {
                loadPendingTimeInRequests();
            }
            loadMyNotifications();
        }, APPROVAL_POLL_INTERVAL_MS);
    })();
});

function isThnEmployee(empId) {
    const id = (empId || "").trim().toUpperCase();
    return !/^[NCE]-/.test(id);
}

function normalizeEmpId(id) {
    return (id || "").toString().trim().toUpperCase();
}

function normalizeShiftLabel(value) {
    const upper = (value || "").toString().trim().toUpperCase();
    if (/\bNIGHT\b/.test(upper) || /\bNS\b/.test(upper)) return "night";
    if (/\bDAY\b/.test(upper) || /\bDS\b/.test(upper)) return "day";
    return "";
}

function isOnLeave(record) {
    if (!record) return false;
    const remarks = (record.remarks || "").toString().trim();
    if (/^(VL|SL|ML|SS|PL)(?:\s|:|-|$)/i.test(remarks) || /^ON LEAVE\b/i.test(remarks)) return true;
    const status = (record.employee_status || "").toString().trim().toUpperCase();
    return status === "ON LEAVE" || status === "LEAVE";
}
function isExplicitlyLate(record) {
    if (!record) return false;
    if (record.is_late === true || record.late === true) return true;
    const status = (record.attendance_status || record.employee_status || record.status || "")
        .toString().trim().toUpperCase();
    return status === "LATE";
}

function classifyStatus(timeInValue, onLeave, isNightShift, explicitLateSource) {
    const cutoff = isNightShift ? NIGHT_CUTOFF_MINUTES : DAY_CUTOFF_MINUTES;
    const timeInMinutes = parseTimeToMinutes(timeInValue);

    if (timeInMinutes !== null) {
        return timeInMinutes < cutoff ? "Present" : "Late";
    }
    if (onLeave) {
        return isExplicitlyLate(explicitLateSource) ? "Late" : "On Leave";
    }
    if (isNightShift) {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        return currentMinutes >= NIGHT_SHIFT_START_MINUTES ? "Absent" : "Pending";
    }
    return "Absent";
}

function classifyStatusForExport(dateISO, timeInValue, onLeave, isNightShift, explicitLateSource) {
    const cutoff = isNightShift ? NIGHT_CUTOFF_MINUTES : DAY_CUTOFF_MINUTES;
    const timeInMinutes = parseTimeToMinutes(timeInValue);

    if (timeInMinutes !== null) {
        return timeInMinutes < cutoff ? "Present" : "Late";
    }
    if (onLeave) {
        return isExplicitlyLate(explicitLateSource) ? "Late" : "On Leave";
    }

    const isToday = dateISO === todayISODate();
    if (isNightShift && isToday) {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        return currentMinutes >= NIGHT_SHIFT_START_MINUTES ? "Absent" : "Pending";
    }
    return "Absent";
}

function extractNoWorkSet(noWorkData) {
    const set = new Set();
    if (!noWorkData) return set;

    const records = Array.isArray(noWorkData)
        ? noWorkData
        : (noWorkData.data || noWorkData.records || []);

    records.forEach(r => {
        if (!r) return;
        const id = r.emp_id || r.emp_no;
        if (id) set.add(normalizeEmpId(id));
    });

    return set;
}

function extractRemarksMap(onLeaveData) {
    const map = new Map();
    if (!onLeaveData) return map;

    const collect = (emp) => {
        if (emp && emp.id && emp.remarks) map.set(normalizeEmpId(emp.id), emp.remarks);
    };

    (onLeaveData.groups || []).forEach(g => (g.employees || []).forEach(collect));
    (onLeaveData.unassigned || []).forEach(collect);

    return map;
}

function todayISODate() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoToLocalDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function localDateToISO(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function generateDateRangeISO(startISO, endISO) {
    const start = isoToLocalDate(startISO);
    const end = isoToLocalDate(endISO);
    const dates = [];
    const cursor = new Date(start);
    while (cursor <= end) {
        dates.push(localDateToISO(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
}

function isPunchDeadlinePassed(dateISO, shiftName) {
    const isNight = normalizeShiftLabel(shiftName) === "night";
    const deadline = isoToLocalDate(dateISO);

    if (isNight) {
        deadline.setDate(deadline.getDate() + 1);
        deadline.setHours(NIGHT_SHIFT_OT_END_HOUR, 0, 0, 0);
    } else {
        deadline.setHours(DAY_SHIFT_OT_END_HOUR, 0, 0, 0);
    }

    return new Date() > deadline;
}

function setRosterWarning(message) {
    const el = document.getElementById("rosterWarning");
    if (!el) return;
    if (!message) {
        el.style.display = "none";
        el.textContent = "";
    } else {
        el.style.display = "block";
        el.textContent = message;
    }
}
function buildRosterShiftMap(rosterRecords) {
    const map = new Map();
    (rosterRecords || []).forEach(g => {
        if (g && g.emp_id) map.set(normalizeEmpId(g.emp_id), normalizeShiftLabel(g.shift));
    });
    return map;
}
function pickEarliestTime(a, b) {
    const am = parseTimeToMinutes(a);
    const bm = parseTimeToMinutes(b);
    if (am === null) return b;
    if (bm === null) return a;
    return am <= bm ? a : b;
}

function pickLatestTime(a, b) {
    const am = parseTimeToMinutes(a);
    const bm = parseTimeToMinutes(b);
    if (am === null) return b;
    if (bm === null) return a;
    return am >= bm ? a : b;
}

// ── Shared roster/attendance merge core ─────────────────────────────────
// Both the live table (mergeRosterWithAttendance) and every Excel export
// (buildExportRowsForDate) need to combine one roster entry with its
// matching attendance log row(s) the exact same way — same de-dup rule for
// double biometric taps, same "roster wins on org fields" rule, same leave/
// no-work/status classification. Previously these lived as two parallel,
// hand-copied implementations; a fix to one (e.g. the dedup rule) had to be
// remembered and re-applied to the other or the table and exports would
// quietly diverge. This single function is now the only place that logic
// lives; both callers just choose which status classifier to use.
function mergeOneRosterEntry(g, attendanceByEmpId, { remarksMap, noWorkSet, dateISO, classify }) {
    const attendance = attendanceByEmpId.get(normalizeEmpId(g.emp_id));

    // Per-employee shift — kinukuha sa aktwal na na-punch na shift
    // (kung meron), roster shift na lang bilang fallback. HINDI na
    // galing sa global shift filter dropdown.
    const employeeIsNightShift = normalizeShiftLabel(
        (attendance && attendance.shift_name) || g.shift
    ) === "night";

    const remarks = (g.remarks || "").toString().trim()
        || (remarksMap.get(normalizeEmpId(g.emp_id)) || "");

    const onLeave = isOnLeave({ ...g, remarks });
    const noWork = (noWorkSet || new Set()).has(normalizeEmpId(g.emp_id));

    if (attendance) {
        // NEEDS_REVIEW punches are only proposals (see renderPunchEvidence) —
        // don't count them as Present/Late. The history modal already shows
        // them as "Needs Review", so both views now agree.
        const needsReview = attendance.matching_status === "NEEDS_REVIEW";
        const status = noWork
            ? "No Work"
            : needsReview
                ? "Needs Review"
                : classify(attendance.time_in, onLeave, employeeIsNightShift, attendance);
        return {
            ...g,
            ...attendance,
            // Keep the roster's emp_id so the history modal looks up the
            // same employee the row represents (attendance.emp_id could
            // differ in format/case).
            emp_id: g.emp_id || attendance.emp_id,
            emp_no: attendance.emp_no || g.emp_no,
            full_name: attendance.full_name || g.full_name,
            position: attendance.position || g.position || g.process || "Unassigned",
            shift_name: attendance.inferred_shift || attendance.shift_name || g.shift,
            // Roster is the source of truth for org structure — a stale
            // or misconfigured tag on the raw attendance log (e.g. from
            // an old biometric-device assignment) must not override the
            // employee's CURRENT department/line from the roster.
            department: g.department || attendance.department || "",
            line_name: g.line_name || g.line || attendance.line_name || attendance.line || "",
            status,
            remarks,
            ...(dateISO ? { attendance_date: dateISO } : {}),
        };
    }

        const status = noWork ? "No Work" : classify(null, onLeave, employeeIsNightShift, g);
    return {
        emp_id: g.emp_id,
        emp_no: g.emp_no,
        full_name: g.full_name || [g.first_name, g.last_name].filter(Boolean).join(" "),
        position: g.position || g.process || "Unassigned",
        shift_name: g.shift,
        department: g.department || "",
        line_name: g.line_name || g.line || "",
        gender: g.gender || "",
        status,
        time_in: null,
        time_in_status: null,
        time_out: null,
        time_out_status: null,
        attendance_date: dateISO || todayISODate(),
        has_log: !dateISO ? false : undefined,
        remarks,
    };
}

function buildAttendanceByEmpIdMap(rosterRecords, attendanceEmployees) {
    const rosterShiftByEmpId = buildRosterShiftMap(rosterRecords);
    const attendanceByEmpId = new Map();

    (attendanceEmployees || []).forEach(emp => {
        if (!emp || !emp.emp_id) return;
        const key = normalizeEmpId(emp.emp_id);
        const existing = attendanceByEmpId.get(key);

        if (!existing) {
            attendanceByEmpId.set(key, emp);
            return;
        }

        // Never synthesize endpoints by merging different attendance dates.
        // Prefer the latest complete record supplied by the processor.
        const oldDate = String(existing.attendance_date || "");
        const newDate = String(emp.attendance_date || "");
        if (newDate > oldDate || (newDate === oldDate && emp.matching_status === "CONFIRMED" && existing.matching_status !== "CONFIRMED")) {
            attendanceByEmpId.set(key, emp);
        }

    });

    return attendanceByEmpId;
}

function filterActiveRosterForShift(rosterRecords, targetShift) {
    return (rosterRecords || []).filter(g => {
        const active = (g.employee_status || "").toUpperCase() !== "INACTIVE";
        const matchesShift = !targetShift || normalizeShiftLabel(g.shift) === targetShift;
        return active && isThnEmployee(g.emp_id) && matchesShift;
    });
}

function mergeRosterWithAttendance(rosterRecords, attendanceEmployees, shift, remarksMap, noWorkSet) {
    const targetShift = normalizeShiftLabel(shift);
    const attendanceByEmpId = buildAttendanceByEmpIdMap(rosterRecords, attendanceEmployees);
    const roster = filterActiveRosterForShift(rosterRecords, targetShift);

    const merged = roster.map(g => mergeOneRosterEntry(g, attendanceByEmpId, {
        remarksMap,
        noWorkSet,
        dateISO: null,
        classify: classifyStatus,
    }));

    const mergedIds = new Set(merged.map(e => normalizeEmpId(e.emp_id)));
    (attendanceEmployees || []).forEach(emp => {
        if (!emp || !emp.emp_id) return;
        if (!isThnEmployee(emp.emp_id)) return;
        if (mergedIds.has(normalizeEmpId(emp.emp_id))) return;
        if (targetShift && normalizeShiftLabel(emp.shift_name) !== targetShift) return;

        if (!window.unknownAttendanceLogs) {
            window.unknownAttendanceLogs = [];
        }

        window.unknownAttendanceLogs.push({
            ...emp,
            _unknown_log: true
        });
    });

    return merged;
}

function buildExportRowsForDate(dateISO, rosterRecords, attendanceEmployees, shift, remarksMap, noWorkSet) {
    const targetShift = normalizeShiftLabel(shift);
    const attendanceByEmpId = buildAttendanceByEmpIdMap(rosterRecords, attendanceEmployees);
    const roster = filterActiveRosterForShift(rosterRecords, targetShift);

    return roster.map(g => mergeOneRosterEntry(g, attendanceByEmpId, {
        remarksMap,
        noWorkSet,
        dateISO,
        classify: (timeIn, onLeave, isNight, source) =>
            classifyStatusForExport(dateISO, timeIn, onLeave, isNight, source),
    }));
}

async function loadData() {
    const shift = document.getElementById("shiftFilter").value;
    const selectedDate = document.getElementById("dateFilter").value || todayISODate();

    try {
        const attendanceReq = fetch(`${ATTENDANCE_LOGS_URL}?date=${encodeURIComponent(selectedDate)}`, { credentials: "same-origin" })
            .then(res => res.json());

        const rosterReq = fetch("/api/employee-groupings", { credentials: "same-origin" })
        .then(res => res.ok ? res.json() : null)
        .catch(() => null);
        const onLeaveReq = fetch(ON_LEAVE_SOURCE_URL, { credentials: "same-origin" })
            .then(res => res.ok ? res.json() : null)
            .catch(() => null);
        const noWorkReq = fetch(`${NO_WORK_SOURCE_URL}?date=${encodeURIComponent(selectedDate)}`, { credentials: "same-origin" })
            .then(res => res.ok ? res.json() : null)
            .catch(() => null);

        const [data, rosterData, onLeaveData, noWorkData] = await Promise.all([attendanceReq, rosterReq, onLeaveReq, noWorkReq]);

        if (!data.success) {
            alert(data.message || "Failed to load attendance data.");
            return;
        }

        const remarksMap = extractRemarksMap(onLeaveData);
        const noWorkSet = extractNoWorkSet(noWorkData);

        const attendanceEmployees = (data.data || []).filter(emp => isThnEmployee(emp.emp_id));

        if (rosterData) {
            const rosterRecords = Array.isArray(rosterData) ? rosterData : (rosterData.employees || rosterData.data || []);
            window.unknownAttendanceLogs = [];
            currentEmployees = mergeRosterWithAttendance(rosterRecords, attendanceEmployees, shift, remarksMap, noWorkSet);
            setRosterWarning(null);
        } else {
            currentEmployees = attendanceEmployees.filter(emp =>
                !shift || normalizeShiftLabel(emp.shift_name) === normalizeShiftLabel(shift)
            );
            setRosterWarning("Full employee roster unavailable — showing only employees with a log today.");
        }
        // NOTE (security): this department filter is a UI convenience only.
        // The full, unfiltered payload for ALL departments has already been
        // downloaded to this browser by this point. Do not treat this line
        // as an access-control boundary — the /api/attendance-logs and
        // /api/employee-groupings endpoints must scope their response to
        // the authenticated user's department server-side. Client-side
        // filtering can be bypassed by anyone reading the Network tab.
        currentEmployees = currentEmployees.filter(emp => canViewDepartment(emp.department));

        setRosterWarning(null);
        populatePositionFilter(currentEmployees);
        updateMissingPunchesBadge();
        filterTable();

    } catch (err) {
        console.error(err);
        alert("Failed to load attendance data.");
    }
}

// ======================================================
// FILTERING, SORTING, RENDERING
// ======================================================

function populatePositionFilter(employees) {
    const select = document.getElementById("positionFilter");
    const current = select.value;
    const positions = [...new Set(employees.map(e => e.position || "Unassigned"))].sort();

    select.innerHTML = `<option value="">All Positions</option>` +
        positions.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");

    select.value = positions.includes(current) ? current : "";
}
function updateSortArrows() {
    document.querySelectorAll(".attendance-table th[data-sort]").forEach(th => {
        const arrow = th.querySelector(".sort-arrow");
        if (th.dataset.sort === currentSort.key) {
            arrow.textContent = currentSort.dir === 1 ? "▲" : "▼";
        } else {
            arrow.textContent = "";
        }
    });
}
function parseTimeToMinutes(value) {
    if (!value) return null;
    const str = String(value).trim().toUpperCase();
    if (!str) return null;

    const ampmMatch = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/);
    if (ampmMatch) {
        let hour = parseInt(ampmMatch[1], 10);
        const minute = parseInt(ampmMatch[2], 10);
        if (ampmMatch[4] === "PM" && hour !== 12) hour += 12;
        if (ampmMatch[4] === "AM" && hour === 12) hour = 0;
        return hour * 60 + minute;
    }

    const plainMatch = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (plainMatch) {
        return parseInt(plainMatch[1], 10) * 60 + parseInt(plainMatch[2], 10);
    }

    return null;
}

// Small debounce helper so a fast typist doesn't trigger a full
// filter+re-render on every single keystroke.
function debounce(fn, waitMs) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), waitMs);
    };
}

function filterTable() {
    const keyword = document.getElementById("globalSearch").value.toLowerCase();

    let filtered = currentEmployees.filter(emp => {
        const matchesKeyword = !keyword ||
            (emp.emp_id || "").toLowerCase().includes(keyword) ||
            (emp.full_name || "").toLowerCase().includes(keyword);

        const matchesStatus = !statusFilterValue || emp.status === statusFilterValue;
        const matchesPosition = !positionFilterValue || (emp.position || "Unassigned") === positionFilterValue;

        return matchesKeyword && matchesStatus && matchesPosition;
    });

    if (currentSort.key && TIME_SORT_KEYS.has(currentSort.key)) {
        const key = currentSort.key;
        filtered = [...filtered].sort((a, b) => {
            const av = parseTimeToMinutes(a[key]);
            const bv = parseTimeToMinutes(b[key]);
            if (av === null && bv === null) return 0;
            if (av === null) return 1;
            if (bv === null) return -1;
            return (av - bv) * currentSort.dir;
        });
    } else if (currentSort.key) {
        filtered = [...filtered].sort((a, b) => {
            const av = (a[currentSort.key] || "").toString().toLowerCase();
            const bv = (b[currentSort.key] || "").toString().toLowerCase();
            return av.localeCompare(bv) * currentSort.dir;
        });
    }

    renderTable(filtered);
}

const debouncedFilterTable = debounce(filterTable, 200);

function renderTable(employees) {
    tableFilteredEmployees = employees;
    tablePage = 1;
    renderTablePage();
}
function statusClassSuffix(statusLabel) {
    return (statusLabel || "").toLowerCase().trim().replace(/\s+/g, "-");
}

function renderTablePage() {
    const totalPages = Math.max(1, Math.ceil(tableFilteredEmployees.length / TABLE_PAGE_SIZE));
    tablePage = Math.min(Math.max(1, tablePage), totalPages);

    const start = (tablePage - 1) * TABLE_PAGE_SIZE;
    const pageEmployees = tableFilteredEmployees.slice(start, start + TABLE_PAGE_SIZE);

    const body = document.getElementById("attendanceTableBody");

    if (pageEmployees.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="table-empty-state">
                        <div class="empty-icon">🔍</div>
                        <div class="empty-title">No employees match your filters</div>
                        <div>Try adjusting search, status, or position filters.</div>
                    </div>
                </td>
            </tr>
        `;
    } else {
        body.innerHTML = "";

        pageEmployees.forEach(emp => {
            const row = document.createElement("tr");
            row.id = `emp-${sanitize(emp.emp_id)}`;
            row.className = "employee-row";

            const statusLabel = emp.status || "—";
            const hasLog = emp.has_log !== false;
            const initials = getInitials(emp.full_name || emp.emp_id);
            const canSubmitRequest = canSubmitTimeInRequest();

            // All employee-controlled/roster-sourced text (name, position,
            // gender, shift, time) is escaped before hitting innerHTML —
            // these values ultimately come from HR/roster records and must
            // not be trusted as safe markup.
            row.innerHTML = `
                <td data-label="ID">${escapeHtml(emp.emp_id)}</td>
                <td data-label="Name">
                    <div class="employee-name-cell">
                        <div class="employee-avatar">${escapeHtml(initials)}</div>
                        <span class="employee-name-link">${escapeHtml(emp.full_name || "")}</span>
                    </div>
                </td>
                <td data-label="Position">${escapeHtml(emp.position || "Unassigned")}</td>
                <td data-label="Gender">${escapeHtml(emp.gender || "—")}</td>
                <td data-label="Shift">${escapeHtml(emp.inferred_shift || emp.shift_name || "")}
                    ${emp.scheduled_shift ? `<small style="display:block">Scheduled: ${escapeHtml(emp.scheduled_shift)}</small>` : ""}
                    ${emp.matching_status ? `<small style="display:block" title="${escapeHtml(emp.review_reason || "")}">${escapeHtml(emp.matching_status)}${emp.review_reason ? ': ' + escapeHtml(emp.review_reason) : ''}</small>` : ""}${renderPunchEvidence(emp)}</td>
                <td data-label="Time In">${escapeHtml(emp.time_in || "—")}</td>
                <td class="cell-actions" data-label="Status">
                    <div class="status-cell-actions">
                        <span class="employee-status status-${statusClassSuffix(statusLabel)}">${escapeHtml(statusLabel)}</span>
                        ${hasLog ? "" : '<span style="margin-left:6px;font-size:11px;color:var(--text-muted);">(no log)</span>'}
                    ${canSubmitRequest ? `
                    <button type="button" class="edit-attendance-btn" title="Submit attendance change request"
                        style="margin-left:auto;border:none;background:transparent;cursor:pointer;color:var(--accent);font-size:12px;font-weight:700;">
                        ✎ Edit
                    </button>` : ""}
                    </div>
                </td>
                `;

                if (canSubmitRequest) {
                    row.querySelector(".edit-attendance-btn").addEventListener("click", (e) => {
                        e.stopPropagation();
                        editAttendance(emp);
                    });
                }

                row.addEventListener("click", (e) => {
                    const cellIndex = Array.from(row.children).indexOf(e.target.closest("td"));
                    if (cellIndex === 1) {
                        openHistoryModal(emp);
                    }
                });
                                // Prefetch history when the cursor reaches the name cell
                row.children[1].addEventListener("mouseenter", () => {
                    fetchEmployeeHistory(emp.emp_id).catch(() => {});
                }, { once: true });
                body.appendChild(row);
                        });
                    }

    document.getElementById("rowCount").innerText = `${tableFilteredEmployees.length} employees`;
    document.getElementById("tablePageInfo").textContent = `Page ${tablePage} of ${totalPages}`;
    document.getElementById("tablePrevPage").disabled = tablePage === 1;
    document.getElementById("tableNextPage").disabled = tablePage === totalPages;
}

function changeTablePage(delta) {
    tablePage += delta;
    renderTablePage();
    document.getElementById("attendanceTableBody")
        .closest("table")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function getInitials(name) {
    return (name || "?")
        .trim()
        .split(/\s+/)
        .map(p => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
}

function sanitize(value) {
    return String(value).replace(/[^a-zA-Z0-9]/g, "_");
}


function editAttendance(emp) {
    if (!canSubmitTimeInRequest()) return;

    selectedEmployee = emp;

    document.getElementById("modalEmployeeId").value = `${emp.emp_id} — ${emp.full_name}`;
    // Shift is taken from the employee's record (same value the table shows)
    const shiftName = (emp.inferred_shift || emp.shift_name || "").toLowerCase().includes("night")
        ? "Night Shift" : "Day Shift";
    document.getElementById("editShift").value = shiftName;
    document.getElementById("editRemarks").value = "";

    // Info box: which date is being edited + what is currently recorded
    document.getElementById("editInfoBox").innerHTML = `
        <div><span>Date</span><strong>${escapeHtml(formatHistoryDate(emp.attendance_date || todayISODate()))}</strong></div>
        <div><span>Shift</span><strong>${shiftName}</strong></div>
        <div><span>Current Time In</span><strong>${emp.time_in ? escapeHtml(emp.time_in) : "None"}</strong></div>
        <div><span>Current Time Out</span><strong>${emp.time_out ? escapeHtml(emp.time_out) : "None"}</strong></div>
    `;

    writeEditPicker("in",  parseTimeToMinutes(emp.time_in));
    writeEditPicker("out", parseTimeToMinutes(emp.time_out));
    refreshEditTimes();

    document.getElementById("editModal").style.display = "flex";
}

// ── Edit modal: friendly time pickers (Hour / Minute / AM-PM) ──────────
const EDIT_PICKERS = {
    in:  { hour: "editTimeInHour",  min: "editTimeInMin",  ampm: "editTimeInAmPm",  hidden: "editTimeIn"  },
    out: { hour: "editTimeOutHour", min: "editTimeOutMin", ampm: "editTimeOutAmPm", hidden: "editTimeOut" },
};

function formatMinutes12(minutes) {
    const h24 = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    const ap = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

function buildEditPickerOptions() {
    const hours = ['<option value="">--</option>'];
    for (let h = 1; h <= 12; h++) hours.push(`<option value="${h}">${h}</option>`);
    const mins = ['<option value="">--</option>'];
    for (let m = 0; m < 60; m++) mins.push(`<option value="${m}">${String(m).padStart(2, "0")}</option>`);

    Object.values(EDIT_PICKERS).forEach(p => {
        document.getElementById(p.hour).innerHTML = hours.join("");
        document.getElementById(p.min).innerHTML = mins.join("");
    });
}

// Returns "HH:MM" (24h) or "" if the picker is blank / incomplete
function readEditPicker(key) {
    const p = EDIT_PICKERS[key];
    const h = document.getElementById(p.hour).value;
    const m = document.getElementById(p.min).value;
    const ap = document.getElementById(p.ampm).value;
    if (h === "" || m === "") return "";

    let hour = parseInt(h, 10);
    if (ap === "PM" && hour !== 12) hour += 12;
    if (ap === "AM" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(parseInt(m, 10)).padStart(2, "0")}`;
}

function writeEditPicker(key, minutes) {
    const p = EDIT_PICKERS[key];
    if (minutes === null || minutes === undefined) {
        document.getElementById(p.hour).value = "";
        document.getElementById(p.min).value = "";
        document.getElementById(p.ampm).value = "AM";
        return;
    }
    const h24 = Math.floor(minutes / 60) % 24;
    document.getElementById(p.hour).value = String(h24 % 12 === 0 ? 12 : h24 % 12);
    document.getElementById(p.min).value = String(minutes % 60);
    document.getElementById(p.ampm).value = h24 >= 12 ? "PM" : "AM";
}

// True when only the hour OR only the minutes was chosen
function editPickerIncomplete() {
    return ["in", "out"].some(key => {
        const p = EDIT_PICKERS[key];
        const h = document.getElementById(p.hour).value;
        const m = document.getElementById(p.min).value;
        return (h === "") !== (m === "");
    });
}

function renderEditPreview(key, minutes, badge) {
    const label = key === "in" ? "Time In" : "Time Out";
    const el = document.getElementById(key === "in" ? "editTimeInPreview" : "editTimeOutPreview");
    const p = EDIT_PICKERS[key];
    const h = document.getElementById(p.hour).value;
    const m = document.getElementById(p.min).value;

    el.className = "edit-preview";
    if ((h === "") !== (m === "")) {
        el.classList.add("is-error");
        el.textContent = "Please choose both the hour and the minutes.";
    } else if (minutes === null) {
        el.classList.add("is-empty");
        el.textContent = `${label}: not set`;
    } else {
        el.innerHTML = `${label}: ${formatMinutes12(minutes)}` +
            (badge ? ` <span class="edit-badge ${badge === "Late" ? "late" : "ok"}">${badge}</span>` : "");
    }
}

// Keeps hidden fields, auto On Time/Late status, previews and fill-buttons in sync
function refreshEditTimes() {
    const isNight = document.getElementById("editShift").value === "Night Shift";
    const inVal  = readEditPicker("in");
    const outVal = readEditPicker("out");

    document.getElementById("editTimeIn").value  = inVal;
    document.getElementById("editTimeOut").value = outVal;

    const inMin  = parseTimeToMinutes(inVal);
    const outMin = parseTimeToMinutes(outVal);

    // Same rule the dashboard uses: Day 7:00 AM / Night 7:00 PM, Late starts at :01
    const cutoff = isNight ? NIGHT_CUTOFF_MINUTES : DAY_CUTOFF_MINUTES;
    const inStatus = inMin === null ? "" : (inMin < cutoff ? "On Time" : "Late");

    document.getElementById("editTimeInStatus").value  = inStatus || "On Time";
    document.getElementById("editTimeOutStatus").value = "On Time";

    renderEditPreview("in",  inMin,  inStatus);
    renderEditPreview("out", outMin, "");

    document.getElementById("editFillIn").textContent =
        `Use ${formatMinutes12(isNight ? NIGHT_SHIFT_START_MINUTES : DAY_SHIFT_START_MINUTES)}`;
    document.getElementById("editFillOut").textContent =
        `Use ${formatMinutes12(isNight ? NIGHT_SHIFT_BASE_END_MINUTES : DAY_SHIFT_BASE_END_MINUTES)}`;
}

function initEditTimePickers() {
    buildEditPickerOptions();

    ["in", "out"].forEach(key => {
        const p = EDIT_PICKERS[key];
        const hourEl = document.getElementById(p.hour);
        const minEl  = document.getElementById(p.min);
        const ampmEl = document.getElementById(p.ampm);

        hourEl.addEventListener("change", () => {
            if (hourEl.value === "") {
                minEl.value = "";
            } else if (minEl.value === "") {
                // First pick: default minutes to :00 and AM/PM to what fits the shift
                const isNight = document.getElementById("editShift").value === "Night Shift";
                minEl.value = "0";
                ampmEl.value = ((key === "in") !== isNight) ? "AM" : "PM";
            }
            refreshEditTimes();
        });
        minEl.addEventListener("change", refreshEditTimes);
        ampmEl.addEventListener("change", refreshEditTimes);
    });

    document.getElementById("editFillIn").addEventListener("click", () => {
        const isNight = document.getElementById("editShift").value === "Night Shift";
        writeEditPicker("in", isNight ? NIGHT_SHIFT_START_MINUTES : DAY_SHIFT_START_MINUTES);
        refreshEditTimes();
    });
    document.getElementById("editFillOut").addEventListener("click", () => {
        const isNight = document.getElementById("editShift").value === "Night Shift";
        writeEditPicker("out", isNight ? NIGHT_SHIFT_BASE_END_MINUTES : DAY_SHIFT_BASE_END_MINUTES);
        refreshEditTimes();
    });
}

function closeModal() {
    document.getElementById("editModal").style.display = "none";
    document.getElementById("editRemarks").value = "";
    selectedEmployee = null;
}

async function saveAttendance() {
    if (!canSubmitTimeInRequest()) return;
    if (!selectedEmployee) return;

    const timeIn         = document.getElementById("editTimeIn").value;
    const timeOut        = document.getElementById("editTimeOut").value;
    const shiftName      = document.getElementById("editShift").value;
    const timeInStatus   = document.getElementById("editTimeInStatus").value;
    const timeOutStatus  = document.getElementById("editTimeOutStatus").value;
    const remarks        = document.getElementById("editRemarks").value.trim();

    if (editPickerIncomplete()) {
        alert("Please choose both the hour and the minutes.");
        return;
    }

    if (!timeIn && !timeOut) {
        alert("Please enter a Time In and/or Time Out value before submitting.");
        return;
    }

    const attendanceDate = selectedEmployee.attendance_date || todayISODate();

    // NOTE (security): emp_id/department/status are echoed here from data
    // already sitting in the browser. This is convenient for display on
    // the approval screens, but the SERVER must re-derive the employee's
    // true department (and re-validate that status transitions are legal,
    // e.g. that this is really moving from "no request" to "Pending First
    // Approval") from emp_id server-side rather than trusting these
    // fields verbatim — a tampered department could otherwise misroute
    // the request to a reviewer the requester controls.
    const payload = {
        emp_id: selectedEmployee.emp_id,
        emp_no: selectedEmployee.emp_no,   
        full_name: selectedEmployee.full_name,   
        position: selectedEmployee.position,     
        department: selectedEmployee.department || "",
        attendance_date: attendanceDate,
        remarks: remarks || null,
        status: "Pending First Approval",
        changes: {
            shift_name: shiftName,
            time_in:  timeIn  ? `${timeIn}:00`  : null,
            time_in_status: timeIn ? timeInStatus : null,
            time_out: timeOut ? `${timeOut}:00` : null,
            time_out_status: timeOut ? timeOutStatus : null,
        },
    };

    const saveBtn = document.getElementById("saveAttendance");
    if (saveBtn.disabled) return; // already submitting — ignore extra clicks/double-fires
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Submitting…";

    try {
        const res = await fetch(TIME_IN_REQUESTS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const result = await res.json();

        if (result.success) {
            alert("Attendance change submitted for approval.");
            closeModal();
            await loadPendingFirstApprovalRequests();
        } else {
            alert(result.message || "Failed to submit request.");
        }
    } catch (err) {
        console.error(err);
        alert("Server error while submitting request.");
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
}

function extractInputTime(value) {
    if (!value) return "";
    const match = String(value).match(/(\d{2}:\d{2})/);
    return match ? match[1] : "";
}
// ---- History modal: cache + fast open ----
const historyCache = new Map();               // emp_id -> { at, records }
const HISTORY_CACHE_TTL = 60 * 1000;          // 60 seconds
let historyAbort = null;

async function fetchEmployeeHistory(empId, signal) {
    const cached = historyCache.get(empId);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL) {
        return cached.records;
    }
    const res = await fetch(`/api/attendance-history/${encodeURIComponent(empId)}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.success === false) {
        throw new Error(data.message || "Failed to load history");
    }
    const records = Array.isArray(data) ? data : (data.records || data.data || []);
    historyCache.set(empId, { at: Date.now(), records });
    return records;
}

async function openHistoryModal(emp) {
    // Cancel any previous in-flight request
    if (historyAbort) historyAbort.abort();
    historyAbort = new AbortController();
    const { signal } = historyAbort;

    historyEmployee = emp;
    historyPage = 1;
    historyRangeValue = "all";
    historyRecordsAll = [];
    historyRecords = [];
    document.getElementById("historyRangeFilter").value = "all";
    document.getElementById("historyExportStart").value = "";
    document.getElementById("historyExportEnd").value = "";

    document.getElementById("historyModalTitle").textContent = `${emp.full_name || emp.emp_id}`;
    document.getElementById("historyModalSubtitle").textContent =
        `Employee ID: ${emp.emp_id}${emp.position ? " · " + emp.position : ""}`;

    // Show the modal IMMEDIATELY with a loading state
    document.getElementById("historyStats").innerHTML = "";
    document.getElementById("historyTableBody").innerHTML =
        `<tr><td colspan="5" style="text-align:center;color:#95a5a6;padding:20px;">Loading attendance history…</td></tr>`;
    document.getElementById("historyPageInfo").textContent = "Loading…";
    document.getElementById("historyPrevPage").disabled = true;
    document.getElementById("historyNextPage").disabled = true;
    document.getElementById("historyModal").style.display = "flex";

    // Then fetch (or read from cache)
    try {
        const records = await fetchEmployeeHistory(emp.emp_id, signal);
        if (historyEmployee !== emp) return;      // modal was closed / another employee opened
        historyRecordsAll = records;
    } catch (err) {
        if (err.name === "AbortError") return;
        console.error(err);
        if (historyEmployee !== emp) return;
        // Show the real failure instead of a misleading
        // "No attendance history found."
        historyRecordsAll = [];
        historyRecords = [];
        document.getElementById("historyTableBody").innerHTML =
            `<tr><td colspan="5" style="text-align:center;color:#c0392b;padding:20px;">Failed to load attendance history (${escapeHtml(err.message || "unknown error")}). Please try again.</td></tr>`;
        document.getElementById("historyPageInfo").textContent = "Error";
        return;
    }

    applyHistoryRangeFilter();
}
function applyHistoryRangeFilter() {
    if (historyRangeValue === "all") {
        historyRecords = historyRecordsAll;
    } else {
        const days = parseInt(historyRangeValue, 10);
        const cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setDate(cutoff.getDate() - (days - 1));

        historyRecords = historyRecordsAll.filter(r => {
            const match = String(r.attendance_date || "").match(/^\d{4}-\d{2}-\d{2}/);
            if (!match) return false;
            // FIX: `new Date("2026-09-02")` parses as UTC midnight, while
            // `cutoff` above is built from local Date components. For any
            // user west of UTC that mismatch can push a record to the
            // wrong side of the "Last 15/30 Days" boundary. Use the same
            // local-time parser (isoToLocalDate) used everywhere else in
            // this file so the comparison is apples-to-apples.
            const recordDate = isoToLocalDate(match[0]);
            return recordDate >= cutoff;
        });
    }

    historyPage = 1;
    renderHistorySummary(computeHistoryStats(historyRecords));
    renderHistoryPage();
}
function closeHistoryModal() {
    if (historyAbort) { historyAbort.abort(); historyAbort = null; }  
    document.getElementById("historyModal").style.display = "none";
    document.getElementById("historyStats").innerHTML = "";
    document.getElementById("historyRangeFilter").value = "all";
    document.getElementById("historyExportStart").value = "";
    document.getElementById("historyExportEnd").value = "";
    historyRecords = [];
    historyRecordsAll = [];
    historyRangeValue = "all";
    historyEmployee = null;
}

function formatHistoryDate(value) {
    if (!value) return "—";
    const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
    if (!match) return value;
    const [year, month, day] = match[0].split("-");
    return `${month}/${day}/${year}`;
}

function renderHistoryPage() {
    const totalPages = Math.max(1, Math.ceil(historyRecords.length / HISTORY_PAGE_SIZE));
    historyPage = Math.min(Math.max(1, historyPage), totalPages);

    const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    const pageRecords = historyRecords.slice(start, start + HISTORY_PAGE_SIZE);

    const body = document.getElementById("historyTableBody");
    body.innerHTML = pageRecords.length === 0
        ? `<tr><td colspan="5" style="text-align:center;color:#95a5a6;padding:20px;">No attendance history found.</td></tr>`
        : pageRecords.map(r => `
            <tr>
                <td class="history-date-cell" data-label="Date">${escapeHtml(formatHistoryDate(r.attendance_date))}</td>
                <td data-label="Shift">${escapeHtml(r.inferred_shift || r.shift_name || "—")}
                    <small style="display:block">Scheduled: ${escapeHtml(r.scheduled_shift || "Unknown")}</small>
                    <small style="display:block">${escapeHtml(r.matching_status || "")}${r.review_reason ? ': ' + escapeHtml(r.review_reason) : ''}</small>${renderPunchEvidence(r)}</td>
                <td data-label="Time In">${escapeHtml(r.time_in || "—")}</td>
                <td data-label="Time Out">${escapeHtml(r.time_out || "—")}</td>
                <td data-label="Status"><span class="employee-status status-${statusClassSuffix(r.status || "")}">${escapeHtml(r.status || "—")}</span></td>
            </tr>
        `).join("");

    document.getElementById("historyPageInfo").textContent = `Page ${historyPage} of ${totalPages}`;
    document.getElementById("historyPrevPage").disabled = historyPage === 1;
    document.getElementById("historyNextPage").disabled = historyPage === totalPages;
}

function changeHistoryPage(delta) {
    historyPage += delta;
    renderHistoryPage();
}

function computeHistoryStats(records) {
    const stats = {
        total: records.length,
        present: 0,
        absences: 0,
        late: 0,
        onLeave: 0,
        noWork: 0,
        missingTimeIn: 0,
        missingTimeOut: 0,
    };

    records.forEach(r => {
        const status = (r.status || "").toLowerCase();
        const hasTimeIn = !!r.time_in;
        const hasTimeOut = !!r.time_out;

        if (status === "on leave") {
            stats.onLeave++;
            return;
        }

        if (status === "no work") {
            stats.noWork++;
            return;
        }

        if (!hasTimeIn && !hasTimeOut) {
            stats.absences++;
            return;
        }

        if (status === "late") {
            stats.late++;
        } else {
            stats.present++;
        }

        if (hasTimeOut && !hasTimeIn) stats.missingTimeIn++;
        if (hasTimeIn && !hasTimeOut) stats.missingTimeOut++;
    });

    return stats;
}
function renderHistorySummary(stats) {
    const el = document.getElementById("historyStats");
    if (!el) return;

    el.innerHTML = `
        <div class="history-stat-card total">
            <span class="stat-label">Total Days</span>
            <span class="stat-value">${stats.total}</span>
        </div>
        <div class="history-stat-card present">
            <span class="stat-label">Present</span>
            <span class="stat-value">${stats.present}</span>
        </div>
        <div class="history-stat-card late">
            <span class="stat-label">Late</span>
            <span class="stat-value">${stats.late}</span>
        </div>
        <div class="history-stat-card absences">
            <span class="stat-label">Absent</span>
            <span class="stat-value">${stats.absences}</span>
        </div>
        <div class="history-stat-card missing-in">
            <span class="stat-label">No Time In</span>
            <span class="stat-value">${stats.missingTimeIn}</span>
        </div>
        <div class="history-stat-card missing-out">
            <span class="stat-label">No Time Out</span>
            <span class="stat-value">${stats.missingTimeOut}</span>
        </div>
    `;
}

// ======================================================
// MISSING PUNCHES REPORT (current shift/date view)
// ======================================================

function getMissingPunchEmployees(employees, dateISO) {
    const refDate = dateISO || document.getElementById("dateFilter").value || todayISODate();

    return (employees || []).filter(emp => {
        const status = (emp.status || "").toLowerCase();
        const hasIn = !!emp.time_in;
        const hasOut = !!emp.time_out;

        const isTrueAbsence = status === "absent" && !hasIn && !hasOut;
        if (MISSING_PUNCH_EXCLUDED_STATUSES.has(status) && (status !== "absent" || isTrueAbsence)) return false;

        if (hasIn && hasOut) return false;

        if (!isPunchDeadlinePassed(refDate, emp.shift_name)) return false;

        return true;
    });
}

function updateMissingPunchesBadge() {
    const selectedDate = document.getElementById("dateFilter").value || todayISODate();
    const count = getMissingPunchEmployees(currentEmployees, selectedDate).length;
    document.getElementById("missingPunchesCount").textContent = count;
}

function openMissingPunchesModal() {
    document.getElementById("missingPunchesModal").style.display = "flex";
    const selectedDate = document.getElementById("dateFilter").value || todayISODate();
    document.getElementById("missingPunchesStartDate").value = selectedDate;
    document.getElementById("missingPunchesEndDate").value = selectedDate;
    refreshMissingPunchesReport();
}

function closeMissingPunchesModal() {
    document.getElementById("missingPunchesModal").style.display = "none";
    // Stop wasting bandwidth on a report the user just closed.
    if (missingPunchesAbortController) {
        missingPunchesAbortController.abort();
        missingPunchesAbortController = null;
    }
}

function getMissingPunchesDateRange() {
    const start = document.getElementById("missingPunchesStartDate").value;
    const end = document.getElementById("missingPunchesEndDate").value;
    if (!start || !end) {
        Swal.fire({ icon: "warning", title: "Select a date range", text: "Please choose both a start and end date." });
        return null;
    }
    if (start > end) {
        Swal.fire({ icon: "warning", title: "Invalid date range", text: "The start date must be on or before the end date." });
        return null;
    }
    const dates = generateDateRangeISO(start, end);
    if (dates.length > MAX_EXPORT_RANGE_DAYS) {
        Swal.fire({ icon: "warning", title: "Range too large", text: `Please choose ${MAX_EXPORT_RANGE_DAYS} days or fewer.` });
        return null;
    }
    return { start, end, dates };
}

// Fetches missing-punch rows for the given date range, enriched with the
// CURRENT employee roster (department/line/shift) rather than whatever
// department/line/shift happens to be sitting on the raw attendance log
// for that date. This is what fixes exports showing a stale/wrong
// "Line / Department" for an employee whose roster assignment has since
// changed (their attendance log entry itself doesn't get retroactively
// updated when the roster changes).
async function fetchMissingPunchesForRange(range, { bypassCache = false, signal, onProgress } = {}) {
    // Roster + on-leave remarks are the same for every date in the range,
    // so fetch them once instead of once per date.
    const { rosterRecords, remarksMap } = await getRosterAndRemarksForMissingPunches({ bypassCache });

    let completed = 0;
    const perDateResults = await Promise.all(range.dates.map(async (dateISO) => {
        const [data, noWorkData] = await Promise.all([
            fetchAttendanceLogsCached(dateISO, { bypassCache, signal }),
            fetch(`${NO_WORK_SOURCE_URL}?date=${encodeURIComponent(dateISO)}`, { credentials: "same-origin", signal })
                .then(res => res.ok ? res.json() : null)
                .catch(() => null),
        ]);
        if (!data.success) throw new Error(data.message || `Unable to load ${dateISO}.`);

        const attendanceEmployees = (data.data || []).filter(emp => isThnEmployee(emp.emp_id));
        const noWorkSet = extractNoWorkSet(noWorkData);

        // No shift filter here — the report covers both shifts.
        // buildExportRowsForDate does the roster merge (roster wins on
        // department/line/shift) and applies the same viewer-visibility
        // rule (canViewDepartment) used by the other exports.
        const mergedRows = buildExportRowsForDate(dateISO, rosterRecords, attendanceEmployees, "", remarksMap, noWorkSet)
            .filter(emp => canViewDepartment(emp.department));

        const rowsForDate = mergedRows.filter(emp => {
            const status = (emp.status || "").toLowerCase();
            const hasTimeIn = !!emp.time_in;
            const hasTimeOut = !!emp.time_out;

            const isTrueAbsence = status === "absent" && !hasTimeIn && !hasTimeOut;
            if (MISSING_PUNCH_EXCLUDED_STATUSES.has(status) && (status !== "absent" || isTrueAbsence)) return false;

            if (hasTimeIn && hasTimeOut) return false;

            if (!isPunchDeadlinePassed(dateISO, emp.shift_name)) return false;

            return true;
        });

        completed++;
        if (onProgress) onProgress(completed, range.dates.length);

        return rowsForDate;
    }));

    return perDateResults.flat();
}

// True when the currently-loaded missingPunchRows already cover the
// exact same date range being asked for, and that data hasn't gone
// stale yet. Lets "Export Excel" reuse whatever the modal already
// fetched (e.g. right after it auto-loaded on open, or after a manual
// Refresh) instead of hitting the network all over again.
function isMissingPunchesRangeFresh(range) {
    return (
        missingPunchesRange.start === range.start &&
        missingPunchesRange.end === range.end &&
        (Date.now() - missingPunchesLoadedAt) < ATTENDANCE_CACHE_TTL_MS
    );
}

function renderMissingPunchesReport() {
    const body = document.getElementById("missingPunchesTableBody");
    const { start, end } = missingPunchesRange;
    document.getElementById("missingPunchesSubtitle").textContent =
        `${formatHistoryDate(start)} to ${formatHistoryDate(end)} · ${missingPunchRows.length} employee${missingPunchRows.length === 1 ? "" : "s"} with an incomplete punch`;

    body.innerHTML = missingPunchRows.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#95a5a6;padding:20px;">No missing punches for this date range.</td></tr>`
        : missingPunchRows.map(emp => `
            <tr>
                <td data-label="Date">${escapeHtml(formatHistoryDate(emp.attendance_date))}</td>
                <td data-label="Employee ID">${escapeHtml(emp.emp_id || "")}</td>
                <td data-label="Employee Name">${escapeHtml(emp.full_name || "")}</td>
                <td data-label="Shift">${escapeHtml(emp.inferred_shift || emp.shift_name || "")}
                    ${emp.scheduled_shift ? `<small style="display:block">Scheduled: ${escapeHtml(emp.scheduled_shift)}</small>` : ""}
                    ${emp.matching_status ? `<small style="display:block" title="${escapeHtml(emp.review_reason || "")}">${escapeHtml(emp.matching_status)}${emp.review_reason ? ': ' + escapeHtml(emp.review_reason) : ''}</small>` : ""}${renderPunchEvidence(emp)}</td>
                <td data-label="Time In">${emp.time_in ? escapeHtml(emp.time_in) : '<span class="punch-missing">Missing</span>'}</td>
                <td data-label="Time Out">${emp.time_out ? escapeHtml(emp.time_out) : '<span class="punch-missing">Missing</span>'}</td>
            </tr>
        `).join("");
}

async function refreshMissingPunchesReport() {
    const range = getMissingPunchesDateRange();
    if (!range) return;

    // Cancel any still-running fetch for a previous range/click so it
    // can't finish later and clobber this newer request's result — and
    // so the browser stops spending bandwidth on a result nobody wants.
    if (missingPunchesAbortController) missingPunchesAbortController.abort();
    const controller = new AbortController();
    missingPunchesAbortController = controller;

    const body = document.getElementById("missingPunchesTableBody");
    const refreshBtn = document.getElementById("refreshMissingPunchesBtn");
    if (refreshBtn) refreshBtn.disabled = true;

    const setLoadingText = (loaded, total) => {
        body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">Loading missing punches${total > 1 ? ` (${loaded} of ${total} days)` : ""}…</td></tr>`;
    };
    setLoadingText(0, range.dates.length);

    try {
        // Refresh always pulls current data (bypassCache) since the whole
        // point of clicking it is to see the latest state.
        missingPunchRows = await fetchMissingPunchesForRange(range, {
            bypassCache: true,
            signal: controller.signal,
            onProgress: (loaded, total) => setLoadingText(loaded, total),
        });
        missingPunchesRange = range;
        missingPunchesLoadedAt = Date.now();
        renderMissingPunchesReport();
    } catch (err) {
        if (err.name === "AbortError") return; // superseded by a newer request — ignore
        console.error(err);
        body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#dc2626;padding:20px;">Unable to load missing punches. Please try again.</td></tr>`;
    } finally {
        if (refreshBtn) refreshBtn.disabled = false;
        if (missingPunchesAbortController === controller) missingPunchesAbortController = null;
    }
}

function getDowLabel(dateISO) {
    // Reuses the same local-date parsing already used elsewhere
    // (isoToLocalDate) so this lines up with formatHistoryDate.
    const d = isoToLocalDate(dateISO);
    return d.toLocaleDateString("en-US", { weekday: "short" }); // Mon, Tue, Wed...
}
function formatShiftLabel(shiftName) {
    const normalized = normalizeShiftLabel(shiftName);
    if (normalized === "day") return "Day Shift";
    if (normalized === "night") return "Night Shift";
    return shiftName || "—"; // fallback kung hindi ma-detect
}

// Excel/CSV formula-injection guard: if a cell value starts with a
// formula-trigger character (=, +, -, @, or a tab/CR), Excel/Sheets can
// interpret it as a live formula when the file is opened (e.g. a
// "remarks" or "name" field containing `=HYPERLINK("http://evil",...)`
// or `=cmd|'/c calc'!A0`). Prefixing a leading apostrophe forces the
// cell to be read as plain text, neutralizing the payload while keeping
// the visible content unchanged.
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);
function sanitizeForExcel(value) {
    if (value === null || value === undefined) return value;
    const str = String(value);
    if (str.length === 0) return str;
    if (FORMULA_TRIGGER_CHARS.has(str[0])) {
        return `'${str}`;
    }
    return str;
}

// Runs sanitizeForExcel over every string value in a plain row object —
// used right before handing rows to XLSX.utils.json_to_sheet so every
// export (missing punches, attendance, date-range, history) gets the
// same protection without repeating this at each call site.
function sanitizeRowsForExcel(rows) {
    return rows.map(row => {
        const clean = {};
        for (const key of Object.keys(row)) {
            const val = row[key];
            clean[key] = typeof val === "string" ? sanitizeForExcel(val) : val;
        }
        return clean;
    });
}

async function exportMissingPunchesToExcel() {
    if (typeof XLSX === "undefined") {
        Swal.fire({ icon: "error", title: "Export unavailable", text: "Excel export library failed to load." });
        return;
    }
    const range = getMissingPunchesDateRange();
    if (!range) return;

    const btn = document.getElementById("exportMissingPunchesBtn");
    if (btn) {
        if (btn.disabled) return; // already exporting — ignore duplicate clicks
        btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = "Preparing…";
    }

    // If the modal already has fresh rows for this exact range (e.g. it
    // just auto-loaded on open, or the user hit Refresh a moment ago),
    // reuse them and skip the network entirely — the export starts
    // immediately instead of re-fetching data we already have.
    if (!isMissingPunchesRangeFresh(range)) {
        // Cancel any in-flight refresh so it doesn't race with this fetch.
        if (missingPunchesAbortController) missingPunchesAbortController.abort();
        const controller = new AbortController();
        missingPunchesAbortController = controller;

        try {
            missingPunchRows = await fetchMissingPunchesForRange(range, {
                bypassCache: false, // OK to reuse anything the cache already has
                signal: controller.signal,
                onProgress: (loaded, total) => {
                    if (btn && total > 1) btn.textContent = `Preparing… (${loaded}/${total})`;
                },
            });
            missingPunchesRange = range;
            missingPunchesLoadedAt = Date.now();
        } catch (err) {
            console.error(err);
            Swal.fire({ icon: "error", title: "Export failed", text: "Unable to load the missing-punch report." });
            if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || "Export Excel"; }
            return;
        } finally {
            if (missingPunchesAbortController === controller) missingPunchesAbortController = null;
        }
    }

    if (!missingPunchRows.length) {
        Swal.fire({ icon: "info", title: "Nothing to export", text: "No missing punches were found for this date range." });
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || "Export Excel"; }
        return;
    }

    try {
        // Sort by Line/Department first (so every row for the same line
        // sits together instead of being interleaved), then by name within
        // each line, so the exported sheet reads as grouped, not shuffled.
        const sortedRows = [...missingPunchRows].sort((a, b) => {
            const lineA = (a.line_name || a.department || "Unassigned").toString();
            const lineB = (b.line_name || b.department || "Unassigned").toString();
            const lineCompare = lineA.localeCompare(lineB);
            if (lineCompare !== 0) return lineCompare;
            return (a.full_name || "").localeCompare(b.full_name || "");
        });

    const rows = sortedRows.map(emp => {
        const hasIn = !!emp.time_in;
        const hasOut = !!emp.time_out;
        let punchType = "Missing In & Out";
        if (hasIn && !hasOut) punchType = "Missing Out";
        if (!hasIn && hasOut) punchType = "Missing In";

        return {
            "Employee ID": emp.emp_id || "",
            "Employee Name": emp.full_name || "",
            "Line / Department": emp.line_name || emp.department || "Unassigned",
            "Shift": formatShiftLabel(emp.shift_name),
            "Date": formatHistoryDate(emp.attendance_date),
            "Time In": emp.time_in || "",   // blank = missing swipe in
            "Time Out": emp.time_out || "", // blank = missing swipe out
            "Missing Punch Type": punchType,
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(sanitizeRowsForExcel(rows));
    worksheet["!cols"] = [
        { wch: 12 }, // Employee ID
        { wch: 26 }, // Employee Name
        { wch: 24 }, // Line / Department
        { wch: 12 }, // Shift
        { wch: 12 }, // Date
        { wch: 10 }, // Time In
        { wch: 10 }, // Time Out
        { wch: 16 }, // Missing Punch Type
    ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Missing Punches");
        // Trigger the download FIRST — the table re-render below is only
        // cosmetic (keeping the on-screen list in sync) and shouldn't
        // delay the file the user is actually waiting for.
        XLSX.writeFile(workbook, `Missing_Punches_${range.start}_to_${range.end}.xlsx`);
        renderMissingPunchesReport();
    } catch (err) {
        console.error("Excel download failed:", err);
        Swal.fire({
            icon: "error",
            title: "Download blocked",
            text: "Your browser blocked this file download. If this keeps happening, try accessing the dashboard over HTTPS or use a different browser.",
        });
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || "Export Excel"; }
    }
}

async function loadPendingFirstApprovalRequests() {
    // HR approvers no longer see or act on Pending First Approval.
    if (isHrApprover()) {
        pendingFirstApprovalRequests = [];
        return;
    }

    try {
        const res = await fetch(`${TIME_IN_REQUESTS_URL}?status=${encodeURIComponent("Pending First Approval")}`, {
            credentials: "same-origin",
        });
        const data = await res.json();
        const allRequests = Array.isArray(data) ? data : (data.requests || data.request || data.data || []);
        pendingFirstApprovalRequests = allRequests.filter(req => canViewApprovalRequest(req.department));
    } catch (err) {
        console.error(err);
        pendingFirstApprovalRequests = [];
    }

    document.getElementById("firstApprovalCount").textContent = pendingFirstApprovalRequests.length;

    const newFirstApprovalCount = pendingFirstApprovalRequests.length;
    notifyPendingApprovalChange("first", newFirstApprovalCount, lastNotifiedFirstApprovalCount);
    lastNotifiedFirstApprovalCount = newFirstApprovalCount;

    if (document.getElementById("firstApprovalModal").style.display === "flex") {
        renderFirstApprovalTable();
    }
}

function openFirstApprovalModal() {
    if (isHrApprover()) return;
    document.getElementById("firstApprovalModal").style.display = "flex";
    loadPendingFirstApprovalRequests().then(renderFirstApprovalTable);
    renderFirstApprovalTable();
}

function closeFirstApprovalModal() {
    document.getElementById("firstApprovalModal").style.display = "none";
}

function getPersonDisplayName(req, prefix) {
    const fullNameField = req[`${prefix}_full_name`] || req[`${prefix}_name`];
    if (fullNameField) return fullNameField;

    const first = req[`${prefix}_first_name`];
    const last = req[`${prefix}_last_name`];
    const combined = [first, last].filter(Boolean).join(" ").trim();
    if (combined) return combined;

    return req[prefix] || "";
}

// Resolves the production line for a request. Uses the line on the request
// if the API sends one, otherwise falls back to the employee roster.
function getRequestLine(req) {
    const direct = req.line_name || req.line || "";
    if (direct) return escapeHtml(direct);

    const match = currentEmployees.find(e => String(e.emp_id) === String(req.emp_id));
    const fromRoster = match ? (match.line_name || match.line || "") : "";
    return fromRoster
        ? escapeHtml(fromRoster)
        : `<span style="color:var(--text-muted);">—</span>`;
}

function renderFirstApprovalTable() {
    const subtitle = document.getElementById("firstApprovalSubtitle");
    subtitle.textContent = `${pendingFirstApprovalRequests.length} request${pendingFirstApprovalRequests.length === 1 ? "" : "s"} awaiting first approval`;

    const body = document.getElementById("firstApprovalTableBody");

    if (pendingFirstApprovalRequests.length === 0) {
        body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#95a5a6;padding:20px;">No requests awaiting first approval.</td></tr>`;
        return;
    }

    const viewer = !canReviewRequests();

    body.innerHTML = pendingFirstApprovalRequests.map(req => {
        const id = req.id ?? req.request_id;
        const empLabel = `${escapeHtml(req.emp_id || "")} — ${escapeHtml(req.full_name || "")}`;
        const department = req.department ? escapeHtml(req.department) : "<span style=\"color:var(--text-muted);\">—</span>";
        const line = getRequestLine(req);
        const changesSummary = formatRequestedChanges(req);
        const requesterName = getPersonDisplayName(req, "requested_by");
        const requester = requesterName ? escapeHtml(requesterName) : "—";
        const dateLabel = escapeHtml(formatHistoryDate(req.attendance_date));
        const remarks = req.remarks ? escapeHtml(req.remarks) : "<span style=\"color:var(--text-muted);\">—</span>";
        const actions = viewer
            ? `<span style="color:var(--text-muted);font-size:12px;">View only</span>`
            : `<div class="request-actions-cell">
                <button type="button" class="request-action-btn request-approve-btn" data-id="${escapeHtml(id)}">Approve</button>
                <button type="button" class="request-action-btn request-decline-btn" data-id="${escapeHtml(id)}">Decline</button>
            </div>`;

        return `
            <tr>
                <td data-label="Employee">${empLabel}</td>
                <td data-label="Department">${department}</td>
                <td data-label="Line">${line}</td>
                <td data-label="Requested Changes">${changesSummary}</td>
                <td data-label="Requester">${requester}</td>
                <td data-label="Date">${dateLabel}</td>
                <td data-label="Remarks">${remarks}</td>
                <td class="cell-actions" data-label="Action">${actions}</td>
            </tr>
        `;
    }).join("");

    if (!viewer) {
        body.querySelectorAll(".request-approve-btn").forEach(btn => {
            btn.addEventListener("click", () => firstApproveTimeInRequest(btn.dataset.id, btn));
        });
        body.querySelectorAll(".request-decline-btn").forEach(btn => {
            btn.addEventListener("click", () => declineTimeInRequest(btn.dataset.id, "first", btn));
        });
    }
}

async function firstApproveTimeInRequest(requestId, triggerBtn) {
    if (!requestId) return;
    if (isHrApprover()) return;
    if (!confirm("Approve this request? It will move on to HR for final approval.")) return;

    // Disable both action buttons on this row while the request is
    // in-flight so a double-click can't fire two approve/decline calls
    // for the same request id.
    const row = triggerBtn ? triggerBtn.closest("tr") : null;
    const rowButtons = row ? row.querySelectorAll("button") : [];
    rowButtons.forEach(b => b.disabled = true);

    try {
        const res = await fetch(`${TIME_IN_REQUESTS_URL}/${encodeURIComponent(requestId)}/first-approve`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const result = await res.json();

        if (result.success) {
            await loadPendingFirstApprovalRequests();
            renderFirstApprovalTable();
            if (isHrApprover()) {
                await loadPendingTimeInRequests();
            }
        } else {
            alert(result.message || "Failed to approve request.");
            rowButtons.forEach(b => b.disabled = false);
        }
    } catch (err) {
        console.error(err);
        alert("Server error while approving request.");
        rowButtons.forEach(b => b.disabled = false);
    }
}

function handlePendingRequestsClick() {
    if (!isHrApprover()) {
        Swal.fire({
            icon: "error",
            title: "Access Restricted",
            text: "Only Administration/HR accounts can view final Time-In approvals.",
        });
        return;
    }

    openPendingRequestsModal();
}
async function loadPendingTimeInRequests() {
    if (!isHrApprover()) {
        pendingTimeInRequests = [];
        updatePendingRequestsBadge();
        return;
    }

    try {
        const res = await fetch(`${TIME_IN_REQUESTS_URL}?status=${encodeURIComponent("Pending HR Approval")}`, {
            credentials: "same-origin",
        });
        const data = await res.json();
        const allRequests = Array.isArray(data) ? data : (data.requests || data.request || data.data || []);
        pendingTimeInRequests = allRequests.filter(req => canViewDepartment(req.department));
    } catch (err) {
        console.error(err);
        pendingTimeInRequests = [];
    }

    const newHrApprovalCount = pendingTimeInRequests.length;
    notifyPendingApprovalChange("hr", newHrApprovalCount, lastNotifiedHrApprovalCount);
    lastNotifiedHrApprovalCount = newHrApprovalCount;

    updatePendingRequestsBadge();

    if (document.getElementById("pendingRequestsModal").style.display === "flex") {
        renderPendingRequestsTable();
    }
}

function updatePendingRequestsBadge() {
    document.getElementById("pendingRequestsCount").textContent = pendingTimeInRequests.length;
}

function openPendingRequestsModal() {
    document.getElementById("pendingRequestsModal").style.display = "flex";
    loadPendingTimeInRequests().then(renderPendingRequestsTable);
    renderPendingRequestsTable();
}

function closePendingRequestsModal() {
    document.getElementById("pendingRequestsModal").style.display = "none";
}
function renderPendingRequestsTable() {
    const subtitle = document.getElementById("pendingRequestsSubtitle");
    subtitle.textContent = `${pendingTimeInRequests.length} request${pendingTimeInRequests.length === 1 ? "" : "s"} awaiting final HR approval`;

    const body = document.getElementById("pendingRequestsTableBody");

    // Alisin sa selection yung mga wala na sa listahan (na-approve/decline na ng iba)
    const currentIds = new Set(pendingTimeInRequests.map(r => String(r.id ?? r.request_id)));
    [...selectedHrRequestIds].forEach(id => {
        if (!currentIds.has(id)) selectedHrRequestIds.delete(id);
    });

    if (pendingTimeInRequests.length === 0) {
        body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#95a5a6;padding:20px;">No pending Time-In requests.</td></tr>`;
        updateHrBulkBar();
        return;
    }

    const canAct = canActOnHrApproval();

    body.innerHTML = pendingTimeInRequests.map(req => {
        const id = req.id ?? req.request_id;
        const isChecked = selectedHrRequestIds.has(String(id)) ? "checked" : "";
        const empText = `${escapeHtml(req.emp_id || "")} — ${escapeHtml(req.full_name || "")}`;
        const empLabel = canAct
            ? `<label class="hr-row-check"><input type="checkbox" class="hr-row-checkbox" data-id="${escapeHtml(id)}" ${isChecked}><span>${empText}</span></label>`
            : empText;
        const department = req.department ? escapeHtml(req.department) : "<span style=\"color:var(--text-muted);\">—</span>";
        const line = getRequestLine(req);
        const changesSummary = formatRequestedChanges(req);
        const requestedByName = getPersonDisplayName(req, "requested_by");
        const requestedBy = requestedByName ? escapeHtml(requestedByName) : "—";
        const firstApprovedByName = getPersonDisplayName(req, "first_approved_by");
        const firstApprovedBy = firstApprovedByName
            ? escapeHtml(firstApprovedByName)
            : `<span style="color:var(--text-muted);">—</span>`;
        const dateLabel = escapeHtml(formatHistoryDate(req.attendance_date));
        const remarks = req.remarks ? escapeHtml(req.remarks) : "<span style=\"color:var(--text-muted);\">—</span>";
        const actions = canAct
            ? `<div class="request-actions-cell">
                   <button type="button" class="request-action-btn request-approve-btn" data-id="${escapeHtml(id)}">Approve</button>
                   <button type="button" class="request-action-btn request-decline-btn" data-id="${escapeHtml(id)}">Decline</button>
               </div>`
            : `<span style="color:var(--text-muted);font-size:12px;">View only</span>`;

        return `
            <tr>
                <td data-label="Employee">${empLabel}</td>
                <td data-label="Department">${department}</td>
                <td data-label="Line">${line}</td>
                <td data-label="Requested Changes">${changesSummary}</td>
                <td data-label="Requested By">${requestedBy}</td>
                <td data-label="First Approved By">${firstApprovedBy}</td>
                <td data-label="Date">${dateLabel}</td>
                <td data-label="Remarks">${remarks}</td>
                <td class="cell-actions" data-label="Action">${actions}</td>
            </tr>
        `;
    }).join("");

    if (canAct) {
        body.querySelectorAll(".hr-row-checkbox").forEach(cb => {
            cb.addEventListener("change", () => {
                if (cb.checked) selectedHrRequestIds.add(String(cb.dataset.id));
                else selectedHrRequestIds.delete(String(cb.dataset.id));
                updateHrBulkBar();
            });
        });
        body.querySelectorAll(".request-approve-btn").forEach(btn => {
            btn.addEventListener("click", () => approveTimeInRequest(btn.dataset.id, btn));
        });
        body.querySelectorAll(".request-decline-btn").forEach(btn => {
            btn.addEventListener("click", () => declineTimeInRequest(btn.dataset.id, "hr", btn));
        });
    }

    updateHrBulkBar();
}

function formatRequestedChanges(req) {
    const changes = req.changes || {};
    const parts = [];

    if (changes.shift_name) {
        parts.push(`Shift: ${escapeHtml(changes.shift_name)}`);
    }
    if (changes.time_in) {
        const status = changes.time_in_status ? ` (${escapeHtml(changes.time_in_status)})` : "";
        parts.push(`Time In: ${escapeHtml(formatDisplayTime(changes.time_in))}${status}`);
    }
    if (changes.time_out) {
        const status = changes.time_out_status ? ` (${escapeHtml(changes.time_out_status)})` : "";
        parts.push(`Time Out: ${escapeHtml(formatDisplayTime(changes.time_out))}${status}`);
    }

    return parts.length ? parts.join("<br>") : "—";
}

function formatDisplayTime(value) {
    if (!value) return "";
    const match = String(value).match(/^(\d{2}):(\d{2})/);
    if (!match) return value;
    let hour = parseInt(match[1], 10);
    const minute = match[2];
    const period = hour >= 12 ? "PM" : "AM";
    if (hour === 0) hour = 12;
    else if (hour > 12) hour -= 12;
    return `${hour}:${minute} ${period}`;
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

async function postNotification(payload) {
    if (!payload || !payload.recipientId) {
        console.error("postNotification: missing recipientId, skipping notification.", payload);
        return false;
    }

    try {
        const res = await fetch(NOTIFICATIONS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            console.error(`Failed to create notification: server responded ${res.status}`);
            return false;
        }
        const result = await res.json();
        if (!result.success) {
            console.error("Failed to create notification:", result.message || result);
            return false;
        }
        return true;
    } catch (err) {
        console.error("Server error while creating notification:", err);
        return false;
    }
}

async function approveTimeInRequest(requestId, triggerBtn) {
    if (!canActOnHrApproval()) return;
    if (!requestId) return;

    const confirmResult = await Swal.fire({
        icon: "question",
        title: "Approve this request?",
        text: "This is the final approval and will update the employee's attendance record.",
        showCancelButton: true,
        confirmButtonText: "Yes, approve",
        cancelButtonText: "Cancel",
        confirmButtonColor: "#16a34a",
        reverseButtons: true,
    });

    if (!confirmResult.isConfirmed) return;

    const req = pendingTimeInRequests.find(r => String(r.id ?? r.request_id) === String(requestId));

    // Disable this row's buttons immediately so a repeat click while the
    // confirmation/approval round-trip is in flight can't double-submit.
    const row = triggerBtn ? triggerBtn.closest("tr") : null;
    const rowButtons = row ? row.querySelectorAll("button") : [];
    rowButtons.forEach(b => b.disabled = true);

    Swal.fire({
        title: "Approving...",
        allowOutsideClick: false,
        allowEscapeKey: false,
        didOpen: () => Swal.showLoading(),
    });

    try {
        const res = await fetch(`${TIME_IN_REQUESTS_URL}/${encodeURIComponent(requestId)}/approve`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const result = await res.json();

        if (result.success) {
            Swal.fire({
                icon: "success",
                title: "Time-In Approved",
                html: `<strong>${escapeHtml(req?.full_name || "Employee")}</strong><br>${escapeHtml(req?.position || "")}`,
                timer: 1200,
                showConfirmButton: false,
            });

            // Alisin agad sa listahan, hindi na naghihintay ng reload
            pendingTimeInRequests = pendingTimeInRequests.filter(
                r => String(r.id ?? r.request_id) !== String(requestId)
            );
            updatePendingRequestsBadge();
            renderPendingRequestsTable();

            // Background na lang, hindi na hinihintay
            notifyRequesterOfApproval(req, requestId).catch(err => console.error(err));
            setTimeout(() => loadData(), 500);
        } else {
            Swal.fire({
                icon: "error",
                title: "Failed to approve request",
                text: result.message || "Please try again.",
            });
            rowButtons.forEach(b => b.disabled = false);
        }
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: "error",
            title: "Server error",
            text: "Something went wrong while approving the request.",
        });
        rowButtons.forEach(b => b.disabled = false);
    }
}
async function notifyRequesterOfApproval(req, requestId) {
    const requesterId = req?.requested_by || req?.requester_id || req?.requested_by_id || null;
    if (!requesterId) {
        console.error("notifyRequesterOfApproval: missing requesterId on request", requestId, "— skipping requester notification.");
        return false;
    }

    const changes = req?.changes || {};
    const dateLabel = formatHistoryDate(req?.attendance_date);

    const changeParts = [];
    if (changes.time_in) changeParts.push(`time-in to ${formatDisplayTime(changes.time_in)}`);
    if (changes.time_out) changeParts.push(`time-out to ${formatDisplayTime(changes.time_out)}`);
    const changeDescription = changeParts.length ? changeParts.join(" and ") : "attendance";

    return postNotification({
        recipientId: requesterId,
        type: "TIME_IN_APPROVED",
        title: "Time-in Request Approved",
        body: `Your request to update your ${changeDescription} for ${dateLabel} has been approved by HR.`,
        requestId: req?.id ?? req?.request_id ?? requestId,
        timestamp: new Date().toISOString(),
        isRead: false,
    });
}

// ======================================================
// REQUESTER-FACING NOTIFICATIONS (e.g. TIME_IN_APPROVED)
// ======================================================

async function loadMyNotifications() {
    if (!currentUser.username) {
        myNotifications = [];
        updateNotificationsBadge();
        return;
    }

    try {
        const res = await fetch(
            `${NOTIFICATIONS_URL}?recipientId=${encodeURIComponent(currentUser.username)}&isRead=false`,
            { credentials: "same-origin" }
        );
        if (!res.ok) {
            myNotifications = [];
            updateNotificationsBadge();
            return;
        }
        const data = await res.json();
        myNotifications = Array.isArray(data) ? data : (data.notifications || data.data || []);
    } catch (err) {
        console.error(err);
        myNotifications = [];
    }

    const newCount = myNotifications.length;
    notifyNewNotifications(newCount, lastNotifiedMyNotificationsCount);
    lastNotifiedMyNotificationsCount = newCount;

    updateNotificationsBadge();

    if (document.getElementById("notificationsModal").style.display === "flex") {
        renderNotificationsList();
    }
}

function notifyNewNotifications(newCount, prevCount) {
    if (typeof Swal === "undefined") return;
    if (newCount <= prevCount) return;
    if (newCount === 0) return;

    const delta = newCount - prevCount;
    const title = prevCount === 0
        ? `${newCount} new notification${newCount === 1 ? "" : "s"}`
        : `${delta} new notification${delta === 1 ? "" : "s"}`;

    const NotificationToast = Swal.mixin({
        toast: true,
        position: "top-end",
        showConfirmButton: false,
        timer: 7000,
        timerProgressBar: true,
        didOpen: (toastEl) => {
            toastEl.addEventListener("mouseenter", Swal.stopTimer);
            toastEl.addEventListener("mouseleave", Swal.resumeTimer);
            toastEl.style.cursor = "pointer";
            toastEl.addEventListener("click", () => {
                Swal.close();
                openNotificationsModal();
            });
        },
    });

    NotificationToast.fire({
        icon: "success",
        title,
        text: "Click to review",
    });
}

function updateNotificationsBadge() {
    document.getElementById("notificationsCount").textContent = myNotifications.length;
}

function openNotificationsModal() {
    document.getElementById("notificationsModal").style.display = "flex";
    loadMyNotifications().then(renderNotificationsList);
    renderNotificationsList();
}

function closeNotificationsModal() {
    document.getElementById("notificationsModal").style.display = "none";
}

function notificationIcon(type) {
    switch (type) {
        case "TIME_IN_APPROVED":
            return "✅";
        default:
            return "🔔";
    }
}

function formatNotificationTimestamp(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
}

function renderNotificationsList() {
    const subtitle = document.getElementById("notificationsSubtitle");
    if (subtitle) {
        subtitle.textContent = myNotifications.length === 0
            ? "You're all caught up"
            : `${myNotifications.length} unread notification${myNotifications.length === 1 ? "" : "s"}`;
    }

    const body = document.getElementById("notificationsListBody");

    if (myNotifications.length === 0) {
        body.innerHTML = `
            <div class="table-empty-state">
                <div class="empty-icon">🔔</div>
                <div class="empty-title">No new notifications</div>
                <div>You'll see updates here when HR reviews your requests.</div>
            </div>
        `;
        return;
    }

    body.innerHTML = myNotifications.map(n => {
        const id = n.id ?? n.notification_id ?? "";
        const unreadClass = n.isRead ? "" : " notification-unread";
        return `
            <div class="notification-item${unreadClass}" data-id="${escapeHtml(id)}">
                <span class="notification-icon">${notificationIcon(n.type)}</span>
                <div class="notification-content">
                    <div class="notification-title">${escapeHtml(n.title || "")}</div>
                    <div class="notification-body">${escapeHtml(n.body || "")}</div>
                    <div class="notification-timestamp">${escapeHtml(formatNotificationTimestamp(n.timestamp))}</div>
                </div>
            </div>
        `;
    }).join("");

    body.querySelectorAll(".notification-item").forEach(el => {
        el.addEventListener("click", () => markNotificationRead(el.dataset.id));
    });
}

async function markNotificationRead(notificationId) {
    if (!notificationId) return;

    try {
        const res = await fetch(`${NOTIFICATIONS_URL}/${encodeURIComponent(notificationId)}/read`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        if (!res.ok) {
            console.error(`Failed to mark notification as read: server responded ${res.status}`);
            return;
        }
        const result = await res.json();

        if (result.success) {
            await loadMyNotifications();
        } else {
            console.error("Failed to mark notification as read:", result.message || result);
        }
    } catch (err) {
        console.error("Server error while marking notification as read:", err);
    }
}

async function declineTimeInRequest(requestId, stage, triggerBtn) {
    if (stage === "hr" && !canActOnHrApproval()) return;
    if (!requestId) return;
    if (!confirm("Decline this Time-In request? The original attendance record will remain unchanged.")) return;

    const row = triggerBtn ? triggerBtn.closest("tr") : null;
    const rowButtons = row ? row.querySelectorAll("button") : [];
    rowButtons.forEach(b => b.disabled = true);

    try {
        const res = await fetch(`${TIME_IN_REQUESTS_URL}/${encodeURIComponent(requestId)}/decline`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const result = await res.json();

        if (result.success) {
            if (stage === "hr") {
                await loadPendingTimeInRequests();
                renderPendingRequestsTable();
            } else {
                await loadPendingFirstApprovalRequests();
                renderFirstApprovalTable();
            }
        } else {
            alert(result.message || "Failed to decline request.");
            rowButtons.forEach(b => b.disabled = false);
        }
    } catch (err) {
        console.error(err);
        alert("Server error while declining request.");
        rowButtons.forEach(b => b.disabled = false);
    }
}
document.addEventListener("DOMContentLoaded", () => {
    const exportBtn = document.getElementById("exportExcelBtn");
    if (exportBtn) exportBtn.addEventListener("click", exportAttendanceToExcel);

    const exportRangeBtn = document.getElementById("exportRangeBtn");
    if (exportRangeBtn) exportRangeBtn.addEventListener("click", exportAttendanceRangeToExcel);

    const historyExportRangeBtn = document.getElementById("historyExportRangeBtn");
    if (historyExportRangeBtn) historyExportRangeBtn.addEventListener("click", exportHistoryRangeToExcel);
});

function exportAttendanceToExcel() {
    if (typeof XLSX === "undefined") {
        Swal.fire({ icon: "error", title: "Export unavailable", text: "Excel export library failed to load." });
        return;
    }

    const exportStatus = document.getElementById("exportStatusFilter").value;
    const selectedDate = document.getElementById("dateFilter").value || todayISODate();
    const shift = document.getElementById("shiftFilter").value;

    const filtered = currentEmployees.filter(emp => !exportStatus || emp.status === exportStatus);

    if (filtered.length === 0) {
        Swal.fire({
            icon: "info",
            title: "Nothing to export",
            text: exportStatus
                ? `No employees with status "${exportStatus}" on ${selectedDate}.`
                : `No employees found for ${selectedDate}.`,
        });
        return;
    }

    try {
        const rows = filtered.map(emp => ({
            "Employee Number": emp.emp_no || emp.emp_id || "",
            "Employee Name": emp.full_name || "",
            "Position": emp.position || "Unassigned",
            "Line/Shift": emp.shift_name || "",
            "Status": emp.status || "",
            "Time In": emp.time_in || "",
            "Time Out": emp.time_out || "",
        }));

        const worksheet = XLSX.utils.json_to_sheet(sanitizeRowsForExcel(rows));

        worksheet["!cols"] = [
            { wch: 16 },
            { wch: 26 },
            { wch: 20 },
            { wch: 14 },
            { wch: 12 },
            { wch: 10 },
            { wch: 10 },
        ];

        const workbook = XLSX.utils.book_new();
        const sheetName = exportStatus ? exportStatus.substring(0, 28) : "All Employees";
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

        const statusLabel = exportStatus ? exportStatus.replace(/\s+/g, "_") : "All";
        const shiftLabel = (shift || "Shift").replace(/\s+/g, "_");
        const filename = `Attendance_${statusLabel}_${shiftLabel}_${selectedDate}.xlsx`;

        XLSX.writeFile(workbook, filename);
    } catch (err) {
        console.error("Excel download failed:", err);
        Swal.fire({
            icon: "error",
            title: "Download blocked",
            text: "Your browser blocked this file download. If this keeps happening, try accessing the dashboard over HTTPS or use a different browser.",
        });
    }
}

// ======================================================
// DATE-RANGE EXPORT (e.g. "August 1 to August 17")
// ======================================================
async function exportAttendanceRangeToExcel() {
    if (typeof XLSX === "undefined") {
        Swal.fire({ icon: "error", title: "Export unavailable", text: "Excel export library failed to load." });
        return;
    }

    const startInput = document.getElementById("rangeStartDate");
    const endInput = document.getElementById("rangeEndDate");
    const startISO = startInput.value;
    const endISO = endInput.value;
    const shift = document.getElementById("shiftFilter").value;
    const exportStatus = document.getElementById("exportStatusFilter").value;

    if (!startISO || !endISO) {
        Swal.fire({ icon: "warning", title: "Select a date range", text: "Please choose both a start and end date." });
        return;
    }
    if (startISO > endISO) {
        Swal.fire({ icon: "warning", title: "Invalid date range", text: "The start date must be on or before the end date." });
        return;
    }

    const dateList = generateDateRangeISO(startISO, endISO);
    if (dateList.length > MAX_EXPORT_RANGE_DAYS) {
        Swal.fire({
            icon: "warning",
            title: "Range too large",
            text: `Please choose a range of ${MAX_EXPORT_RANGE_DAYS} days or fewer (you selected ${dateList.length}).`,
        });
        return;
    }

    Swal.fire({
        title: "Preparing export…",
        html: `Fetching ${formatHistoryDate(dateList[0])} (1 of ${dateList.length})…`,
        allowOutsideClick: false,
        allowEscapeKey: false,
        didOpen: () => Swal.showLoading(),
    });

    try {
        const [rosterData, onLeaveData] = await Promise.all([
            fetch("/api/employee-groupings", { credentials: "same-origin" })
                .then(res => res.ok ? res.json() : null)
                .catch(() => null),
            fetch(ON_LEAVE_SOURCE_URL, { credentials: "same-origin" })
                .then(res => res.ok ? res.json() : null)
                .catch(() => null),
        ]);

        const rosterRecords = rosterData
            ? (Array.isArray(rosterData) ? rosterData : (rosterData.employees || rosterData.data || []))
            : [];
        const remarksMap = extractRemarksMap(onLeaveData);

        const allRows = [];

        for (let i = 0; i < dateList.length; i++) {
            const dateISO = dateList[i];
            Swal.update({ html: `Fetching ${formatHistoryDate(dateISO)} (${i + 1} of ${dateList.length})…` });

            const [logData, noWorkData] = await Promise.all([
                fetch(`${ATTENDANCE_LOGS_URL}?date=${encodeURIComponent(dateISO)}`, { credentials: "same-origin" })
                    .then(res => res.json())
                    .catch(() => ({ success: false, data: [] })),
                fetch(`${NO_WORK_SOURCE_URL}?date=${encodeURIComponent(dateISO)}`, { credentials: "same-origin" })
                    .then(res => res.ok ? res.json() : null)
                    .catch(() => null),
            ]);

            const attendanceEmployees = (logData && logData.success ? (logData.data || []) : [])
                .filter(emp => isThnEmployee(emp.emp_id));
            const noWorkSet = extractNoWorkSet(noWorkData);

            const dayRows = buildExportRowsForDate(dateISO, rosterRecords, attendanceEmployees, shift, remarksMap, noWorkSet)
                .filter(emp => canViewDepartment(emp.department))
                .filter(emp => !exportStatus || emp.status === exportStatus);

            dayRows.forEach(emp => {
                allRows.push({
                    "Date": formatHistoryDate(dateISO),
                    "Employee Number": emp.emp_no || emp.emp_id || "",
                    "Employee Name": emp.full_name || "",
                    "Position": emp.position || "Unassigned",
                    "Line/Shift": emp.shift_name || "",
                    "Status": emp.status || "",
                    "Time In": emp.time_in || "",
                    "Time Out": emp.time_out || "",
                });
            });
        }

        Swal.close();

        if (allRows.length === 0) {
            Swal.fire({
                icon: "info",
                title: "Nothing to export",
                text: `No attendance records found from ${formatHistoryDate(startISO)} to ${formatHistoryDate(endISO)}.`,
            });
            return;
        }

        try {
            const worksheet = XLSX.utils.json_to_sheet(sanitizeRowsForExcel(allRows));
            worksheet["!cols"] = [
                { wch: 12 },
                { wch: 16 },
                { wch: 26 },
                { wch: 20 },
                { wch: 14 },
                { wch: 12 },
                { wch: 10 },
                { wch: 10 },
            ];

            const workbook = XLSX.utils.book_new();
            const sheetName = exportStatus ? exportStatus.substring(0, 28) : "Attendance";
            XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

            const statusLabel = exportStatus ? exportStatus.replace(/\s+/g, "_") : "All";
            const shiftLabel = (shift || "Shift").replace(/\s+/g, "_");
            const filename = `Attendance_${statusLabel}_${shiftLabel}_${startISO}_to_${endISO}.xlsx`;

            XLSX.writeFile(workbook, filename);
        } catch (err) {
            console.error("Excel download failed:", err);
            Swal.fire({
                icon: "error",
                title: "Download blocked",
                text: "Your browser blocked this file download. If this keeps happening, try accessing the dashboard over HTTPS or use a different browser.",
            });
        }
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: "error",
            title: "Export failed",
            text: "Something went wrong while generating the export. Please try again.",
        });
    }
}
// A single unpaired punch is ambiguous — we infer time-in vs time-out
// based on WHERE in the shift window the punch falls. Punches in the
// back half of the actual 9-hour shift (past the midpoint) are treated
// as clock-outs. Anything past the shift's base end time (OT territory)
// is obviously a clock-out too, since it's covered by "past midpoint".
function isLikelyClockOutPunch(minutes, isNightShift) {
    if (minutes === null) return false;

    if (isNightShift) {
        // Night shift: 19:00 -> 04:00 next day (wraps midnight), 9 hours.
        const elapsed = (minutes - NIGHT_SHIFT_START_MINUTES + 24 * 60) % (24 * 60);
        const shiftDuration = (NIGHT_SHIFT_BASE_END_MINUTES + 24 * 60) - NIGHT_SHIFT_START_MINUTES;
        return elapsed > shiftDuration / 2; // past 4.5 hours in (~11:30 PM onward)
    }

    // Day shift: 07:00 -> 16:00, 9 hours.
    const elapsed = minutes - DAY_SHIFT_START_MINUTES;
    const shiftDuration = DAY_SHIFT_BASE_END_MINUTES - DAY_SHIFT_START_MINUTES;
    return elapsed > shiftDuration / 2; // past 4.5 hours in (~11:30 AM onward)
}
// ======================================================
// PER-EMPLOYEE HISTORY DATE-RANGE EXPORT (inside History modal)
// ======================================================
function exportHistoryRangeToExcel() {
    if (typeof XLSX === "undefined") {
        Swal.fire({ icon: "error", title: "Export unavailable", text: "Excel export library failed to load." });
        return;
    }
    if (!historyEmployee) return;

    const startISO = document.getElementById("historyExportStart").value;
    const endISO = document.getElementById("historyExportEnd").value;

    if (!startISO || !endISO) {
        Swal.fire({ icon: "warning", title: "Select a date range", text: "Please choose both a start and end date." });
        return;
    }
    if (startISO > endISO) {
        Swal.fire({ icon: "warning", title: "Invalid date range", text: "The start date must be on or before the end date." });
        return;
    }

    const filtered = historyRecordsAll
        .filter(r => {
            const match = String(r.attendance_date || "").match(/^\d{4}-\d{2}-\d{2}/);
            if (!match) return false;
            const dateISO = match[0];
            return dateISO >= startISO && dateISO <= endISO;
        })
        .sort((a, b) => String(a.attendance_date).localeCompare(String(b.attendance_date)));

    if (filtered.length === 0) {
        Swal.fire({
            icon: "info",
            title: "Nothing to export",
            text: `No attendance history for ${historyEmployee.full_name || historyEmployee.emp_id} from ${formatHistoryDate(startISO)} to ${formatHistoryDate(endISO)}.`,
        });
        return;
    }

    try {
        const rows = filtered.map(r => ({
            "Employee Number": historyEmployee.emp_no || historyEmployee.emp_id || "",
            "Employee Name": historyEmployee.full_name || "",
            "Date": formatHistoryDate(r.attendance_date),
            "Shift": r.shift_name || "",
            "Time In": r.time_in || "",
            "Time Out": r.time_out || "",
            "Status": r.status || "",
        }));

        const worksheet = XLSX.utils.json_to_sheet(sanitizeRowsForExcel(rows));
        worksheet["!cols"] = [
            { wch: 16 },
            { wch: 26 },
            { wch: 12 },
            { wch: 14 },
            { wch: 10 },
            { wch: 10 },
            { wch: 12 },
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "History");

        const empLabel = (historyEmployee.emp_id || historyEmployee.full_name || "Employee")
            .toString().replace(/\s+/g, "_");
        const filename = `Attendance_History_${empLabel}_${startISO}_to_${endISO}.xlsx`;

        XLSX.writeFile(workbook, filename);
    } catch (err) {
        console.error("Excel download failed:", err);
        Swal.fire({
            icon: "error",
            title: "Download blocked",
            text: "Your browser blocked this file download. If this keeps happening, try accessing the dashboard over HTTPS or use a different browser.",
        });
    }
}

// Proposed interpretations remain inspectable even when a row needs review.
function renderPunchEvidence(record) {
    let events = record.source_punches;
    if (typeof events === "string") { try { events = JSON.parse(events); } catch (_) { return ""; } }
    if (!Array.isArray(events) || !events.length || record.matching_status !== "NEEDS_REVIEW") return "";
    const proposals = new Set();
    const raw = events.map(e => {
        for (const a of (e.alternatives || [])) {
            proposals.add(`${a.attendance_date}: ${a.shift || "Unknown shift"} — ${a.time_in || "Missing IN"} → ${a.time_out || "Missing OUT"}`);
        }
        return `<li>${escapeHtml(e.at || "")} — ${escapeHtml(e.proposed_role || "Unresolved")} (${escapeHtml(e.proposed_attendance_date || "")})</li>`;
    }).join("");
    const alternatives = [...proposals].map(a => `<li>${escapeHtml(a)}</li>`).join("");
    return `<details><summary>Punch evidence / alternatives</summary><small>Times are proposals until reviewed.</small><ul>${raw}</ul>${alternatives ? `<strong>Other possible pairings</strong><ul>${alternatives}</ul>` : ""}</details>`;
}

// ======================================================
// HR BULK APPROVE / DECLINE
// ======================================================
function getSelectedHrRequests() {
    return pendingTimeInRequests.filter(r => selectedHrRequestIds.has(String(r.id ?? r.request_id)));
}

function updateHrBulkBar() {
    const bar = document.getElementById("hrBulkBar");
    if (!bar) return;

    const total = pendingTimeInRequests.length;
    const selected = getSelectedHrRequests().length;

    bar.style.display = (canActOnHrApproval() && total > 0) ? "flex" : "none";
    document.getElementById("hrSelectedCount").textContent = `${selected} selected`;
    document.getElementById("hrBulkApproveBtn").disabled = selected === 0;
    document.getElementById("hrBulkDeclineBtn").disabled = selected === 0;

    const selectAll = document.getElementById("hrSelectAll");
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
}

async function runHrBulkAction(action) { // "approve" | "decline"
    if (!canActOnHrApproval()) return;

    const targets = getSelectedHrRequests();
    if (targets.length === 0) return;

    const isApprove = action === "approve";
    const n = targets.length;

    const confirmResult = await Swal.fire({
        icon: isApprove ? "question" : "warning",
        title: isApprove ? `Approve ${n} request${n === 1 ? "" : "s"}?` : `Decline ${n} request${n === 1 ? "" : "s"}?`,
        text: isApprove
            ? "This is the final approval and will update the employees' attendance records."
            : "The original attendance records will remain unchanged.",
        showCancelButton: true,
        confirmButtonText: isApprove ? "Yes, approve all" : "Yes, decline all",
        cancelButtonText: "Cancel",
        confirmButtonColor: isApprove ? "#16a34a" : "#dc2626",
        reverseButtons: true,
    });
    if (!confirmResult.isConfirmed) return;

    Swal.fire({
        title: isApprove ? "Approving..." : "Declining...",
        html: `<span id="hrBulkProgress">0 / ${n}</span>`,
        allowOutsideClick: false,
        allowEscapeKey: false,
        didOpen: () => Swal.showLoading(),
    });

    const succeeded = [];
    const failed = [];
    const BATCH_SIZE = 5;
    let done = 0;

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const batch = targets.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async req => {
            const id = req.id ?? req.request_id;
            try {
                const res = await fetch(`${TIME_IN_REQUESTS_URL}/${encodeURIComponent(id)}/${action}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                const result = await res.json();

                if (result.success) {
                    succeeded.push(req);
                    if (isApprove) {
                        notifyRequesterOfApproval(req, id).catch(err => console.error(err));
                    }
                } else {
                    failed.push({ req, message: result.message || "Failed" });
                }
            } catch (err) {
                console.error(err);
                failed.push({ req, message: "Server error" });
            }

            done++;
            const progressEl = document.getElementById("hrBulkProgress");
            if (progressEl) progressEl.textContent = `${done} / ${n}`;
        }));
    }

    // Alisin agad sa listahan yung mga successful
    const doneIds = new Set(succeeded.map(r => String(r.id ?? r.request_id)));
    pendingTimeInRequests = pendingTimeInRequests.filter(r => !doneIds.has(String(r.id ?? r.request_id)));
    doneIds.forEach(id => selectedHrRequestIds.delete(id));
    updatePendingRequestsBadge();
    renderPendingRequestsTable();

    if (isApprove && succeeded.length > 0) {
        setTimeout(() => loadData(), 500);
    }

    const verb = isApprove ? "approved" : "declined";

    if (failed.length === 0) {
        Swal.fire({
            icon: "success",
            title: `${succeeded.length} request${succeeded.length === 1 ? "" : "s"} ${verb}`,
            timer: 1500,
            showConfirmButton: false,
        });
    } else {
        const failedList = failed
            .map(f => `<li>${escapeHtml(f.req.full_name || f.req.emp_id || "Unknown")} — ${escapeHtml(f.message)}</li>`)
            .join("");
        Swal.fire({
            icon: "warning",
            title: `${succeeded.length} ${verb}, ${failed.length} failed`,
            html: `<ul style="text-align:left;margin:0;padding-left:20px;">${failedList}</ul>`,
        });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const selectAll = document.getElementById("hrSelectAll");
    if (selectAll) {
        selectAll.addEventListener("change", () => {
            if (selectAll.checked) {
                pendingTimeInRequests.forEach(r => selectedHrRequestIds.add(String(r.id ?? r.request_id)));
            } else {
                selectedHrRequestIds.clear();
            }
            renderPendingRequestsTable();
        });
    }

    const bulkApproveBtn = document.getElementById("hrBulkApproveBtn");
    if (bulkApproveBtn) bulkApproveBtn.addEventListener("click", () => runHrBulkAction("approve"));

    const bulkDeclineBtn = document.getElementById("hrBulkDeclineBtn");
    if (bulkDeclineBtn) bulkDeclineBtn.addEventListener("click", () => runHrBulkAction("decline"));
});