// =========================================================
// Employee Management — vanilla JS (no frameworks)
// =========================================================

const GET_EMPLOYEES_URL = "/api/employees";
const BULK_DELETE_URL = "/api/employees/bulk-delete";
const EMPLOYEE_ADD_URL = "/api/employees/add";
const LEAVE_STATUS_URL = "/api/employees/bulk-leave";
const RETURN_STATUS_URL = "/api/employees/bulk-return";
// "No Work" is a separate system from Leave -- date-scoped, backed by
// frontend.no_work_schedule via main.py, not the employee_groupings.remarks
// convention Leave uses. See attendance.py's /api/no-work routes.
const NO_WORK_URL = "/api/no-work";
// Separated / Rehired -- HR-entered events, backed by
// frontend.employee_status_events via data.py (same direct-SQLAlchemy
// pattern as bulk-leave/bulk-return). Also flips
// employee_groupings.employee_status to SEPARATED/ACTIVE.
const SEPARATE_URL = "/api/employees/bulk-separate";
const REHIRE_URL = "/api/employees/bulk-rehire";
const STATUS_EVENTS_SUMMARY_URL = "/api/status-events/summary";
const AGENCY_PREFIX_MAP = {
  THN: "",
  CCI: "C",
  NATCORP: "N",
  EMIS: "E"
};
// Leave-type codes recognized by attendance_logs.js's isOnLeave() regex
// (^(VL|SL|ML|SS|PL)(?:\s|-|$)). Any remarks string built for a bulk
// "Mark as On Leave" action MUST start with one of these codes, or the
// employee will silently fall through to being counted as Absent instead
// of On Leave on the Attendance Logs dashboard.
const LEAVE_TYPE_LABELS = {
  VL: "VL — Vacation Leave",
  SL: "SL — Sick Leave",
  ML: "ML — Maternity Leave",
  SS: "SS — Suspension",
  PL: "PL — Paternity Leave",
};
const LEAVE_TYPE_CODES = new Set(Object.keys(LEAVE_TYPE_LABELS));

// ---------------------------------------------------------
// State
// ---------------------------------------------------------
let employees = [];          // active employee state
let selectedIds = new Set(); // currently checked rows

// Pagination state. The API still returns the full roster, but only
// `pageSize` rows are ever turned into DOM nodes at a time -- that is
// what keeps the table fast no matter how many employees exist.
let currentPage = 1;
let pageSize = 25;
let currentPageIds = [];     // employee_ids of the rows on the visible page
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// ---------------------------------------------------------
// DOM refs
// ---------------------------------------------------------
const tableBody         = document.getElementById("employeeTableBody");

// Gender column header. Older versions of the HTML template didn't
// define a <th> for it, so this used to inject one at runtime (inserted
// right before the "Shift" header to match the <td> ordering in
// render()). The current template now ships a real Gender <th>, so this
// IIFE just verifies one is present and no-ops otherwise -- kept as a
// safety net in case the template regresses, without duplicating the
// header when it's already there.
(function ensureGenderColumnHeader() {
  const headerRow = tableBody.closest("table")?.querySelector("thead tr");
  if (!headerRow || headerRow.querySelector("[data-gender-col]")) return;

  // The template may already define a real "Gender" <th> (it does as of
  // the current template) -- don't inject a second one on top of it.
  const alreadyHasGenderHeader = Array.from(headerRow.querySelectorAll("th"))
    .some(h => /^gender$/i.test(h.textContent.trim()));
  if (alreadyHasGenderHeader) return;

  const th = document.createElement("th");
  th.textContent = "Gender";
  th.setAttribute("data-gender-col", "");

  const headers = Array.from(headerRow.querySelectorAll("th"));
  const shiftHeader = headers.find(h => /shift/i.test(h.textContent));
  if (shiftHeader) {
    headerRow.insertBefore(th, shiftHeader);
  } else if (headers.length) {
    headerRow.insertBefore(th, headers[headers.length - 1]);
  } else {
    headerRow.appendChild(th);
  }
})();
const searchInput       = document.getElementById("searchInput");
const shiftSegmented    = document.getElementById("shiftSegmented");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");
const bulkDeleteBtn     = document.getElementById("bulkDeleteBtn");
const bulkLeaveBtn      = document.getElementById("bulkLeaveBtn");
const bulkReturnBtn     = document.getElementById("bulkReturnBtn");
const clearSelectionBtn = document.getElementById("clearSelectionBtn");
const statusEl          = document.getElementById("status");
const tableFoot         = document.getElementById("tableFoot");

const totalCountEl = document.getElementById("totalCount");
const dayCountEl   = document.getElementById("dayCount");
const nightCountEl = document.getElementById("nightCount");
const deptCountEl  = document.getElementById("deptCount");

let activeShift = "all"; // "all" | "day" | "night"
let activeAgency = "all";
let activeDepartment = "all";
const departmentFilterSelect = document.getElementById("departmentFilter");
// ---------------------------------------------------------
// Access control — THREE independent, non-nested permission tiers,
// each driven by its own body[data-*] attribute set from role_context()
// in auth.py:
//
//   CAN_MANAGE_EMPLOYEES  <- data-can-manage-employees
//                            (role_info.can_manage_employees)
//     Add, per-row Edit, Mark On Leave, Return to Work, Separate,
//     Rehire. True for Levels 2-4 (SECTION/DEPARTMENT/GLOBAL
//     access_level) or Admin.
//
//   CAN_BULK_DELETE       <- data-can-bulk-delete
//                            (role_info.can_bulk_delete)
//     Bulk Delete ONLY. Same Levels 2-4 / Admin gate as manage access
//     today, but kept as its OWN flag (not folded into
//     CAN_MANAGE_EMPLOYEES) per the spec: Level 1 (LINE / Line Leader)
//     must be STRICTLY blocked from this action specifically, so the
//     two are never allowed to silently drift back together.
//
//   CAN_DECLARE_NO_WORK   <- data-can-declare-no-work
//                            (role_info.can_declare_no_work)
//     The No Work feature only (Mark No Work / Clear No Work). True for
//     Admin, HR/Administration, AND any Supervisor role regardless of
//     their department or access_level. A Supervisor gets this ONE
//     action without getting full management.
//
// selection (checkboxes) is needed by ANY of the three tiers — anyone
// who can run at least one bulk/row action needs to be able to check
// rows. Only someone with NONE of the three is fully locked out of
// selection.
//
// IMPORTANT: this is a UX convenience only, exactly like the warning
// already written in auth.py about client-side checks. It is trivially
// bypassed via devtools/curl. The mutating routes this file calls
// (/api/employees/add, /update, /bulk-delete, /bulk-leave, /bulk-return,
// /bulk-separate, /bulk-rehire, /api/no-work) MUST enforce the same
// checks server-side (can_manage_employees-equivalent for management
// routes; bulk_delete_required for /api/employees/bulk-delete;
// no_work_access_required + can_view_employee() for /api/no-work) or a
// non-authorized user can still perform these actions directly.
// ---------------------------------------------------------
const CAN_MANAGE_EMPLOYEES = document.body.dataset.canManageEmployees === "true";
const CAN_BULK_DELETE = document.body.dataset.canBulkDelete === "true";
const CAN_DECLARE_NO_WORK = document.body.dataset.canDeclareNoWork === "true";
const CAN_SELECT_ROWS = CAN_MANAGE_EMPLOYEES || CAN_BULK_DELETE || CAN_DECLARE_NO_WORK;

function applyAccessControl() {
  if (!CAN_MANAGE_EMPLOYEES) {
    // Hide every full-management control EXCEPT bulk delete, which now
    // has its own, separate gate below. Search, shift/agency filters,
    // and the row-click "view details" drawer stay fully working for
    // everyone regardless of tier.
    addEmployeeBtn.style.display = "none";
    bulkLeaveBtn.style.display = "none";
    bulkReturnBtn.style.display = "none";

    // Drives the CSS that hides the per-row Edit button (see
    // body.no-manage-access rules in employee_management.html). Does NOT
    // hide selection checkboxes — a Supervisor/Level-2-4 user without
    // manage access may still need those for No Work or Bulk Delete.
    document.body.classList.add("no-manage-access");
  }

  if (!CAN_BULK_DELETE) {
    // Level 1 (Line Leader) is STRICTLY blocked from bulk deletion —
    // hide the button outright regardless of CAN_MANAGE_EMPLOYEES.
    bulkDeleteBtn.style.display = "none";
  }

  if (!CAN_SELECT_ROWS) {
    // None of the three tiers — nothing is selectable, so the selection
    // UI itself (checkboxes + Clear Selection) is pointless and hidden.
    clearSelectionBtn.style.display = "none";
    document.body.classList.add("no-selection-access");
  }
}

// ---------------------------------------------------------
// Auto-uppercase helper — transforms text inputs to caps as
// the user types, while preserving cursor position so typing
// still feels natural (no cursor jumping to the end).
// ---------------------------------------------------------
function attachUppercase(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener("input", () => {
    const start = inputEl.selectionStart;
    const end = inputEl.selectionEnd;
    inputEl.value = inputEl.value.toUpperCase();
    inputEl.setSelectionRange(start, end);
  });
}

// ---------------------------------------------------------
// Normalize a stored date value (ISO string, RFC datetime, or
// already-YYYY-MM-DD) into the yyyy-mm-dd shape <input type="date">
// requires. Returns "" for anything empty/unparseable.
// ---------------------------------------------------------
function toDateInputValue(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

// ---------------------------------------------------------
// Tenure helpers.
//
// `frontend.employee_groupings.tenure` is a NUMERIC(10,2) column in the
// database (see table_init.py), so the DB always needs a plain decimal
// number of years (e.g. 6.42), never a formatted string. The UI, on the
// other hand, should always show a human-readable "6 yrs 5 mos" form.
// These three helpers keep those two representations separate:
//
//   - tenureYearsMonths(dateHired): shared years/months breakdown
//   - calculateTenure(dateHired):   "6 yrs 5 mos" string, for display only
//   - calculateTenureDecimal(...):  6.42 number, for the API payload / DB
//   - formatTenureDisplay(value):   turns a stored value (decimal number
//     OR a legacy free-text string from before this fix) back into a
//     display string
// ---------------------------------------------------------
function tenureYearsMonths(dateHired) {
  if (!dateHired) return null;
  const hired = new Date(dateHired);
  if (isNaN(hired.getTime())) return null;

  const now = new Date();
  if (hired > now) return { years: 0, months: 0, notStarted: true };

  let years = now.getFullYear() - hired.getFullYear();
  let months = now.getMonth() - hired.getMonth();
  const days = now.getDate() - hired.getDate();

  if (days < 0) months--;
  if (months < 0) { years--; months += 12; }

  return { years, months, notStarted: false };
}

// Human-readable form, e.g. "6 yrs 5 mos" — for on-screen display
// (read-only tenure field, confirmation dialogs) only. Never send this
// string to the backend; the DB column is numeric.
function calculateTenure(dateHired) {
  const t = tenureYearsMonths(dateHired);
  if (!t) return "";
  if (t.notStarted) return "Not yet started";

  if (t.years === 0 && t.months === 0) {
    const hired = new Date(dateHired);
    const now = new Date();
    const diffDays = Math.floor((now - hired) / (1000 * 60 * 60 * 24));
    return diffDays <= 1 ? "New hire" : `${diffDays} days`;
  }

  const parts = [];
  if (t.years > 0) parts.push(`${t.years} yr${t.years !== 1 ? "s" : ""}`);
  if (t.months > 0) parts.push(`${t.months} mo${t.months !== 1 ? "s" : ""}`);
  return parts.join(" ");
}

// Decimal number of years (e.g. 6.42), rounded to 2 decimal places —
// this is what goes in the `tenure` field of any payload sent to the
// backend, matching the NUMERIC(10,2) column.
function calculateTenureDecimal(dateHired) {
  const t = tenureYearsMonths(dateHired);
  if (!t || t.notStarted) return 0;
  return Math.round((t.years + t.months / 12) * 100) / 100;
}

// Turns a value coming back FROM the database into a display string.
// Handles both the new decimal numbers (6.42) and legacy free-text
// values (e.g. "6 yrs 5 mos") that may already be sitting in old rows
// from before this fix, so old records don't render as garbage.
function formatTenureDisplay(value) {
  if (value === null || value === undefined || value === "") return "";
  const str = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) return str; // legacy text — show as-is

  const num = Number(str);
  const years = Math.floor(num);
  const months = Math.round((num - years) * 12);
  const parts = [];
  if (years > 0) parts.push(`${years} yr${years !== 1 ? "s" : ""}`);
  if (months > 0) parts.push(`${months} mo${months !== 1 ? "s" : ""}`);
  return parts.length ? parts.join(" ") : "New hire";
}

// ---------------------------------------------------------
// Load employees from the employee_groupings API (same
// endpoint used for bulk delete, fetched here with GET).
//
// Confirmed real response shape includes:
//   emp_id ("C-9811"), full_name, department, position,
//   shift ("Day Shift" / "Night Shift"), employee_status,
//   line, line_name, process, date_hired, tenure, remarks
//
// NOTE: `_raw` keeps the original untouched record so that
// editing name/shift never accidentally clobbers line, line_name,
// process, date_hired, or tenure on the backend.
// ---------------------------------------------------------
async function loadEmployees() {
  setStatus("Loading employees...");

  try {
    const res = await fetch(GET_EMPLOYEES_URL);

    if (!res.ok) {
      throw new Error(`Server responded with status ${res.status}`);
    }

    const data = await res.json();

    // The API returns a bare array; this fallback just guards against
    // a wrapped response shape without changing normal behavior.
    const records = Array.isArray(data) ? data : (data.employees || data.data || []);

    employees = records
      .filter(emp => (emp.employee_status || "").toUpperCase() !== "INACTIVE")
      .map(emp => ({
        employee_id: emp.emp_id,
        name: emp.full_name ||
          [emp.first_name, emp.last_name].filter(Boolean).join(" ") ||
          "Unknown",
        // Department/Position may come back null from the backend even
        // when the record has real data under line_name/process — fall
        // back to those so existing records don't show blank.
        department: emp.department || emp.line_name || "",
        position: emp.position || emp.process || "",
        gender: emp.gender || "",
        shift: /night/i.test(emp.shift || "") ? "night" : "day",
        _raw: emp
      }))
      .filter(emp => emp.employee_id); // drop rows with no ID

    setStatus("");
    render();

  } catch (err) {
    console.error(err);
    setStatus(`Failed to load employees: ${err.message}`, true);
    employees = [];
    render();
  }
}

// ---------------------------------------------------------
// Filtering
// ---------------------------------------------------------
function getFilteredEmployees() {
  const search = searchInput.value.trim().toLowerCase();

  return employees.filter(emp => {
    const matchesSearch =
      !search ||
      emp.employee_id.toLowerCase().includes(search) ||
      emp.name.toLowerCase().includes(search);

    const matchesShift = activeShift === "all" || emp.shift === activeShift;

    const matchesAgency =
      activeAgency === "all" || getAgencyFromId(emp.employee_id) === activeAgency;

    const matchesDepartment =
      activeDepartment === "all" || (emp.department || "").trim() === activeDepartment;

    return matchesSearch && matchesShift && matchesAgency && matchesDepartment;
  });
}
// Rebuilds the Department dropdown options from whatever departments
// currently exist in the roster, preserving the current selection
// (falls back to "all" if the selected department no longer exists,
// e.g. after edits/deletes).
function populateDepartmentFilter() {
  const departments = Array.from(
    new Set(employees.map(e => (e.department || "").trim()).filter(Boolean))
  ).sort();

  const previousValue = departmentFilterSelect.value || "all";

  departmentFilterSelect.innerHTML =
    `<option value="all">All Departments</option>` +
    departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");

  if (previousValue !== "all" && departments.includes(previousValue)) {
    departmentFilterSelect.value = previousValue;
  } else {
    departmentFilterSelect.value = "all";
    activeDepartment = "all";
  }
}

departmentFilterSelect.addEventListener("change", () => {
  activeDepartment = departmentFilterSelect.value;
  currentPage = 1;
  render();
});
const agencySegmented = document.getElementById("agencySegmented");

agencySegmented.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-agency]");
  if (!btn) return;

  activeAgency = btn.dataset.agency;
  currentPage = 1;

  agencySegmented.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b === btn)
  );

  render();
});

// ---------------------------------------------------------
// Render
// ---------------------------------------------------------
function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

// Leave status is derived purely from `_raw.remarks` being non-empty.
// Backend stores it as "<CODE> | Reason: ... | Until: YYYY-MM-DD" where
// CODE is one of VL/SL/ML/SS/PL — must match attendance_logs.js's
// isOnLeave() regex exactly, or the employee silently stops being
// recognized as On Leave there (and gets counted as Absent instead).
function isOnLeave(emp) {
  const remarks = (emp._raw && emp._raw.remarks) || "";
  return remarks.trim().length > 0;
}

// Separated employees stay visible here (unlike INACTIVE, which is
// filtered out in loadEmployees) so HR can select them again for
// Mark Rehired without a separate lookup UI.
function isSeparated(emp) {
  const status = (emp._raw && emp._raw.employee_status) || "";
  return status.trim().toUpperCase() === "SEPARATED";
}

function render() {
  populateDepartmentFilter();
  const rows = getFilteredEmployees();

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const startIdx = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIdx, startIdx + pageSize);
  currentPageIds = pageRows.map(e => e.employee_id);

  if (pageRows.length === 0) {
    tableBody.innerHTML = `<tr class="empty-row"><td colspan="8">No employees match your search or filter</td></tr>`;
  } else {
tableBody.innerHTML = pageRows.map(emp => `
  <tr class="employee-row" data-view-id="${emp.employee_id}" tabindex="0">
    <td>
      <input type="checkbox" class="row-checkbox"
             data-id="${emp.employee_id}"
             ${selectedIds.has(emp.employee_id) ? "checked" : ""}>
    </td>
    <td><span class="id-chip">${emp.employee_id}</span></td>
    <td>
      <div class="name-cell">
        <span class="avatar">${getInitials(emp.name)}</span>
        <span>${emp.name}</span>
      </div>
    </td>
    <td class="dept-text">${emp.department || "-"}</td>
    <td class="dept-text">${emp.position || "-"}</td>
    <td class="dept-text">${emp.gender || "-"}</td>
    <td>
      <span class="shift-pill ${emp.shift}">
        <span class="dot"></span>${emp.shift === "night" ? "Night Shift" : "Day Shift"}
      </span>
      ${isOnLeave(emp) ? `<span class="leave-pill">ON LEAVE</span>` : ""}
      ${isSeparated(emp) ? `<span class="leave-pill" style="background:#fee2e2;color:#991b1b;">SEPARATED</span>` : ""}
    </td>
    <td>
      <button type="button" class="btn-edit" data-edit-id="${emp.employee_id}">Edit</button>
    </td>
  </tr>
`).join("");
  }

  renderPagination(rows.length, totalPages, startIdx, pageRows.length);

  updateStats();
  syncSelectAllState();
  syncBulkDeleteState();
}

// ---------------------------------------------------------
// Pagination footer: info text + page-size select + page buttons.
// ---------------------------------------------------------
function buildPageList(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push("...");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push("...");
  pages.push(total);
  return pages;
}

function renderPagination(totalFiltered, totalPages, startIdx, shownCount) {
  const from = totalFiltered ? startIdx + 1 : 0;
  const to = startIdx + shownCount;
  const filteredNote = totalFiltered !== employees.length
    ? ` (filtered from ${employees.length})` : "";
  const selectedNote = selectedIds.size ? ` · ${selectedIds.size} selected` : "";

  const pageBtn = (label, page, { disabled = false, active = false } = {}) =>
    `<button type="button" class="page-btn${active ? " active" : ""}" data-page="${page}" ${disabled ? "disabled" : ""}>${label}</button>`;

  const numberButtons = buildPageList(currentPage, totalPages).map(p =>
    p === "..." ? `<span class="page-ellipsis">&hellip;</span>`
                : pageBtn(p, p, { active: p === currentPage })
  ).join("");

  const sizeOptions = PAGE_SIZE_OPTIONS.map(n =>
    `<option value="${n}" ${n === pageSize ? "selected" : ""}>${n}</option>`
  ).join("");

  tableFoot.innerHTML = `
    <div class="pagination">
      <span class="page-info">Showing ${from}&ndash;${to} of ${totalFiltered} employees${filteredNote}${selectedNote}</span>
      <div class="pagination-controls">
        <label class="page-size">Rows
          <select id="pageSizeSelect">${sizeOptions}</select>
        </label>
        <div class="pager">
          ${pageBtn("&laquo;", 1, { disabled: currentPage <= 1 })}
          ${pageBtn("&lsaquo; Prev", currentPage - 1, { disabled: currentPage <= 1 })}
          ${numberButtons}
          ${pageBtn("Next &rsaquo;", currentPage + 1, { disabled: currentPage >= totalPages })}
          ${pageBtn("&raquo;", totalPages, { disabled: currentPage >= totalPages })}
        </div>
      </div>
    </div>`;
}

tableFoot.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn || btn.disabled) return;
  currentPage = Number(btn.dataset.page);
  render();
  tableBody.closest(".table-card").scrollIntoView({ behavior: "smooth", block: "start" });
});

tableFoot.addEventListener("change", (e) => {
  if (e.target.id !== "pageSizeSelect") return;
  pageSize = Number(e.target.value) || 25;
  currentPage = 1;
  render();
});

function updateStats() {
  totalCountEl.textContent = employees.length;
  dayCountEl.textContent   = employees.filter(e => e.shift === "day").length;
  nightCountEl.textContent = employees.filter(e => e.shift === "night").length;
  deptCountEl.textContent  = new Set(employees.map(e => e.department).filter(Boolean)).size;
}

// ---------------------------------------------------------
// Separated / Rehired count badges. The HTML template doesn't define
// these elements (same situation No Work was in), so they're injected
// as new stat cards cloned from the existing Dept count card -- cloning
// (rather than rebuilding the markup by hand) is what keeps the box
// size, font size, and font style identical to Total/Day/Night/Dept.
// Only the label text and the number are swapped inside the clone.
// ---------------------------------------------------------
let separatedCountEl = null;
let rehiredCountEl = null;

function buildStatusEventCard(newId, labelText) {
  const cardTemplate = deptCountEl.parentElement;
  const card = cardTemplate.cloneNode(true);
  card.removeAttribute("id");

  // The value element in the clone is whichever descendant carries the
  // same classes as deptCountEl (its original identity, minus the id
  // which cloneNode also copies and which we need to replace).
  const deptClasses = Array.from(deptCountEl.classList);
  const valueEl = deptClasses.length
    ? card.querySelector(`.${deptClasses.join(".")}`)
    : card.querySelector(`#${CSS.escape(deptCountEl.id)}`);

  if (!valueEl) {
    console.warn("buildStatusEventCard: could not locate value element in cloned card.");
    return { card, valueEl: null };
  }

  valueEl.removeAttribute("id");
  valueEl.id = newId;
  valueEl.textContent = "0";

  // The label is whatever sibling(s) in the card aren't the value element
  // -- update its text in place so its own classes (and thus font) stick.
  const labelEl = Array.from(card.querySelectorAll("*")).find(
    el => el !== valueEl && !el.contains(valueEl) && el.children.length === 0 && el.textContent.trim()
  );
  if (labelEl) labelEl.textContent = labelText;

  return { card, valueEl };
}

function ensureStatusEventBadges() {
  if (separatedCountEl && rehiredCountEl) return;
  if (!deptCountEl || !deptCountEl.parentElement) {
    console.warn("ensureStatusEventBadges: deptCountEl not found, skipping badge injection.");
    return;
  }

  const row = deptCountEl.parentElement.parentElement || deptCountEl.parentElement;

  const sep = buildStatusEventCard("separatedCount", "SEPARATED (MTD)");
  const reh = buildStatusEventCard("rehiredCount", "REHIRED (MTD)");

  separatedCountEl = sep.valueEl;
  rehiredCountEl = reh.valueEl;

  // Clickable, like a drill-down -- opens the paginated list for that
  // card's events. cursor + title are the only visual hint since we
  // don't have hover/focus styles from the real template to match.
  sep.card.style.cursor = "pointer";
  sep.card.title = "View separated employees";
  sep.card.addEventListener("click", () => openStatusEventListModal("separated"));

  reh.card.style.cursor = "pointer";
  reh.card.title = "View rehired employees";
  reh.card.addEventListener("click", () => openStatusEventListModal("rehired"));

  row.insertAdjacentElement("beforeend", sep.card);
  row.insertAdjacentElement("beforeend", reh.card);
}

async function fetchStatusEventsSummary() {
  ensureStatusEventBadges();
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    const start = monthStart.toISOString().slice(0, 10);
    const end = todayIso();

    const res = await fetch(`${STATUS_EVENTS_SUMMARY_URL}?start=${start}&end=${end}`);
    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
    const result = await res.json();

    if (separatedCountEl) separatedCountEl.textContent = result.separated_count ?? 0;
    if (rehiredCountEl) rehiredCountEl.textContent = result.rehired_count ?? 0;
  } catch (err) {
    console.error("fetchStatusEventsSummary failed:", err);
  }
}

// ---------------------------------------------------------
// Separated / Rehired list modal -- opened by clicking either stat
// card. Fetches the same month-to-date window the card counts, then
// paginates client-side (event volume here is small; no server-side
// paging needed).
// ---------------------------------------------------------
const STATUS_EVENTS_LIST_URL = "/api/status-events";
const STATUS_EVENTS_PAGE_SIZE = 10;
let statusEventsListState = { type: null, rows: [], page: 1 };

function ensureStatusEventListModal() {
  let el = document.getElementById("statusEventListModal");
  if (el) return el;

  el = document.createElement("div");
  el.id = "statusEventListModal";
  el.style.cssText = `
    display:none; position:fixed; inset:0; background:rgba(15,23,42,0.5);
    z-index:4000; align-items:center; justify-content:center;
  `;
  el.innerHTML = `
    <div style="background:white;border-radius:12px;padding:24px;max-width:680px;width:92%;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 id="statusEventListTitle" style="margin:0;"></h3>
        <button type="button" id="statusEventListCloseBtn" style="border:none;background:none;font-size:20px;cursor:pointer;line-height:1;color:#67718a;">&times;</button>
      </div>
      <div style="overflow-y:auto;flex:1;min-height:120px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;border-bottom:2px solid #e5e7eb;">
              <th style="padding:8px 6px;">Employee ID</th>
              <th style="padding:8px 6px;">Name</th>
              <th style="padding:8px 6px;">Date</th>
              <th style="padding:8px 6px;">Reason</th>
              <th style="padding:8px 6px;">By</th>
            </tr>
          </thead>
          <tbody id="statusEventListTbody"></tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid #e5e7eb;">
        <span id="statusEventListPageInfo" style="font-size:13px;color:#67718a;"></span>
        <div style="display:flex;gap:8px;">
          <button type="button" id="statusEventListPrevBtn" style="padding:6px 12px;border-radius:8px;border:1px solid #d1d5db;background:white;cursor:pointer;">Prev</button>
          <button type="button" id="statusEventListNextBtn" style="padding:6px 12px;border-radius:8px;border:1px solid #d1d5db;background:white;cursor:pointer;">Next</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  const closeFn = () => { el.style.display = "none"; };
  el.addEventListener("click", (e) => { if (e.target === el) closeFn(); });
  el.querySelector("#statusEventListCloseBtn").addEventListener("click", closeFn);
  el.querySelector("#statusEventListPrevBtn").addEventListener("click", () => {
    if (statusEventsListState.page > 1) {
      statusEventsListState.page -= 1;
      renderStatusEventListPage();
    }
  });
  el.querySelector("#statusEventListNextBtn").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(statusEventsListState.rows.length / STATUS_EVENTS_PAGE_SIZE));
    if (statusEventsListState.page < totalPages) {
      statusEventsListState.page += 1;
      renderStatusEventListPage();
    }
  });

  // Clicking an employee's name jumps to their row in the main table,
  // closing this modal in the process.
  el.querySelector("#statusEventListTbody").addEventListener("click", (e) => {
    const link = e.target.closest(".status-event-emp-link");
    if (!link) return;
    e.preventDefault();
    jumpToEmployeeInTable(link.dataset.empId);
  });

  return el;
}

// ---------------------------------------------------------
// Jumps from a Separated/Rehired list entry to that employee's row in
// the main Employee Management table: closes the status-event modal,
// clears any search/shift/agency filters that might be hiding the row
// (a separated employee could easily fall outside the current filter),
// re-renders, then scrolls to and briefly highlights the matching row.
// ---------------------------------------------------------
function jumpToEmployeeInTable(empId) {
  const modal = document.getElementById("statusEventListModal");
  if (modal) modal.style.display = "none";

  searchInput.value = "";
  activeShift = "all";
  activeAgency = "all";
  shiftSegmented.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.shift === "all")
  );
  agencySegmented.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.agency === "all")
  );
  activeDepartment = "all";
  departmentFilterSelect.value = "all";

  // The target row may be on any page -- find it and show that page.
  const idx = getFilteredEmployees().findIndex(e => e.employee_id === empId);
  currentPage = idx >= 0 ? Math.floor(idx / pageSize) + 1 : 1;
  render();

  requestAnimationFrame(() => {
    const row = tableBody.querySelector(`tr[data-view-id="${CSS.escape(empId)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });

    const originalBg = row.style.backgroundColor;
    row.style.transition = "background-color 0.3s ease";
    row.style.backgroundColor = "#fef9c3";
    setTimeout(() => {
      row.style.backgroundColor = originalBg;
    }, 1500);
  });
}

function renderStatusEventListPage() {
  const { rows, page } = statusEventsListState;
  const totalPages = Math.max(1, Math.ceil(rows.length / STATUS_EVENTS_PAGE_SIZE));
  const start = (page - 1) * STATUS_EVENTS_PAGE_SIZE;
  const pageRows = rows.slice(start, start + STATUS_EVENTS_PAGE_SIZE);

  const tbody = document.getElementById("statusEventListTbody");
  tbody.innerHTML = pageRows.length
    ? pageRows.map(r => `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:8px 6px;">${escapeHtml(r.emp_id)}</td>
        <td style="padding:8px 6px;">
          <a href="#" class="status-event-emp-link" data-emp-id="${escapeHtml(r.emp_id)}"
             style="color:#2563eb;text-decoration:none;cursor:pointer;">${escapeHtml(r.full_name || "-")}</a>
        </td>
        <td style="padding:8px 6px;">${escapeHtml(r.event_date)}</td>
        <td style="padding:8px 6px;">${escapeHtml(r.reason || "-")}</td>
        <td style="padding:8px 6px;">${escapeHtml(r.created_by || "-")}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="5" style="padding:16px 6px;text-align:center;color:#67718a;">No records for this period.</td></tr>`;

  document.getElementById("statusEventListPageInfo").textContent =
    rows.length ? `Page ${page} of ${totalPages} (${rows.length} total)` : "No records";

  document.getElementById("statusEventListPrevBtn").disabled = page <= 1;
  document.getElementById("statusEventListNextBtn").disabled = page >= totalPages;
}

async function openStatusEventListModal(type) {
  const modal = ensureStatusEventListModal();
  document.getElementById("statusEventListTitle").textContent =
    type === "separated" ? "Separated Employees (MTD)" : "Rehired Employees (MTD)";
  document.getElementById("statusEventListTbody").innerHTML =
    `<tr><td colspan="5" style="padding:16px 6px;text-align:center;color:#67718a;">Loading...</td></tr>`;
  document.getElementById("statusEventListPageInfo").textContent = "";
  modal.style.display = "flex";

  const monthStart = new Date();
  monthStart.setDate(1);
  const start = monthStart.toISOString().slice(0, 10);
  const end = todayIso();

  try {
    const res = await fetch(`${STATUS_EVENTS_LIST_URL}?type=${type}&start=${start}&end=${end}&current_only=true`);
    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
    const rows = await res.json();

    statusEventsListState = { type, rows: Array.isArray(rows) ? rows : [], page: 1 };
    renderStatusEventListPage();
  } catch (err) {
    console.error("openStatusEventListModal failed:", err);
    document.getElementById("statusEventListTbody").innerHTML =
      `<tr><td colspan="5" style="padding:16px 6px;text-align:center;color:#b91c1c;">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------
// Selection handling
// ---------------------------------------------------------
tableBody.addEventListener("change", (e) => {
  if (!e.target.classList.contains("row-checkbox")) return;
  if (!CAN_SELECT_ROWS) return;

  const id = e.target.dataset.id;
  if (e.target.checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }

  syncSelectAllState();
  syncBulkDeleteState();
});

const employeeDetailsOverlay = document.getElementById("employeeDetailsOverlay");
const employeeDetailsBody = document.getElementById("employeeDetailsBody");
const employeeDetailsTitle = document.getElementById("employeeDetailsTitle");

function escapeHtml(value) {
  return String(value ?? "-")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function openEmployeeDetails(employeeId) {
  const employee = employees.find(emp => emp.employee_id === employeeId);
  if (!employee) return;
  const raw = employee._raw || {};
  const agency = getAgencyFromId(employee.employee_id);
  // Tenure is always derived live from date_hired; the stored `tenure`
  // string (if any) is only used as a fallback for legacy records that
  // have no date_hired on file.
  const liveTenure = calculateTenure(raw.date_hired) || formatTenureDisplay(raw.tenure);
  const fields = [
    ["Employee ID", employee.employee_id], ["Agency", agency],
    ["Employee No.", raw.emp_no], ["Full Name", employee.name],
    ["Department", employee.department], ["Position", employee.position],
    ["Gender", employee.gender],
    ["Shift", raw.shift || (employee.shift === "night" ? "Night Shift" : "Day Shift")],
    ["Line", raw.line || "-"], ["Process / Section", raw.process],
    ["Date Hired", raw.date_hired], ["Tenure", liveTenure],
    ["Status", raw.employee_status || "ACTIVE"], ["Remarks", raw.remarks],
    ["Last Updated", raw.updated_at]
  ];
  employeeDetailsTitle.textContent = employee.name;
  employeeDetailsBody.innerHTML = fields.map(([label, value]) => `
    <div class="employee-detail-item"><span class="employee-detail-label">${escapeHtml(label)}</span>
    <span class="employee-detail-value">${escapeHtml(value || "-")}</span></div>`).join("");
  employeeDetailsOverlay.classList.add("open");
}

function closeEmployeeDetails() {
  employeeDetailsOverlay.classList.remove("open");
}

tableBody.addEventListener("click", (e) => {
  if (e.target.closest("input, button")) return;
  const row = e.target.closest("tr[data-view-id]");
  if (row) openEmployeeDetails(row.dataset.viewId);
});

tableBody.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest("tr[data-view-id]");
  if (!row) return;
  e.preventDefault();
  openEmployeeDetails(row.dataset.viewId);
});

document.getElementById("employeeDetailsCloseBtn").addEventListener("click", closeEmployeeDetails);
employeeDetailsOverlay.addEventListener("click", (e) => {
  if (e.target === employeeDetailsOverlay) closeEmployeeDetails();
});

selectAllCheckbox.addEventListener("change", () => {
  if (!CAN_SELECT_ROWS) return;

  const visibleIds = currentPageIds; // select-all applies to the current page only

  if (selectAllCheckbox.checked) {
    visibleIds.forEach(id => selectedIds.add(id));
  } else {
    visibleIds.forEach(id => selectedIds.delete(id));
  }

  render();
});

clearSelectionBtn.addEventListener("click", () => {
  selectedIds.clear();
  render();
});

function syncSelectAllState() {
  const visibleIds = currentPageIds; // select-all applies to the current page only
  selectAllCheckbox.checked =
    visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
}

function syncBulkDeleteState() {
  bulkDeleteBtn.disabled = selectedIds.size === 0;
  syncBulkLeaveState();
}

function syncBulkLeaveState() {
  bulkLeaveBtn.disabled = selectedIds.size === 0;
  bulkReturnBtn.disabled = selectedIds.size === 0;
}

// ---------------------------------------------------------
// Filters trigger re-render
// ---------------------------------------------------------
searchInput.addEventListener("input", () => {
  currentPage = 1;
  render();
});

shiftSegmented.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-shift]");
  if (!btn) return;

  activeShift = btn.dataset.shift;
  currentPage = 1;

  shiftSegmented.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b === btn)
  );

  render();
});

// ---------------------------------------------------------
// Bulk delete (soft delete → sets employee_status: INACTIVE)
//
// Gated on CAN_BULK_DELETE (Levels 2-4 / Admin), NOT on
// CAN_MANAGE_EMPLOYEES. Per the role spec, Level 1 (Line Leader) is
// STRICTLY blocked from this specific action — the button itself is
// already hidden for them via applyAccessControl(), and the real
// enforcement is server-side via bulk_delete_required on
// /api/employees/bulk-delete. This client-side check is a second,
// redundant guard only.
// ---------------------------------------------------------
bulkDeleteBtn.addEventListener("click", async () => {
  if (!CAN_BULK_DELETE) return;

  const employeeIds = Array.from(selectedIds);
  if (employeeIds.length === 0) return;

  const { isConfirmed } = await Swal.fire({
    icon: "warning",
    title: "Confirm Deletion",
    html: `Set <strong>${employeeIds.length}</strong> employee(s) to <strong>INACTIVE</strong>?<br>This cannot be undone here.`,
    showCancelButton: true,
    confirmButtonText: "Yes, Delete",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#d0261f",
    cancelButtonColor: "#67718a",
    reverseButtons: true
  });

  if (!isConfirmed) return;

  bulkDeleteBtn.disabled = true;
  setStatus(`Deleting ${employeeIds.length} employee(s)...`);

  Swal.fire({
    title: "Deleting employee(s)...",
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  const payload = {
    employee_ids: employeeIds
  };

  try {
    const res = await fetch(BULK_DELETE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    // A 403 here means the backend's bulk_delete_required decorator
    // rejected the request (e.g. session is LINE-level even though the
    // client-side flag said otherwise — stale session, tampered
    // localStorage, direct API call, etc). Surface it clearly instead
    // of falling through to the generic error handling below.
    if (res.status === 403) {
      const forbidden = await res.json().catch(() => ({}));
      Swal.fire({
        icon: "error",
        title: "Access Restricted",
        text: forbidden.message || "You are not authorized to perform bulk deletion.",
        confirmButtonColor: "#1d4fd8"
      });
      setStatus("Bulk delete blocked: insufficient permissions.", true);
      return;
    }

    if (!res.ok) {
      throw new Error(`Server responded with status ${res.status}`);
    }

    const result = await res.json();

    if (result.failures && result.failures.length > 0) {
      const failedIds = new Set(result.failures.map(f => f.emp_id));
      employeeIds.forEach(id => {
        if (!failedIds.has(id)) selectedIds.delete(id);
      });
      employees = employees.filter(emp => !employeeIds.includes(emp.employee_id) || failedIds.has(emp.employee_id));
      setStatus(`${result.deleted} deleted, ${result.failures.length} failed. Check console.`, true);
      console.warn("Bulk delete failures:", result.failures);

      Swal.fire({
        icon: "warning",
        title: "Partially Completed",
        html: `${result.deleted} employee(s) deleted successfully.<br>${result.failures.length} failed — check console for details.`,
        confirmButtonColor: "#1d4fd8"
      });

    } else {
      employees = employees.filter(emp => !employeeIds.includes(emp.employee_id));
      employeeIds.forEach(id => selectedIds.delete(id));
      setStatus(`${employeeIds.length} employee(s) deleted successfully.`);

      Swal.fire({
        icon: "success",
        title: "Employee(s) Deleted",
        text: `${employeeIds.length} employee(s) have been successfully removed.`,
        confirmButtonColor: "#1d4fd8",
        timer: 2500,
        timerProgressBar: true
      });
    }

    render();

  } catch (err) {
    console.error(err);
    setStatus(`Bulk delete failed: ${err.message}`, true);

    Swal.fire({
      icon: "error",
      title: "Delete Failed",
      text: `Could not delete employee(s): ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });

  } finally {
    syncBulkDeleteState();
  }
});

// ---------------------------------------------------------
// Mark as On Leave — opens a modal to collect leave TYPE (VL/SL/ML/
// SS/PL) + reason + optional expected return date, then sends all of
// it to the backend. The leave-type code is required and must be one
// of the five recognized codes, so the resulting remarks string always
// starts with a code attendance_logs.js's isOnLeave() regex can match
// (^(VL|SL|ML|SS|PL)(?:\s|-|$)) — otherwise the employee silently
// falls through to being counted as Absent instead of On Leave on the
// Attendance Logs dashboard.
// ---------------------------------------------------------
const leaveModal          = document.getElementById("leaveModalOverlay");
const leaveForm           = document.getElementById("leaveForm");
const leaveModalCloseBtn  = document.getElementById("leaveModalCloseBtn");
const leaveModalCancelBtn = document.getElementById("leaveModalCancelBtn");
const leaveTypeSelect     = document.getElementById("leaveType");

function openLeaveModal() {
  if (!CAN_MANAGE_EMPLOYEES) return;
  if (selectedIds.size === 0) return;
  leaveModal.classList.add("open");
}

function closeLeaveModal() {
  leaveModal.classList.remove("open");
  leaveForm.reset();
}

bulkLeaveBtn.addEventListener("click", openLeaveModal);
leaveModalCloseBtn.addEventListener("click", closeLeaveModal);
leaveModalCancelBtn.addEventListener("click", closeLeaveModal);

leaveModal.addEventListener("click", (e) => {
  if (e.target === leaveModal) closeLeaveModal();
});

leaveForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CAN_MANAGE_EMPLOYEES) return;

  const employeeIds = Array.from(selectedIds);
  if (employeeIds.length === 0) return;

  const formData = new FormData(leaveForm);
  const leaveType = (formData.get("leaveType") || "").trim().toUpperCase();
  const reason = (formData.get("reason") || "").trim();
  const leaveUntil = formData.get("leaveUntil") || "";

  if (!LEAVE_TYPE_CODES.has(leaveType)) {
    Swal.fire({
      icon: "warning",
      title: "Select a Leave Type",
      text: "Please choose one of VL, SL, ML, SS, or PL before continuing.",
      confirmButtonColor: "#1d4fd8"
    });
    return;
  }
  if (!reason) return;

  const { isConfirmed } = await Swal.fire({
    icon: "question",
    title: "Confirm Leave Status",
    html: `Mark <strong>${employeeIds.length}</strong> employee(s) as <strong>${escapeHtml(LEAVE_TYPE_LABELS[leaveType])}</strong>?<br>
           <span style="font-size:13px;color:#67718a;">Reason: ${escapeHtml(reason)}${leaveUntil ? `<br>Until: ${escapeHtml(leaveUntil)}` : ""}</span>`,
    showCancelButton: true,
    confirmButtonText: "Yes, Mark On Leave",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#1d4fd8",
    cancelButtonColor: "#67718a",
    reverseButtons: true
  });

  if (!isConfirmed) return;

  closeLeaveModal();
  setStatus(`Updating ${employeeIds.length} employee(s) to On Leave...`);

  Swal.fire({
    title: "Updating status...",
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const res = await fetch(LEAVE_STATUS_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employee_ids: employeeIds,
        leave_type: leaveType,
        reason: reason,
        leave_until: leaveUntil
      })
    });

    if (!res.ok) {
      throw new Error(`Server responded with status ${res.status}`);
    }

    const result = await res.json();

    if (result.success === false) {
      throw new Error(result.message || "Server rejected the request");
    }

    // Reflect in local state — backend stores this in employee_groupings.remarks,
    // which is what /api/data and attendance_logs.js's isOnLeave() derive
    // "on leave" status from. Always leads with the leave-type code so the
    // regex on the Attendance Logs dashboard matches.
    let remarksText = `${leaveType} | Reason: ${reason}`;
    if (leaveUntil) remarksText += ` | Until: ${leaveUntil}`;

    employeeIds.forEach(id => {
      const emp = employees.find(e => e.employee_id === id);
      if (emp) {
        emp._raw = emp._raw || {};
        emp._raw.remarks = remarksText;
      }
    });

    selectedIds.clear();
    setStatus(`${result.updated ?? employeeIds.length} employee(s) marked On Leave successfully.`);

    Swal.fire({
      icon: "success",
      title: "Employees Updated",
      text: `${result.updated ?? employeeIds.length} employee(s) marked as ${LEAVE_TYPE_LABELS[leaveType]}.`,
      confirmButtonColor: "#1d4fd8",
      timer: 2500,
      timerProgressBar: true
    });

    render();

  } catch (err) {
    console.error(err);
    setStatus(`Leave update failed: ${err.message}`, true);

    Swal.fire({
      icon: "error",
      title: "Update Failed",
      text: `Could not mark employee(s) as On Leave: ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });

  } finally {
    syncBulkLeaveState();
  }
});

// ---------------------------------------------------------
// Return to Work — clears leave status (remarks) so the
// employee shows as active again.
// ---------------------------------------------------------
bulkReturnBtn.addEventListener("click", async () => {
  if (!CAN_MANAGE_EMPLOYEES) return;

  const employeeIds = Array.from(selectedIds);
  if (employeeIds.length === 0) return;

  const { isConfirmed } = await Swal.fire({
    icon: "question",
    title: "Confirm Return to Work",
    html: `Mark <strong>${employeeIds.length}</strong> employee(s) as returned from leave?`,
    showCancelButton: true,
    confirmButtonText: "Yes, Mark Returned",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#1d4fd8",
    cancelButtonColor: "#67718a",
    reverseButtons: true
  });

  if (!isConfirmed) return;

  bulkReturnBtn.disabled = true;
  setStatus(`Updating ${employeeIds.length} employee(s)...`);

  Swal.fire({
    title: "Updating status...",
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const res = await fetch(RETURN_STATUS_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_ids: employeeIds })
    });

    if (!res.ok) {
      throw new Error(`Server responded with status ${res.status}`);
    }

    const result = await res.json();

    if (result.success === false) {
      throw new Error(result.message || "Server rejected the request");
    }

    employeeIds.forEach(id => {
      const emp = employees.find(e => e.employee_id === id);
      if (emp) {
        emp._raw = emp._raw || {};
        emp._raw.remarks = "";
      }
    });

    selectedIds.clear();
    setStatus(`${result.updated ?? employeeIds.length} employee(s) marked as returned.`);

    Swal.fire({
      icon: "success",
      title: "Employees Updated",
      text: `${result.updated ?? employeeIds.length} employee(s) back to work.`,
      confirmButtonColor: "#1d4fd8",
      timer: 2500,
      timerProgressBar: true
    });

    render();

  } catch (err) {
    console.error(err);
    setStatus(`Return update failed: ${err.message}`, true);

    Swal.fire({
      icon: "error",
      title: "Update Failed",
      text: `Could not update employee(s): ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });

  } finally {
    syncBulkLeaveState();
  }
});

// ---------------------------------------------------------
// No Work (today) — separate system from Leave. Backed by
// frontend.no_work_schedule via main.py/attendance.py's /api/no-work,
// not employee_groupings.remarks. Only per-employee declarations are
// tracked here (rows with a concrete emp_id); a line/shift-scoped
// declaration affects these employees on the dashboard (data.py) but
// has no single row to show/clear per-employee in this table.
//
// Gated on CAN_DECLARE_NO_WORK (Admin / HR-Administration / any
// Supervisor), NOT on CAN_MANAGE_EMPLOYEES — a Supervisor without full
// manage access can still use this feature.
// ---------------------------------------------------------
let noWorkTodayMap = new Map(); // employee_id -> no_work_schedule row id (today, per-employee rows only)

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isNoWorkToday(emp) {
  return noWorkTodayMap.has(emp.employee_id);
}

async function fetchNoWorkToday() {
  try {
    const res = await fetch(`${NO_WORK_URL}?date=${todayIso()}`);
    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
    const rows = await res.json();

    noWorkTodayMap = new Map(
      (Array.isArray(rows) ? rows : [])
        .filter(r => r.emp_id)
        .map(r => [r.emp_id, r.id])
    );
  } catch (err) {
    console.error("fetchNoWorkToday failed:", err);
    noWorkTodayMap = new Map();
  }
}

// Builds its own modal at runtime (same approach as modal.js's
// ensureSummaryModalContainer) since this page's HTML template doesn't
// define one — avoids depending on markup that isn't part of this file.
function ensureNoWorkModal() {
  let el = document.getElementById("noWorkModal");
  if (el) return el;

  el = document.createElement("div");
  el.id = "noWorkModal";
  el.style.cssText = `
    display:none; position:fixed; inset:0; background:rgba(15,23,42,0.5);
    z-index:4000; align-items:center; justify-content:center;
  `;
  el.innerHTML = `
    <div style="background:white;border-radius:12px;padding:24px;max-width:420px;width:90%;">
      <h3 style="margin:0 0 14px;">Mark No Work</h3>
      <form id="noWorkForm">
        <label style="display:block;font-weight:600;font-size:13px;margin-bottom:5px;">Date</label>
        <input type="date" name="workDate" required value="${todayIso()}"
               style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:12px;">
        <label style="display:block;font-weight:600;font-size:13px;margin-bottom:5px;">Reason</label>
        <input type="text" name="reason" placeholder="e.g. No orders / line shutdown"
               style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:16px;">
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="noWorkCancelBtn" style="padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:8px 14px;border-radius:8px;border:none;background:#1d4fd8;color:white;cursor:pointer;">Confirm</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(el);

  el.addEventListener("click", (e) => { if (e.target === el) closeNoWorkModal(); });
  el.querySelector("#noWorkCancelBtn").addEventListener("click", closeNoWorkModal);
  el.querySelector("#noWorkForm").addEventListener("submit", submitNoWork);

  return el;
}

function openNoWorkModal() {
  if (!CAN_DECLARE_NO_WORK) return;
  if (selectedIds.size === 0) return;
  ensureNoWorkModal().style.display = "flex";
}

function closeNoWorkModal() {
  const el = document.getElementById("noWorkModal");
  if (el) el.style.display = "none";
}

async function submitNoWork(e) {
  e.preventDefault();
  if (!CAN_DECLARE_NO_WORK) return;

  const employeeIds = Array.from(selectedIds);
  if (employeeIds.length === 0) return;

  const formData = new FormData(e.target);
  const workDate = formData.get("workDate");
  const reason = (formData.get("reason") || "").trim();
  if (!workDate) return;

  closeNoWorkModal();
  setStatus(`Marking ${employeeIds.length} employee(s) as No Work on ${workDate}...`);

  try {
    const res = await fetch(NO_WORK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ work_date: workDate, emp_ids: employeeIds, reason })
    });

    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
    const result = await res.json();
    if (result.success === false) throw new Error(result.message || "Server rejected the request");

    selectedIds.clear();
    setStatus(`${result.inserted ?? employeeIds.length} employee(s) marked No Work for ${workDate}.`);

    if (result.skipped_existing && result.skipped_existing.length) {
      Swal.fire({
        icon: "info",
        title: "Some already marked",
        text: `${result.skipped_existing.length} employee(s) were already marked No Work for that date and were skipped.`,
      });
    } else {
      Swal.fire({
        icon: "success",
        title: "No Work Recorded",
        text: `${result.inserted ?? employeeIds.length} employee(s) marked No Work for ${workDate}.`,
        confirmButtonColor: "#1d4fd8",
        timer: 2000,
        timerProgressBar: true
      });
    }

    if (workDate === todayIso()) await fetchNoWorkToday();
    render();

  } catch (err) {
    console.error(err);
    setStatus(`No Work update failed: ${err.message}`, true);
    Swal.fire({
      icon: "error",
      title: "Update Failed",
      text: `Could not mark employee(s) as No Work: ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });
  }
}

// Clears TODAY's per-employee No Work entries for whichever selected
// employees actually have one. Line/shift-scoped entries aren't
// per-employee rows, so they can't be individually cleared here --
// cancel those from wherever the scoped declaration was made instead.
async function clearNoWorkToday() {
  if (!CAN_DECLARE_NO_WORK) return;

  const employeeIds = Array.from(selectedIds).filter(id => noWorkTodayMap.has(id));
  if (employeeIds.length === 0) {
    Swal.fire("Nothing to clear", "None of the selected employees have a No Work entry for today.", "info");
    return;
  }

  const { isConfirmed } = await Swal.fire({
    icon: "question",
    title: "Clear No Work status?",
    html: `Remove today's No Work declaration for <strong>${employeeIds.length}</strong> employee(s)?`,
    showCancelButton: true,
    confirmButtonText: "Yes, Clear",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#1d4fd8",
    reverseButtons: true
  });
  if (!isConfirmed) return;

  setStatus(`Clearing No Work status for ${employeeIds.length} employee(s)...`);

  try {
    const results = await Promise.allSettled(
      employeeIds.map(id => fetch(`${NO_WORK_URL}/${noWorkTodayMap.get(id)}`, { method: "DELETE" }))
    );
    const failed = results.filter(r => r.status === "rejected").length;

    selectedIds.clear();
    await fetchNoWorkToday();
    render();

    setStatus(failed ? `Cleared with ${failed} failure(s).` : `Cleared No Work status for ${employeeIds.length} employee(s).`, !!failed);

  } catch (err) {
    console.error(err);
    setStatus(`Clear No Work failed: ${err.message}`, true);
  }
}

// Injects "Mark No Work" / "Clear No Work" buttons next to the existing
// Leave buttons, since the HTML template doesn't define them yet. Only
// injected at all when the current user actually has No Work access —
// a plain Viewer (or a Production/Quality/Technical non-Supervisor)
// should never even see these controls.
if (CAN_DECLARE_NO_WORK && bulkLeaveBtn && bulkLeaveBtn.parentElement) {
  const noWorkBtn = document.createElement("button");
  noWorkBtn.type = "button";
  noWorkBtn.id = "bulkNoWorkBtn";
  noWorkBtn.className = bulkLeaveBtn.className;
  noWorkBtn.textContent = "Mark No Work";
  noWorkBtn.addEventListener("click", openNoWorkModal);
  bulkLeaveBtn.insertAdjacentElement("afterend", noWorkBtn);

  const clearNoWorkBtn = document.createElement("button");
  clearNoWorkBtn.type = "button";
  clearNoWorkBtn.id = "bulkClearNoWorkBtn";
  clearNoWorkBtn.className = bulkLeaveBtn.className;
  clearNoWorkBtn.textContent = "Clear No Work";
  clearNoWorkBtn.addEventListener("click", clearNoWorkToday);
  noWorkBtn.insertAdjacentElement("afterend", clearNoWorkBtn);
}

// ---------------------------------------------------------
// Mark Separated / Mark Rehired -- logs an event to
// frontend.employee_status_events and flips employee_status. Built at
// runtime for the same reason as ensureNoWorkModal: this page's HTML
// template doesn't define these elements. Full-manage-only (HR/Admin),
// so still gated on CAN_MANAGE_EMPLOYEES throughout.
// ---------------------------------------------------------
function ensureStatusEventModal(kind) {
  // kind: "separate" | "rehire"
  const id = kind === "separate" ? "separateModal" : "rehireModal";
  let el = document.getElementById(id);
  if (el) return el;

  const title = kind === "separate" ? "Mark Separated" : "Mark Rehired";
  const confirmLabel = kind === "separate" ? "Confirm Separation" : "Confirm Rehire";
  const bypassField = kind === "rehire" ? `
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#67718a;margin-bottom:16px;">
          <input type="checkbox" name="bypassCooldown">
          Bypass duplicate-rehire cooldown (testing only)
        </label>` : "";

  el = document.createElement("div");
  el.id = id;
  el.style.cssText = `
    display:none; position:fixed; inset:0; background:rgba(15,23,42,0.5);
    z-index:4000; align-items:center; justify-content:center;
  `;
  el.innerHTML = `
    <div style="background:white;border-radius:12px;padding:24px;max-width:420px;width:90%;">
      <h3 style="margin:0 0 14px;">${title}</h3>
      <form id="${id}Form">
        <label style="display:block;font-weight:600;font-size:13px;margin-bottom:5px;">Effective Date</label>
        <input type="date" name="eventDate" required value="${todayIso()}"
               style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:12px;">
        <label style="display:block;font-weight:600;font-size:13px;margin-bottom:5px;">Reason</label>
        <input type="text" name="reason" placeholder="e.g. Resigned / End of contract" required
               style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:16px;">${bypassField}
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="${id}CancelBtn" style="padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:8px 14px;border-radius:8px;border:none;background:#1d4fd8;color:white;cursor:pointer;">${confirmLabel}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(el);

  const closeFn = () => { el.style.display = "none"; };
  el.addEventListener("click", (e) => { if (e.target === el) closeFn(); });
  el.querySelector(`#${id}CancelBtn`).addEventListener("click", closeFn);
  el.querySelector(`#${id}Form`).addEventListener("submit", (e) => submitStatusEvent(e, kind));

  return el;
}

function openStatusEventModal(kind) {
  if (!CAN_MANAGE_EMPLOYEES) return;
  if (selectedIds.size === 0) return;
  ensureStatusEventModal(kind).style.display = "flex";
}

function closeStatusEventModal(kind) {
  const id = kind === "separate" ? "separateModal" : "rehireModal";
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}

async function submitStatusEvent(e, kind) {
  e.preventDefault();
  if (!CAN_MANAGE_EMPLOYEES) return;

  const employeeIds = Array.from(selectedIds);
  if (employeeIds.length === 0) return;

  const formData = new FormData(e.target);
  const eventDate = formData.get("eventDate");
  const reason = (formData.get("reason") || "").trim();
  const bypassCooldown = formData.get("bypassCooldown") === "on";
  if (!eventDate || !reason) return;

  const url = kind === "separate" ? SEPARATE_URL : REHIRE_URL;
  const actionLabel = kind === "separate" ? "Separated" : "Rehired";
  const newStatus = kind === "separate" ? "SEPARATED" : "ACTIVE";

  closeStatusEventModal(kind);
  setStatus(`Marking ${employeeIds.length} employee(s) as ${actionLabel}...`);

  Swal.fire({
    title: `Updating status...`,
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const body = { employee_ids: employeeIds, event_date: eventDate, reason };
    if (kind === "rehire") body.bypass_cooldown = bypassCooldown;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
    const result = await res.json();
    if (result.success === false) throw new Error(result.message || "Server rejected the request");

    const succeededIds = employeeIds.filter(id =>
      !(result.failures || []).some(f => String(f.emp_id) === String(id))
    );

    succeededIds.forEach(id => {
      const emp = employees.find(e2 => e2.employee_id === id);
      if (emp) {
        emp._raw = emp._raw || {};
        emp._raw.employee_status = newStatus;
      }
    });

    selectedIds.clear();
    const failures = result.failures || [];
    setStatus(`${result.updated ?? succeededIds.length} employee(s) marked ${actionLabel}.` +
      (failures.length ? ` ${failures.length} skipped.` : ""), failures.length > 0 && !result.updated);

    if (failures.length === 0) {
      Swal.fire({
        icon: "success",
        title: "Employees Updated",
        text: `${result.updated ?? succeededIds.length} employee(s) marked ${actionLabel}.`,
        confirmButtonColor: "#1d4fd8",
        timer: 2500,
        timerProgressBar: true
      });
    } else {
      const list = failures.map(f => `<li><strong>${escapeHtml(String(f.emp_id))}</strong>: ${escapeHtml(f.reason || "unknown reason")}</li>`).join("");
      Swal.fire({
        icon: result.updated ? "warning" : "error",
        title: result.updated ? "Some Employees Skipped" : "No Employees Updated",
        html: `${result.updated ? `${result.updated} employee(s) marked ${actionLabel}.<br>` : ""}
               <div style="text-align:left;margin-top:8px;"><ul style="padding-left:18px;margin:0;">${list}</ul></div>`,
        confirmButtonColor: "#1d4fd8"
      });
    }

    render();
    fetchStatusEventsSummary();

  } catch (err) {
    console.error(err);
    setStatus(`${actionLabel} update failed: ${err.message}`, true);
    Swal.fire({
      icon: "error",
      title: "Update Failed",
      text: `Could not mark employee(s) as ${actionLabel}: ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });
  }
}

// Injects "Mark Separated" / "Mark Rehired" buttons next to the No Work
// buttons (if those exist), for the same reason those were injected: not
// in the template. Full-manage-only, so gated on CAN_MANAGE_EMPLOYEES —
// falls back to appending after bulkReturnBtn when the No Work buttons
// weren't injected (e.g. a full manager who, per current role rules,
// also always has No Work access — but this keeps the two features
// independent so a future role split still works).
if (CAN_MANAGE_EMPLOYEES) {
  const clearNoWorkBtnEl = document.getElementById("bulkClearNoWorkBtn");
  const anchorEl = clearNoWorkBtnEl || bulkReturnBtn;

  if (anchorEl && anchorEl.parentElement) {
    const separateBtn = document.createElement("button");
    separateBtn.type = "button";
    separateBtn.id = "bulkSeparateBtn";
    separateBtn.className = bulkLeaveBtn.className;
    separateBtn.textContent = "Mark Separated";
    separateBtn.addEventListener("click", () => openStatusEventModal("separate"));
    anchorEl.insertAdjacentElement("afterend", separateBtn);

    const rehireBtn = document.createElement("button");
    rehireBtn.type = "button";
    rehireBtn.id = "bulkRehireBtn";
    rehireBtn.className = bulkLeaveBtn.className;
    rehireBtn.textContent = "Mark Rehired";
    rehireBtn.addEventListener("click", () => openStatusEventModal("rehire"));
    separateBtn.insertAdjacentElement("afterend", rehireBtn);
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}
// ---------------------------------------------------------
// Add Employee modal
// ---------------------------------------------------------
const addEmployeeBtn    = document.getElementById("addEmployeeBtn");
const employeeModal     = document.getElementById("employeeModalOverlay");
const employeeForm      = document.getElementById("employeeForm");
const modalCloseBtn     = document.getElementById("modalCloseBtn");
const modalCancelBtn    = document.getElementById("modalCancelBtn");

// Auto-uppercase the free-text fields in the Add Employee form
attachUppercase(document.getElementById("empLastName"));
attachUppercase(document.getElementById("empFirstName"));
attachUppercase(document.getElementById("empDepartment"));
attachUppercase(document.getElementById("empPosition"));

// Department / Position are combo inputs: <input list="..."> shows a
// dropdown of the departments/positions that already exist in the
// roster, but the user can still type any new value manually.
const empDepartmentInput = document.getElementById("empDepartment");

function uniqueUpper(values) {
  return Array.from(new Set(
    values.map(v => (v || "").trim().toUpperCase()).filter(Boolean)
  )).sort();
}

function fillDatalist(id, values) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}"></option>`).join("");
}

// Once a department that already exists is chosen/typed, suggest the
// positions used in that department. For a brand-new department (or
// while it's empty) fall back to every known position.
function refreshPositionOptions() {
  const dept = empDepartmentInput.value.trim().toUpperCase();
  const inDept = dept
    ? employees.filter(e => (e.department || "").trim().toUpperCase() === dept)
    : [];
  const pool = inDept.length ? inDept : employees;
  fillDatalist("positionOptions", uniqueUpper(pool.map(e => e.position)));
}

function refreshDepartmentPositionOptions() {
  fillDatalist("departmentOptions", uniqueUpper(employees.map(e => e.department)));
  refreshPositionOptions();
}

empDepartmentInput.addEventListener("input", refreshPositionOptions);

// Tenure is read-only and auto-calculated from Date Hired.
const empDateHiredInput = document.getElementById("empDateHired");
const empTenureInput    = document.getElementById("empTenure");

// Gender field. Not defined in the HTML template (same situation as the
// Gender table column above), so it's inserted right after the Position
// input. Once the real template is updated with a proper <select
// id="empGender" name="gender">, this whole IIFE can just be deleted —
// getElementById below will pick up the real element instead.
let empGenderSelect = document.getElementById("empGender");
if (!empGenderSelect) {
  const positionInput = document.getElementById("empPosition");
  positionInput.insertAdjacentHTML("afterend", `
    <div class="form-group" style="margin-top:10px;">
      <label for="empGender">Gender</label>
      <select id="empGender" name="gender">
        <option value="">-- Select Gender --</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
      </select>
    </div>
  `);
  empGenderSelect = document.getElementById("empGender");
}

empDateHiredInput.addEventListener("input", () => {
  empTenureInput.value = calculateTenure(empDateHiredInput.value);
});

function openEmployeeModal() {
  if (!CAN_MANAGE_EMPLOYEES) return;
  refreshDepartmentPositionOptions();
  employeeModal.classList.add("open");
}

function closeEmployeeModal() {
  employeeModal.classList.remove("open");
  employeeForm.reset();
}

addEmployeeBtn.addEventListener("click", openEmployeeModal);
modalCloseBtn.addEventListener("click", closeEmployeeModal);
modalCancelBtn.addEventListener("click", closeEmployeeModal);

// Close on backdrop click (but not when clicking inside the card)
employeeModal.addEventListener("click", (e) => {
  if (e.target === employeeModal) closeEmployeeModal();
});

// ---------------------------------------------------------
// Build employee ID from agency + manually entered number
// ---------------------------------------------------------
function buildEmployeeId(agency, number) {
  const prefix = AGENCY_PREFIX_MAP[agency];
  const cleanNumber = number.trim();
  return prefix ? `${prefix}-${cleanNumber}` : cleanNumber;
}

// ---------------------------------------------------------
// Form submission → confirm → save to backend (add + audit
// are handled together server-side in /api/employees/add)
// ---------------------------------------------------------
employeeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CAN_MANAGE_EMPLOYEES) return;

  const formData = new FormData(employeeForm);
  const agency = formData.get("agency");
  const empNumber = formData.get("empNumber").trim();
  const employeeId = buildEmployeeId(agency, empNumber); // e.g. "N-7355" or "7355" for THN

  if (employees.some(emp => emp.employee_id === employeeId)) {
    Swal.fire({
      icon: "error",
      title: "Duplicate Employee ID",
      text: `Employee ID "${employeeId}" already exists. Please use a different number.`,
      confirmButtonColor: "#1d4fd8"
    });
    return;
  }

  const lastName = formData.get("lastName").trim();
  const firstName = formData.get("firstName").trim();
  const fullName = `${lastName}, ${firstName}`.trim();
  const department = formData.get("department").trim();
  const position = formData.get("position").trim();
  const dateHired = formData.get("dateHired") || null;
  // Tenure is always derived from dateHired — never read from the
  // (read-only) form field directly, so it can never drift or be typed.
  // `tenureDisplay` is for showing to the user; `tenure` is the decimal
  // number that actually gets sent to the backend (NUMERIC(10,2) column).
  const tenureDisplay = calculateTenure(dateHired) || null;
  const tenure = calculateTenureDecimal(dateHired);
  const shift = formData.get("shift"); // "day" | "night"
  const shiftLabel = shift === "night" ? "Night Shift" : "Day Shift";
  const gender = (formData.get("gender") || "").trim() || null;

  const { isConfirmed } = await Swal.fire({
    icon: "question",
    title: "Confirm New Employee",
    html: `
      <div style="text-align:left;font-size:14px;line-height:1.7;">
        <strong>Employee ID:</strong> ${employeeId}<br>
        <strong>Name:</strong> ${fullName}<br>
        <strong>Department:</strong> ${department}<br>
        <strong>Position:</strong> ${position}<br>
        <strong>Gender:</strong> ${gender || "-"}<br>
        <strong>Date Hired:</strong> ${dateHired || "-"}<br>
        <strong>Tenure:</strong> ${tenureDisplay || "-"}<br>
        <strong>Shift:</strong> ${shiftLabel}
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: "Confirm & Save",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#1d4fd8",
    cancelButtonColor: "#67718a",
    reverseButtons: true
  });

  if (!isConfirmed) return;

  Swal.fire({
    title: "Saving employee...",
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  // Field names matched exactly to /api/employees/add in employees.py
  const payload = {
    emp_id: employeeId,
    emp_no: empNumber,
    last_name: lastName,
    first_name: firstName,
    full_name: fullName,
    department: department,
    position: position,
    line_name: null,   // mirrors `line` — no line is assigned at creation
    line: null,
    shift: shiftLabel,       // "Day Shift" / "Night Shift"
    process: position,       // "Position" field maps to process
    date_hired: dateHired,
    tenure: tenure,
    gender: gender
  };

  try {
    const res = await fetch(EMPLOYEE_ADD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await res.json().catch(() => ({}));

    if (!res.ok || result.success === false) {
      throw new Error(result.message || `Server responded with status ${res.status}`);
    }

    // Reflect in local state so the table updates immediately.
    // `_raw` mirrors what we just sent, so that a later Edit (which
    // preserves line/line_name/process/date_hired/tenure from `_raw`)
    // has something sensible to preserve.
    const newEmployee = {
      employee_id: employeeId,
      name: fullName,
      department: department,
      position: position,
      gender: gender,
      shift: shift,
      employee_status: "ACTIVE",
      _raw: {
        emp_id: employeeId,
        emp_no: empNumber,
        last_name: lastName,
        first_name: firstName,
        full_name: fullName,
        department: department,
        position: position,
        line_name: null,
        line: null,
        shift: shiftLabel,
        process: position,
        date_hired: dateHired,
        tenure: tenure,
        gender: gender,
        employee_status: "ACTIVE",
        remarks: ""
      }
    };
    employees.push(newEmployee);

    closeEmployeeModal();
    render();

    Swal.fire({
      icon: "success",
      title: "Employee Added",
      text: `${newEmployee.name} has been added successfully.`,
      confirmButtonColor: "#1d4fd8",
      timer: 2500,
      timerProgressBar: true
    });

  } catch (err) {
    console.error(err);
    Swal.fire({
      icon: "error",
      title: "Save Failed",
      text: `Could not save employee: ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });
  }
});
// ---------------------------------------------------------
// Edit Employee modal
// ---------------------------------------------------------
const EMPLOYEE_UPDATE_URL = "/api/employees/update";

const editEmployeeBtnRefs   = null; // not a static ref — buttons are dynamic, handled via delegation
const editModal             = document.getElementById("editEmployeeModalOverlay");
const editEmployeeForm      = document.getElementById("editEmployeeForm");
const editModalCloseBtn     = document.getElementById("editModalCloseBtn");
const editModalCancelBtn    = document.getElementById("editModalCancelBtn");

const editEmpIdInput      = document.getElementById("editEmpId");
const editLastNameInput   = document.getElementById("editLastName");
const editFirstNameInput  = document.getElementById("editFirstName");
const editDepartmentInput = document.getElementById("editDepartment");
const editPositionInput   = document.getElementById("editPosition");
const editDateHiredInput  = document.getElementById("editDateHired");
const editTenureInput     = document.getElementById("editTenure");

// Gender field — not defined in the HTML template, so it's inserted
// right after Position, same as empGenderSelect above. Delete this IIFE
// once a real <select id="editGender" name="gender"> exists in the
// template.
let editGenderSelect = document.getElementById("editGender");
if (!editGenderSelect) {
  editPositionInput.insertAdjacentHTML("afterend", `
    <div class="form-group" style="margin-top:10px;">
      <label for="editGender">Gender</label>
      <select id="editGender" name="gender">
        <option value="">-- Select Gender --</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
      </select>
    </div>
  `);
  editGenderSelect = document.getElementById("editGender");
}

// NEW — Production Line selector shown/hidden based on department
const editLineGroup  = document.getElementById("editLineGroup");
const editLineSelect = document.getElementById("editLine");

// Auto-uppercase the editable free-text fields in the Edit Employee form.
// Department/Position are now editable too (previously disabled, which
// meant a null value could never be filled in from this modal).
attachUppercase(editLastNameInput);
attachUppercase(editFirstNameInput);
attachUppercase(editDepartmentInput);
attachUppercase(editPositionInput);

// Tenure is read-only and auto-calculated from Date Hired.
editDateHiredInput.addEventListener("input", () => {
  editTenureInput.value = calculateTenure(editDateHiredInput.value);
});

let currentEditEmployeeId = null; // tracks which employee is being edited

// ---------------------------------------------------------
// Production Line helpers
// ---------------------------------------------------------

// ADMIN-department employees aren't assigned to a production line,
// so the line selector is hidden and skipped for them.
function isAdminDepartment(value) {
  return (value || "").trim().toUpperCase() === "ADMIN";
}

// Collect distinct line values already in use across the roster.
// IMPORTANT: only reads `_raw.line` — NOT `_raw.line_name`. The
// `line_name` column is a separate field that this app overwrites
// with the Department value on every save (see payload below), so
// falling back to it here would leak department text into the line
// list and create phantom "duplicate" lines.
function getUniqueLines() {
  const lines = employees
    .map(e => (e._raw && e._raw.line) || "")
    .map(v => String(v).trim())
    .filter(Boolean);
  return Array.from(new Set(lines)).sort();
}

// Rebuild the <select> options, preserving/pre-selecting whatever
// line the employee currently has (even if it's not in the list yet).
function populateLineOptions(selectedValue) {
  const lines = getUniqueLines();
  editLineSelect.innerHTML = `<option value="">-- Select Line --</option>` +
    lines.map(line => `<option value="${escapeHtml(line)}">${escapeHtml(line)}</option>`).join("");

  if (selectedValue && !lines.includes(selectedValue)) {
    editLineSelect.insertAdjacentHTML(
      "beforeend",
      `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)}</option>`
    );
  }
  editLineSelect.value = selectedValue || "";
}

// Show/hide the line field based on the current Department value.
// ADMIN employees have the field hidden and its value cleared so it
// never gets submitted for them.
function updateLineFieldVisibility() {
  const admin = isAdminDepartment(editDepartmentInput.value);
  editLineGroup.style.display = admin ? "none" : "";
  if (admin) editLineSelect.value = "";
}

editDepartmentInput.addEventListener("input", updateLineFieldVisibility);

function openEditModal(employeeId) {
  if (!CAN_MANAGE_EMPLOYEES) return;

  const emp = employees.find(e => e.employee_id === employeeId);
  if (!emp) return;

  currentEditEmployeeId = employeeId;

  // Split "Last, First" back into two fields for editing
  const [lastName = "", firstName = ""] = emp.name.split(",").map(s => s.trim());

  editEmpIdInput.value = emp.employee_id;
  editLastNameInput.value = lastName;
  editFirstNameInput.value = firstName;

  // Department/Position are now editable — pre-fill with whatever we
  // have (falls back to line_name/process, same as the table display),
  // so a previously-null value just shows blank and can be typed in.
  editDepartmentInput.value = emp.department || "";
  editPositionInput.value = emp.position || "";
  editGenderSelect.value = emp.gender || "";

  const raw = emp._raw || {};
  editDateHiredInput.value = toDateInputValue(raw.date_hired);
  // Tenure is derived live from date_hired; fall back to the stored
  // string only for legacy records that have no date_hired on file.
  editTenureInput.value = calculateTenure(editDateHiredInput.value) || formatTenureDisplay(raw.tenure) || "";

  // NEW — populate the line dropdown with the employee's current line
  // (or blank), then show/hide it depending on whether they're ADMIN.
  // Only `raw.line` is used here (not `line_name`) — see getUniqueLines().
  populateLineOptions(raw.line || "");
  updateLineFieldVisibility();

  editEmployeeForm.querySelector(`input[name="editShift"][value="${emp.shift}"]`).checked = true;

  editModal.classList.add("open");
}

function closeEditModal() {
  editModal.classList.remove("open");
  editEmployeeForm.reset();
  currentEditEmployeeId = null;
}

// Delegate clicks on dynamically-rendered Edit buttons
tableBody.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-edit-id]");
  if (!btn) return;
  openEditModal(btn.dataset.editId);
});

editModalCloseBtn.addEventListener("click", closeEditModal);
editModalCancelBtn.addEventListener("click", closeEditModal);

editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEditModal();
});

editEmployeeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CAN_MANAGE_EMPLOYEES) return;

  if (!currentEditEmployeeId) return;

  const emp = employees.find(e => e.employee_id === currentEditEmployeeId);
  if (!emp) return;

  const formData = new FormData(editEmployeeForm);
  const lastName = formData.get("lastName").trim();
  const firstName = formData.get("firstName").trim();
  const fullName = `${lastName}, ${firstName}`.trim();
  const department = formData.get("department").trim();
  const position = formData.get("position").trim();
  const gender = (formData.get("gender") || "").trim() || null;
  const admin = isAdminDepartment(department);
  // NEW — ADMIN employees never carry a line value, even if one
  // happened to be selected before the department was changed.
  const lineValue = admin ? null : ((editLineSelect.value || "").trim() || null);
  const dateHired = formData.get("dateHired") || null;
  // Tenure is always derived from dateHired — never read from the
  // (read-only) form field directly, so it can never drift or be typed.
  // `tenureDisplay` is for the confirmation dialog; `tenure` is the
  // decimal number that actually gets sent to the backend (the DB
  // column is NUMERIC(10,2), so a formatted string like "6 yrs 5 mos"
  // fails there).
  const tenureDisplay = calculateTenure(dateHired) || null;
  const tenure = calculateTenureDecimal(dateHired);
  const shift = formData.get("editShift");
  const shiftLabel = shift === "night" ? "Night Shift" : "Day Shift";

  const { isConfirmed } = await Swal.fire({
    icon: "question",
    title: "Confirm Changes",
    html: `
      <div style="text-align:left;font-size:14px;line-height:1.7;">
        <strong>Employee ID:</strong> ${currentEditEmployeeId}<br>
        <strong>Name:</strong> ${fullName}<br>
        <strong>Department:</strong> ${department || "-"}<br>
        <strong>Position:</strong> ${position || "-"}<br>
        <strong>Gender:</strong> ${gender || "-"}<br>
        <strong>Line:</strong> ${admin ? "N/A (Admin)" : (lineValue || "-")}<br>
        <strong>Date Hired:</strong> ${dateHired || "-"}<br>
        <strong>Tenure:</strong> ${tenureDisplay || "-"}<br>
        <strong>Shift:</strong> ${shiftLabel}
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: "Save Changes",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#1d4fd8",
    cancelButtonColor: "#67718a",
    reverseButtons: true
  });

  if (!isConfirmed) return;

  Swal.fire({
    title: "Saving changes...",
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  const payload = {
    emp_id: currentEditEmployeeId,
    last_name: lastName,
    first_name: firstName,
    full_name: fullName,
    department: department,
    position: position,
    shift: shiftLabel,
    process: position,
    date_hired: dateHired,
    tenure: tenure,
    gender: gender,
    line: lineValue,      // production line selected in the dropdown; null for ADMIN
    line_name: lineValue  // mirrors `line` — must always match, never department
  };

  try {
    const res = await fetch(EMPLOYEE_UPDATE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await res.json().catch(() => ({}));

    if (!res.ok || result.success === false) {
      throw new Error(result.message || `Server responded with status ${res.status}`);
    }

    // Update local state to match what we just saved
    emp.name = fullName;
    emp.shift = shift;
    emp.department = department;
    emp.position = position;
    emp.gender = gender;
    emp._raw = emp._raw || {};
    emp._raw.department = department;
    emp._raw.position = position;
    emp._raw.gender = gender;
    emp._raw.line_name = lineValue;
    emp._raw.process = position;
    emp._raw.date_hired = dateHired;
    emp._raw.tenure = tenure;
    emp._raw.shift = shiftLabel;
    emp._raw.line = lineValue;   // NEW — keep local state in sync

    closeEditModal();
    render();

    Swal.fire({
      icon: "success",
      title: "Employee Updated",
      text: `${fullName} has been updated successfully.`,
      confirmButtonColor: "#1d4fd8",
      timer: 2500,
      timerProgressBar: true
    });

  } catch (err) {
    console.error(err);
    Swal.fire({
      icon: "error",
      title: "Update Failed",
      text: `Could not update employee: ${err.message}`,
      confirmButtonColor: "#1d4fd8"
    });
  }
});
function getAgencyFromId(employeeId) {
  if (employeeId.startsWith("C")) return "CCI";
  if (employeeId.startsWith("N")) return "NATCORP";
  if (employeeId.startsWith("E")) return "EMIS";
  return "THN";
}
// ---------------------------------------------------------
// Init
// ---------------------------------------------------------
applyAccessControl();
loadEmployees();
fetchStatusEventsSummary();