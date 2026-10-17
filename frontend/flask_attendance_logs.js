// ======================================================
// ATTENDANCE LOGS DASHBOARD
// ======================================================

const HISTORY_PAGE_SIZE = 7;
const TABLE_PAGE_SIZE = 5000;
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

let historyRecordsAll = []; // unfiltered, full set fetched from the server
let historyRangeValue = "all"; // "all" | "15" | "30"

const CLAIMED_DEPTS = new Set(["QUALITY", "TECHNICAL", "ADMINISTRATION"]);

// Populated by loadCurrentUser() on page load, from /api/me.
// "username" is the same identifier the backend stores on time-in
// requests as requested_by (e.g. "CCSTAFF") — it's what we match
// against when fetching this user's own notifications.
let currentUser = { role: null, department: null, access_level: null, is_admin: false, is_hr_approver: false, username: null };

function canViewDepartment(empDepartment) {
    const empDept = (empDepartment || "").toString().trim().toUpperCase();
    const userDept = (currentUser.department || "").toString().trim().toUpperCase();

    if (!userDept) return false; // unknown/missing user department: default deny
    if (userDept === "ADMINISTRATION") return true; // unrestricted
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

function isLineLeader() {
    return (currentUser.access_level || "").toString().trim().toUpperCase() === "LINE";
}

function canReviewRequests() {
    const level = (currentUser.access_level || "").toString().trim().toUpperCase();
    return currentUser.is_admin || ["SECTION", "DEPARTMENT", "GLOBAL"].includes(level);
}

function notifyPendingApprovalChange(kind, newCount, prevCount) {
    if (typeof Swal === "undefined") return; // library not loaded — fail quietly
    if (newCount <= prevCount) return; // only notify when the queue GREW
    if (newCount === 0) return;

    const isFirst = kind === "first";
    const label = isFirst ? "First Approval" : "HR (Final) Approval";
    const delta = newCount - prevCount;

    // First-ever notification for this queue (prevCount 0 from page load)
    // states the total; later ones state just how many are new, so the
    // user isn't told "5 pending" three separate times for the same 5.
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

let tableFilteredEmployees = []; // the currently active (possibly search-filtered) list
let tablePage = 1;

let statusFilterValue = "";
let positionFilterValue = "";
let currentSort = { key: null, dir: 1 };

let historyRecords = [];
let historyPage = 1;
let historyEmployee = null;

let pendingFirstApprovalRequests = [];

let pendingTimeInRequests = [];
let missingPunchRows = [];
let missingPunchesRange = { start: "", end: "" };

// Tracks the last count we notified the user about, per queue, so the
// popup only fires when the number of pending requests actually goes UP
// (a brand-new submission, or one moving from Stage 1 into the HR
// queue) — not every time these lists are silently re-fetched (e.g.
// after the user approves something, or the periodic poll runs and
// finds nothing new). Starting at 0 means the very first load, if there
// are already pending items sitting in the queue, correctly counts as
// an "increase" and notifies too.
let lastNotifiedFirstApprovalCount = 0;
let lastNotifiedHrApprovalCount = 0;

// Requester-facing notifications (e.g. "your time-in edit was approved").
// Same growth-based toast pattern as the two queues above: only notify
// when the unread count goes UP, not on every silent poll/refresh.
let myNotifications = [];
let lastNotifiedMyNotificationsCount = 0;

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("shiftFilter").addEventListener("change", loadData);
    document.getElementById("dateFilter").value = todayISODate();
    document.getElementById("dateFilter").addEventListener("change", loadData);
    document.getElementById("globalSearch").addEventListener("input", filterTable);

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

    document.getElementById("closeHistoryModal").addEventListener("click", closeHistoryModal);
    document.getElementById("closeHistoryModalX").addEventListener("click", closeHistoryModal);
    document.getElementById("historyPrevPage").addEventListener("click", () => changeHistoryPage(-1));
    document.getElementById("historyNextPage").addEventListener("click", () => changeHistoryPage(1));

    document.getElementById("tablePrevPage").addEventListener("click", () => changeTablePage(-1));
    document.getElementById("tableNextPage").addEventListener("click", () => changeTablePage(1));

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

        // Cross-department isolation for Stage 2: if this account isn't
        // Admin/Administration, hide the HR queue entry point entirely
        // and never fetch its data or badge count. Unauthorized users
        // should not be able to infer that pending HR requests exist,
        // how many there are, or for which department.
        if (!isHrApprover()) {
            const btn = document.getElementById("pendingRequestsBtn");
            if (btn) btn.style.display = "none";
        }

        loadData();
        loadPendingFirstApprovalRequests();
        if (isHrApprover()) {
            loadPendingTimeInRequests();
        }
        loadMyNotifications();

        // Background polling: keep checking both queues so a toast fires
        // for requests submitted after the page was first opened, not
        // just on load. Each queue is still filtered by department the
        // same way as everywhere else, so this never reveals counts for
        // departments the user can't see.
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

// Same rules as classifyStatus, but date-aware — used by the date-range
// export below. classifyStatus()'s "Pending" outcome (night shift hasn't
// technically started yet, based on the CURRENT clock time) only makes
// sense for TODAY's live dashboard view. Applying that same "now" check
// to a past date in a historical export would incorrectly mark absentees
// from days ago as "Pending" instead of "Absent". For any date that
// isn't today, a missing time-in with no leave record is always Absent.
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

// Normalizes whatever shape the /api/no-work feed returns (a bare array,
// or {data:[...]}/{records:[...]}) into a Set of normalized emp_id/emp_no
// keys — same "No Work" entries used by the backend's own
// _fetch_no_work_employees(), so an employee marked No Work never shows
// up as Absent on either side.
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

// ── Date-range helpers (used by the range export) ─────────────────────
// Parses a "YYYY-MM-DD" string into a local-midnight Date object. Using
// local time (not `new Date(iso)`, which parses as UTC) keeps this
// consistent with todayISODate() above and avoids the range silently
// shifting by a day depending on the user's timezone.
function isoToLocalDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function localDateToISO(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Returns every date, inclusive, from startISO to endISO as an array of
// "YYYY-MM-DD" strings. Assumes startISO <= endISO (validated by the
// caller before this is used).
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

function mergeRosterWithAttendance(rosterRecords, attendanceEmployees, shift, remarksMap, noWorkSet) {
    const targetShift = normalizeShiftLabel(shift);

    const attendanceByEmpId = new Map();
    (attendanceEmployees || []).forEach(emp => {
        if (emp && emp.emp_id) attendanceByEmpId.set(normalizeEmpId(emp.emp_id), emp);
    });

    const roster = (rosterRecords || []).filter(g => {
        const active = (g.employee_status || "").toUpperCase() !== "INACTIVE";
        const matchesShift = !targetShift || normalizeShiftLabel(g.shift) === targetShift;
        return active && isThnEmployee(g.emp_id) && matchesShift;
    });

const isNightShift = targetShift === "night";

    const merged = roster.map(g => {
        const attendance = attendanceByEmpId.get(normalizeEmpId(g.emp_id));

        const remarks = (g.remarks || "").toString().trim()
            || (remarksMap.get(normalizeEmpId(g.emp_id)) || "");

        const onLeave = isOnLeave({ ...g, remarks });
        // "No Work" (e.g. declared off day, suspension) takes priority
        // over the usual time-in/on-leave classification — these
        // employees must never be shown or counted as Absent.
        const noWork = (noWorkSet || new Set()).has(normalizeEmpId(g.emp_id));

        if (attendance) {
            const status = noWork
                ? "No Work"
                : classifyStatus(attendance.time_in, onLeave, isNightShift, attendance);
            return {
                ...g,
                ...attendance,
                emp_no: attendance.emp_no || g.emp_no,
                full_name: attendance.full_name || g.full_name,
                position: attendance.position || g.position || g.process || "Unassigned",
                shift_name: attendance.shift_name || g.shift,
                department: attendance.department || g.department || "",
                status,
                remarks,
            };
        }

        const status = noWork ? "No Work" : classifyStatus(null, onLeave, isNightShift, g);
        return {
            emp_id: g.emp_id,
            emp_no: g.emp_no,
            full_name: g.full_name || [g.first_name, g.last_name].filter(Boolean).join(" "),
            position: g.position || g.process || "Unassigned",
            shift_name: g.shift,
            department: g.department || "",
            gender: g.gender || "",
            status,
            time_in: null,
            time_in_status: null,
            time_out: null,
            time_out_status: null,
            attendance_date: todayISODate(),
            has_log: false,
            remarks,
        };
    });
    const mergedIds = new Set(merged.map(e => normalizeEmpId(e.emp_id)));
(attendanceEmployees || []).forEach(emp => {
    if (!emp || !emp.emp_id) return;
    if (!isThnEmployee(emp.emp_id)) return;
    if (mergedIds.has(normalizeEmpId(emp.emp_id))) return;
    if (targetShift && normalizeShiftLabel(emp.shift_name) !== targetShift) return;

    // Unknown log: count it, but do NOT show it in the employee table
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

// Lightweight variant of mergeRosterWithAttendance() built specifically
// for the date-range export below. It differs in three ways:
//   1. Takes an explicit `dateISO` so each exported row carries the
//      actual date it belongs to (mergeRosterWithAttendance always
//      stamps attendance_date with TODAY, which is correct for the live
//      dashboard but wrong when exporting past dates).
//   2. Uses classifyStatusForExport() instead of classifyStatus(), so a
//      past date with no time-in and no leave record is always "Absent"
//      rather than "Pending" (see that function's comment for why).
//   3. Skips the "unknown log" bookkeeping (window.unknownAttendanceLogs)
//      — that's a live-dashboard concern for today's table only, not
//      something a historical export needs to track.
function buildExportRowsForDate(dateISO, rosterRecords, attendanceEmployees, shift, remarksMap, noWorkSet) {
    const targetShift = normalizeShiftLabel(shift);

    const attendanceByEmpId = new Map();
    (attendanceEmployees || []).forEach(emp => {
        if (emp && emp.emp_id) attendanceByEmpId.set(normalizeEmpId(emp.emp_id), emp);
    });

    const roster = (rosterRecords || []).filter(g => {
        const active = (g.employee_status || "").toUpperCase() !== "INACTIVE";
        const matchesShift = !targetShift || normalizeShiftLabel(g.shift) === targetShift;
        return active && isThnEmployee(g.emp_id) && matchesShift;
    });

    const isNightShift = targetShift === "night";

    return roster.map(g => {
        const attendance = attendanceByEmpId.get(normalizeEmpId(g.emp_id));

        const remarks = (g.remarks || "").toString().trim()
            || (remarksMap.get(normalizeEmpId(g.emp_id)) || "");

        const onLeave = isOnLeave({ ...g, remarks });
        const noWork = (noWorkSet || new Set()).has(normalizeEmpId(g.emp_id));

        if (attendance) {
            const status = noWork
                ? "No Work"
                : classifyStatusForExport(dateISO, attendance.time_in, onLeave, isNightShift, attendance);
            return {
                ...g,
                ...attendance,
                emp_no: attendance.emp_no || g.emp_no,
                full_name: attendance.full_name || g.full_name,
                position: attendance.position || g.position || g.process || "Unassigned",
                shift_name: attendance.shift_name || g.shift,
                department: attendance.department || g.department || "",
                status,
                remarks,
                attendance_date: dateISO,
            };
        }

        const status = noWork ? "No Work" : classifyStatusForExport(dateISO, null, onLeave, isNightShift, g);
        return {
            emp_id: g.emp_id,
            emp_no: g.emp_no,
            full_name: g.full_name || [g.first_name, g.last_name].filter(Boolean).join(" "),
            position: g.position || g.process || "Unassigned",
            shift_name: g.shift,
            department: g.department || "",
            gender: g.gender || "",
            status,
            time_in: null,
            time_out: null,
            attendance_date: dateISO,
            remarks,
        };
    });
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
            // No roster: fall back to whatever the attendance-logs feed
            // gave us. That feed already resolves "No Work" server-side
            // (see backend's attendance_logs_by_date()), so emp.status
            // here may already be "No Work" — nothing extra needed.
            currentEmployees = attendanceEmployees.filter(emp =>
                !shift || normalizeShiftLabel(emp.shift_name) === normalizeShiftLabel(shift)
            );
            setRosterWarning("Full employee roster unavailable — showing only employees with a log today.");
        }
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
        positions.map(p => `<option value="${p}">${p}</option>`).join("");

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
            const hasLog = emp.has_log !== false; // undefined/true = has a real log
            const initials = getInitials(emp.full_name || emp.emp_id);
            // Only Line Leaders can prepare a correction request. Levels
            // 2-4 review/approve it and never edit the live row here.
            const canSubmitRequest = isLineLeader();

            row.innerHTML = `
                <td data-label="ID">${emp.emp_id}</td>
                <td data-label="Name">
                    <div class="employee-name-cell">
                        <div class="employee-avatar">${initials}</div>
                        <span class="employee-name-link">${emp.full_name || ""}</span>
                    </div>
                </td>
                <td data-label="Position">${emp.position || "Unassigned"}</td>
                <td data-label="Gender">${emp.gender || "—"}</td>
                <td data-label="Shift">${emp.shift_name || ""}</td>
                <td data-label="Time In">${emp.time_in || "—"}</td>
                <td class="cell-actions" data-label="Status">
                    <div class="status-cell-actions">
                        <span class="employee-status status-${statusClassSuffix(statusLabel)}">${statusLabel}</span>
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
                    // Attendance changes are deliberately opened ONLY with
                    // the Edit button. A table-cell click must never begin a
                    // correction request accidentally.
                });

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
    if (!isLineLeader()) return; // Line Leaders submit changes; Levels 2-4 review them.

    selectedEmployee = emp;

    document.getElementById("modalEmployeeId").value = `${emp.emp_id} — ${emp.full_name}`;
    document.getElementById("editShift").value =
        (emp.shift_name || "").toLowerCase().includes("night") ? "Night Shift" : "Day Shift";
    document.getElementById("editTimeInStatus").value  = emp.time_in_status  || "On Time";
    document.getElementById("editTimeOutStatus").value = emp.time_out_status || "On Time";

    document.getElementById("editTimeIn").value  = extractInputTime(emp.time_in);
    document.getElementById("editTimeOut").value = extractInputTime(emp.time_out);
    document.getElementById("editRemarks").value = "";

    document.getElementById("editModal").style.display = "flex";
}

function closeModal() {
    document.getElementById("editModal").style.display = "none";
    document.getElementById("editRemarks").value = "";
    selectedEmployee = null;
}

async function saveAttendance() {
    if (!isLineLeader()) return;
    if (!selectedEmployee) return;

    const timeIn         = document.getElementById("editTimeIn").value;
    const timeOut        = document.getElementById("editTimeOut").value;
    const shiftName      = document.getElementById("editShift").value;
    const timeInStatus   = document.getElementById("editTimeInStatus").value;
    const timeOutStatus  = document.getElementById("editTimeOutStatus").value;
    const remarks        = document.getElementById("editRemarks").value.trim();

    if (!timeIn && !timeOut) {
        alert("Please enter a Time In and/or Time Out value before submitting.");
        return;
    }

    const attendanceDate = selectedEmployee.attendance_date || todayISODate();

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
    }
}

function extractInputTime(value) {
    if (!value) return "";
    const match = String(value).match(/(\d{2}:\d{2})/);
    return match ? match[1] : "";
}
async function openHistoryModal(emp) {
    historyEmployee = emp;
    historyPage = 1;
    historyRangeValue = "all";
    document.getElementById("historyRangeFilter").value = "all";
    document.getElementById("historyExportStart").value = "";
    document.getElementById("historyExportEnd").value = "";

    document.getElementById("historyModalTitle").textContent = `${emp.full_name || emp.emp_id}`;
    document.getElementById("historyModalSubtitle").textContent =
        `Employee ID: ${emp.emp_id}${emp.position ? " · " + emp.position : ""}`;

    try {
        const res = await fetch(`/api/attendance-history/${encodeURIComponent(emp.emp_id)}`);
        const data = await res.json();
        historyRecordsAll = Array.isArray(data) ? data : (data.records || []);
    } catch (err) {
        console.error(err);
        historyRecordsAll = [];
    }

    applyHistoryRangeFilter();
    document.getElementById("historyModal").style.display = "flex";
}
// Filters historyRecordsAll down to the last N days (based on each
// record's attendance_date vs today), or shows everything for "all".
// Records with an unparseable/missing date are excluded from the 15/30
// day views (there's no date to compare), but always included in "all".
function applyHistoryRangeFilter() {
    if (historyRangeValue === "all") {
        historyRecords = historyRecordsAll;
    } else {
        const days = parseInt(historyRangeValue, 10);
        const cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setDate(cutoff.getDate() - (days - 1)); // inclusive of today

        historyRecords = historyRecordsAll.filter(r => {
            const match = String(r.attendance_date || "").match(/^\d{4}-\d{2}-\d{2}/);
            if (!match) return false;
            const recordDate = new Date(match[0]);
            return recordDate >= cutoff;
        });
    }

    historyPage = 1;
    renderHistorySummary(computeHistoryStats(historyRecords));
    renderHistoryPage();
}
function closeHistoryModal() {
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
                <td class="history-date-cell" data-label="Date">${formatHistoryDate(r.attendance_date)}</td>
                <td data-label="Shift">${r.shift_name || "—"}</td>
                <td data-label="Time In">${r.time_in || "—"}</td>
                <td data-label="Time Out">${r.time_out || "—"}</td>
                <td data-label="Status"><span class="employee-status status-${statusClassSuffix(r.status || "")}">${r.status || "—"}</span></td>
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

        // Has a time_out but never clocked in.
        if (hasTimeOut && !hasTimeIn) stats.missingTimeIn++;
        // Clocked in but never clocked out.
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

function getMissingPunchEmployees(employees) {
    return (employees || []).filter(emp => {
        const status = (emp.status || "").toLowerCase();
        if (status === "absent" || status === "on leave" || status === "no work") return false;

        const hasIn = !!emp.time_in;
        const hasOut = !!emp.time_out;
        return hasIn !== hasOut; // exactly one punch present
    });
}

function updateMissingPunchesBadge() {
    const count = getMissingPunchEmployees(currentEmployees).length;
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

async function fetchMissingPunchesForRange(range) {
    const allRows = [];
    for (const dateISO of range.dates) {
        const data = await fetch(`${ATTENDANCE_LOGS_URL}?date=${encodeURIComponent(dateISO)}`, {
            credentials: "same-origin",
        }).then(res => res.json());
        if (!data.success) throw new Error(data.message || `Unable to load ${dateISO}.`);

        (data.data || []).forEach(emp => {
            const hasTimeIn = !!emp.time_in;
            const hasTimeOut = !!emp.time_out;
            if (hasTimeIn === hasTimeOut || emp.status === "No Work" || emp.status === "On Leave") return;
            allRows.push({ ...emp, attendance_date: dateISO });
        });
    }
    return allRows;
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
                <td data-label="Date">${formatHistoryDate(emp.attendance_date)}</td>
                <td data-label="Employee ID">${emp.emp_id || ""}</td>
                <td data-label="Employee Name">${emp.full_name || ""}</td>
                <td data-label="Shift">${emp.shift_name || ""}</td>
                <td data-label="Time In">${emp.time_in || '<span class="punch-missing">Missing</span>'}</td>
                <td data-label="Time Out">${emp.time_out || '<span class="punch-missing">Missing</span>'}</td>
            </tr>
        `).join("");
}

async function refreshMissingPunchesReport() {
    const range = getMissingPunchesDateRange();
    if (!range) return;
    const body = document.getElementById("missingPunchesTableBody");
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">Loading missing punches…</td></tr>`;
    try {
        missingPunchRows = await fetchMissingPunchesForRange(range);
        missingPunchesRange = range;
        renderMissingPunchesReport();
    } catch (err) {
        console.error(err);
        body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#dc2626;padding:20px;">Unable to load missing punches. Please try again.</td></tr>`;
    }
}

async function exportMissingPunchesToExcel() {
    if (typeof XLSX === "undefined") {
        Swal.fire({ icon: "error", title: "Export unavailable", text: "Excel export library failed to load." });
        return;
    }
    const range = getMissingPunchesDateRange();
    if (!range) return;
    try {
        missingPunchRows = await fetchMissingPunchesForRange(range);
        missingPunchesRange = range;
        renderMissingPunchesReport();
    } catch (err) {
        console.error(err);
        Swal.fire({ icon: "error", title: "Export failed", text: "Unable to load the missing-punch report." });
        return;
    }
    if (!missingPunchRows.length) {
        Swal.fire({ icon: "info", title: "Nothing to export", text: "No missing punches were found for this date range." });
        return;
    }
    const rows = missingPunchRows.map(emp => ({
        "Employee ID": emp.emp_id || emp.emp_no || "",
        "Employee Name": emp.full_name || "",
        "Line / Department": emp.line_name || emp.department || "",
        "Date": formatHistoryDate(emp.attendance_date),
        "Missing Punch Type": emp.time_in ? "Missing Out" : "Missing In",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [{ wch: 16 }, { wch: 28 }, { wch: 28 }, { wch: 14 }, { wch: 20 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Missing Punches");
    XLSX.writeFile(workbook, `Missing_Punches_${range.start}_to_${range.end}.xlsx`);
}

async function loadPendingFirstApprovalRequests() {
    try {
        const res = await fetch(`${TIME_IN_REQUESTS_URL}?status=${encodeURIComponent("Pending First Approval")}`, {
            credentials: "same-origin",
        });
        const data = await res.json();
        // NOTE: backend returns the array under "request" (singular) —
        // not "requests"/"data" — for this endpoint. Falling back through
        // all three shapes keeps this working regardless of which key
        // ends up being used server-side.
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
    document.getElementById("firstApprovalModal").style.display = "flex";
    loadPendingFirstApprovalRequests().then(renderFirstApprovalTable);
    renderFirstApprovalTable();
}

function closeFirstApprovalModal() {
    document.getElementById("firstApprovalModal").style.display = "none";
}

// Builds a "First Last" display name out of whatever the API gives us
// for a given person role (e.g. "requested_by" or "first_approved_by").
// Prefers an explicit full-name field, then falls back to combining
// first/last name fields, and only falls back to the raw
// username/identifier string as a last resort (so the table still
// shows *something* if the backend hasn't been updated to include the
// name fields yet).
function getPersonDisplayName(req, prefix) {
    const fullNameField = req[`${prefix}_full_name`] || req[`${prefix}_name`];
    if (fullNameField) return fullNameField;

    const first = req[`${prefix}_first_name`];
    const last = req[`${prefix}_last_name`];
    const combined = [first, last].filter(Boolean).join(" ").trim();
    if (combined) return combined;

    return req[prefix] || "";
}

function renderFirstApprovalTable() {
    const subtitle = document.getElementById("firstApprovalSubtitle");
    subtitle.textContent = `${pendingFirstApprovalRequests.length} request${pendingFirstApprovalRequests.length === 1 ? "" : "s"} awaiting first approval`;

    const body = document.getElementById("firstApprovalTableBody");

    if (pendingFirstApprovalRequests.length === 0) {
        body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#95a5a6;padding:20px;">No requests awaiting first approval.</td></tr>`;
        return;
    }

    const viewer = !canReviewRequests();

    body.innerHTML = pendingFirstApprovalRequests.map(req => {
        const id = req.id ?? req.request_id;
        const empLabel = `${req.emp_id || ""} — ${req.full_name || ""}`;
        const department = req.department ? escapeHtml(req.department) : "<span style=\"color:var(--text-muted);\">—</span>";
        const changesSummary = formatRequestedChanges(req);
        const requesterName = getPersonDisplayName(req, "requested_by");
        const requester = requesterName ? escapeHtml(requesterName) : "—";
        const dateLabel = formatHistoryDate(req.attendance_date);
        const remarks = req.remarks ? escapeHtml(req.remarks) : "<span style=\"color:var(--text-muted);\">—</span>";
        const actions = viewer
            ? `<span style="color:var(--text-muted);font-size:12px;">View only</span>`
            : `<div class="request-actions-cell">
                <button type="button" class="request-action-btn request-approve-btn" data-id="${id}">Approve</button>
                <button type="button" class="request-action-btn request-decline-btn" data-id="${id}">Decline</button>
            </div>`;

        return `
            <tr>
                <td data-label="Employee">${empLabel}</td>
                <td data-label="Department">${department}</td>
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
            btn.addEventListener("click", () => firstApproveTimeInRequest(btn.dataset.id));
        });
        body.querySelectorAll(".request-decline-btn").forEach(btn => {
            btn.addEventListener("click", () => declineTimeInRequest(btn.dataset.id, "first"));
        });
    }
}

async function firstApproveTimeInRequest(requestId) {
    if (!requestId) return;
    if (!confirm("Approve this request? It will move on to HR for final approval.")) return;

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
            // Only refresh/count the HR queue for accounts allowed to see it.
            if (isHrApprover()) {
                await loadPendingTimeInRequests();
            }
        } else {
            alert(result.message || "Failed to approve request.");
        }
    } catch (err) {
        console.error(err);
        alert("Server error while approving request.");
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
        // Same response shape as the first-approval endpoint — backend
        // returns the array under "request" (singular).
        const allRequests = Array.isArray(data) ? data : (data.requests || data.request || data.data || []);
        // Strict department match applies here too now — see the policy
        // change note near canViewDepartment().
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

    if (pendingTimeInRequests.length === 0) {
        body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#95a5a6;padding:20px;">No pending Time-In requests.</td></tr>`;
        return;
    }

    // Final HR approval actions are gated by DEPARTMENT, not by role/
    // is_admin — PRODUCTION / TECHNICAL / QUALITY accounts (Admin role
    // or not) can open and view this queue, but only ADMINISTRATION
    // accounts get the Approve/Decline buttons. isViewer() still applies
    // on top of that for the explicit Viewer role.
    const canAct = canActOnHrApproval();

    body.innerHTML = pendingTimeInRequests.map(req => {
        const id = req.id ?? req.request_id;
        const empLabel = `${req.emp_id || ""} — ${req.full_name || ""}`;
        const department = req.department ? escapeHtml(req.department) : "<span style=\"color:var(--text-muted);\">—</span>";
        const changesSummary = formatRequestedChanges(req);
        const requestedByName = getPersonDisplayName(req, "requested_by");
        const requestedBy = requestedByName ? escapeHtml(requestedByName) : "—";
        const firstApprovedByName = getPersonDisplayName(req, "first_approved_by");
        const firstApprovedBy = firstApprovedByName
            ? escapeHtml(firstApprovedByName)
            : `<span style="color:var(--text-muted);">—</span>`;
        const dateLabel = formatHistoryDate(req.attendance_date);
        const remarks = req.remarks ? escapeHtml(req.remarks) : "<span style=\"color:var(--text-muted);\">—</span>";
        const actions = canAct
            ? `<button type="button" class="request-action-btn request-approve-btn" data-id="${id}">Approve</button>
               <button type="button" class="request-action-btn request-decline-btn" data-id="${id}">Decline</button>`
            : `<span style="color:var(--text-muted);font-size:12px;">View only</span>`;

        return `
            <tr>
                <td data-label="Employee">${empLabel}</td>
                <td data-label="Department">${department}</td>
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
        body.querySelectorAll(".request-approve-btn").forEach(btn => {
            btn.addEventListener("click", () => approveTimeInRequest(btn.dataset.id));
        });
        body.querySelectorAll(".request-decline-btn").forEach(btn => {
            btn.addEventListener("click", () => declineTimeInRequest(btn.dataset.id, "hr"));
        });
    }
}

function formatRequestedChanges(req) {
    const changes = req.changes || {};
    const parts = [];

    if (changes.shift_name) {
        parts.push(`Shift: ${changes.shift_name}`);
    }
    if (changes.time_in) {
        const status = changes.time_in_status ? ` (${changes.time_in_status})` : "";
        parts.push(`Time In: ${formatDisplayTime(changes.time_in)}${status}`);
    }
    if (changes.time_out) {
        const status = changes.time_out_status ? ` (${changes.time_out_status})` : "";
        parts.push(`Time Out: ${formatDisplayTime(changes.time_out)}${status}`);
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
    div.textContent = value;
    return div.innerHTML;
}

// Generic notification writer, used for requester-facing notifications
// (e.g. TIME_IN_APPROVED). This always runs AFTER the primary approval
// write has already succeeded — it is best-effort delivery, not part of
// the approval transaction. A failure here is logged and swallowed; it
// must never undo or block the approval that already went through.
async function postNotification(payload) {
    if (!payload || !payload.recipientId) {
        console.error("postNotification: missing recipientId, skipping notification.", payload);
        return;
    }

    try {
        const res = await fetch(NOTIFICATIONS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            console.error(`Failed to create notification: server responded ${res.status}`);
            return;
        }
        const result = await res.json();
        if (!result.success) {
            console.error("Failed to create notification:", result.message || result);
        }
    } catch (err) {
        console.error("Server error while creating notification:", err);
    }
}

async function approveTimeInRequest(requestId) {
    if (!canActOnHrApproval()) return;
    if (!requestId) return;

    // SweetAlert confirmation before approving
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

    // Grab the employee name/position before the list refreshes (the
    // approved request disappears from pendingTimeInRequests once the
    // reload below runs), so the success popup still has something to show.
    const req = pendingTimeInRequests.find(r => String(r.id ?? r.request_id) === String(requestId));

    // Small loading indicator while the request is in flight
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
            // Show success IMMEDIATELY once the approve call actually
            // succeeds — don't wait for the table/notification refreshes
            // below, that's what was causing the delay before.
            Swal.fire({
                icon: "success",
                title: "Time-In Approved",
                html: `<strong>${escapeHtml(req?.full_name || "Employee")}</strong><br>${escapeHtml(req?.position || "")}`,
                confirmButtonText: "OK",
            });

            // Everything else refreshes in the background now — no longer
            // blocks the success alert from showing.
            loadPendingTimeInRequests().then(renderPendingRequestsTable);
            loadData(); // refresh the main table so the approved Time In shows up

            // Notify the employee who originally submitted the request that
            // it has now cleared final HR approval.
            notifyRequesterOfApproval(req, requestId);
        } else {
            Swal.fire({
                icon: "error",
                title: "Failed to approve request",
                text: result.message || "Please try again.",
            });
        }
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: "error",
            title: "Server error",
            text: "Something went wrong while approving the request.",
        });
    }
}
// Builds and sends the requester-facing "Time-in Request Approved"
// notification. `req` is the pending-request record captured before the
// queue refreshed (same object approveTimeInRequest() already uses for
// the confirmation popup), and `requestId` is the id passed into
// approveTimeInRequest(). Guards against a missing requesterId instead
// of throwing, since the approval itself has already succeeded by the
// time this runs.
function notifyRequesterOfApproval(req, requestId) {
    const requesterId = req?.requested_by || req?.requester_id || req?.requested_by_id || null;
    if (!requesterId) {
        console.error("notifyRequesterOfApproval: missing requesterId on request", requestId, "— skipping requester notification.");
        return;
    }

    const changes = req?.changes || {};
    const dateLabel = formatHistoryDate(req?.attendance_date);

    const changeParts = [];
    if (changes.time_in) changeParts.push(`time-in to ${formatDisplayTime(changes.time_in)}`);
    if (changes.time_out) changeParts.push(`time-out to ${formatDisplayTime(changes.time_out)}`);
    const changeDescription = changeParts.length ? changeParts.join(" and ") : "attendance";

    postNotification({
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
            // Endpoint not deployed yet, or a transient server error —
            // fail quietly rather than throwing on res.json() below.
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
    if (typeof Swal === "undefined") return; // library not loaded — fail quietly
    if (newCount <= prevCount) return; // only notify when the count GREW
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

// Maps a notification "type" to a small icon glyph. Only TIME_IN_APPROVED
// exists today, but this stays a switch so future types (e.g. a decline
// notification) can be added without touching the render logic below.
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
            <div class="notification-item${unreadClass}" data-id="${id}">
                <span class="notification-icon">${notificationIcon(n.type)}</span>
                <div class="notification-content">
                    <div class="notification-title">${escapeHtml(n.title || "")}</div>
                    <div class="notification-body">${escapeHtml(n.body || "")}</div>
                    <div class="notification-timestamp">${formatNotificationTimestamp(n.timestamp)}</div>
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

async function declineTimeInRequest(requestId, stage) {
    if (stage === "hr" && !canActOnHrApproval()) return;
    if (!requestId) return;
    if (!confirm("Decline this Time-In request? The original attendance record will remain unchanged.")) return;

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
        }
    } catch (err) {
        console.error(err);
        alert("Server error while declining request.");
    }
}
document.addEventListener("DOMContentLoaded", () => {
    // ... existing listeners ...
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

    const rows = filtered.map(emp => ({
        "Employee Number": emp.emp_no || emp.emp_id || "",
        "Employee Name": emp.full_name || "",
        "Position": emp.position || "Unassigned",
        "Line/Shift": emp.shift_name || "",
        "Status": emp.status || "",
        "Time In": emp.time_in || "",
        "Time Out": emp.time_out || "",
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);

    // Reasonable column widths so it doesn't look cramped when opened
    worksheet["!cols"] = [
        { wch: 16 }, // Employee Number
        { wch: 26 }, // Employee Name
        { wch: 20 }, // Position
        { wch: 14 }, // Line/Shift
        { wch: 12 }, // Status
        { wch: 10 }, // Time In
        { wch: 10 }, // Time Out
    ];

    const workbook = XLSX.utils.book_new();
    const sheetName = exportStatus ? exportStatus.substring(0, 28) : "All Employees";
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    const statusLabel = exportStatus ? exportStatus.replace(/\s+/g, "_") : "All";
    const shiftLabel = (shift || "Shift").replace(/\s+/g, "_");
    const filename = `Attendance_${statusLabel}_${shiftLabel}_${selectedDate}.xlsx`;

    XLSX.writeFile(workbook, filename);
}

// ======================================================
// DATE-RANGE EXPORT (e.g. "August 1 to August 17")
// ======================================================
// Combines every day in the selected range into ONE spreadsheet, with a
// leading "Date" column so each row is still traceable to the day it
// belongs to. Reuses the same Shift and Export Status filters as the
// single-date export above, so "Export Date Range" respects whatever the
// person already has selected there.
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
        // Roster + remarks reflect the CURRENT roster/leave state — this
        // dashboard doesn't track a historical roster snapshot per day, so
        // (same limitation as the single-date export) an employee who
        // joined/left partway through the range will still be evaluated
        // against today's roster entry for every day in the range.
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

        const worksheet = XLSX.utils.json_to_sheet(allRows);
        worksheet["!cols"] = [
            { wch: 12 }, // Date
            { wch: 16 }, // Employee Number
            { wch: 26 }, // Employee Name
            { wch: 20 }, // Position
            { wch: 14 }, // Line/Shift
            { wch: 12 }, // Status
            { wch: 10 }, // Time In
            { wch: 10 }, // Time Out
        ];

        const workbook = XLSX.utils.book_new();
        const sheetName = exportStatus ? exportStatus.substring(0, 28) : "Attendance";
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

        const statusLabel = exportStatus ? exportStatus.replace(/\s+/g, "_") : "All";
        const shiftLabel = (shift || "Shift").replace(/\s+/g, "_");
        const filename = `Attendance_${statusLabel}_${shiftLabel}_${startISO}_to_${endISO}.xlsx`;

        XLSX.writeFile(workbook, filename);
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: "error",
            title: "Export failed",
            text: "Something went wrong while generating the export. Please try again.",
        });
    }
}

// ======================================================
// PER-EMPLOYEE HISTORY DATE-RANGE EXPORT (inside History modal)
// ======================================================
// Unlike exportAttendanceRangeToExcel() above (which re-fetches the
// roster/attendance feeds day-by-day for EVERY employee), this exports
// just the ONE employee currently open in the History modal. No extra
// fetches are needed — historyRecordsAll already holds that employee's
// complete history (loaded once in openHistoryModal()), so this simply
// filters it down to the chosen start/end dates client-side.
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

    const rows = filtered.map(r => ({
        "Employee Number": historyEmployee.emp_no || historyEmployee.emp_id || "",
        "Employee Name": historyEmployee.full_name || "",
        "Date": formatHistoryDate(r.attendance_date),
        "Shift": r.shift_name || "",
        "Time In": r.time_in || "",
        "Time Out": r.time_out || "",
        "Status": r.status || "",
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
        { wch: 16 }, // Employee Number
        { wch: 26 }, // Employee Name
        { wch: 12 }, // Date
        { wch: 14 }, // Shift
        { wch: 10 }, // Time In
        { wch: 10 }, // Time Out
        { wch: 12 }, // Status
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "History");

    const empLabel = (historyEmployee.emp_id || historyEmployee.full_name || "Employee")
        .toString().replace(/\s+/g, "_");
    const filename = `Attendance_History_${empLabel}_${startISO}_to_${endISO}.xlsx`;

    XLSX.writeFile(workbook, filename);
}
