// ─────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────
// Wires every module together and exposes the functions referenced by
// inline onclick/onchange/ondrop attributes in generated HTML onto
// `window`, since module-scoped functions are not globally visible.
//
// Load this as: <script type="module" src="/js/main.js"></script>
import { getCurrentUser } from "./modules/api.js";
import { state } from "./modules/state.js";
import { load } from "./modules/loader.js";
import { render, renderEmployees, populateLineFilter, loadAttendanceValidation, renderTransferToolbar } from "./modules/render.js";
import {
    changePage, toggleTransferMode, toggleEmployee, askSection,
    removeEmp, toggleTransferEmpCheckbox, filterTransferEmployeeList,
    closeTransferModal, confirmTransferExecute
} from "./modules/employees.js";
import { openModal, closeModal, renderEmployeeList, filterEmployees, toggleModalEmployee, assignSelected } from "./modules/modal.js";
import {
    resetGroup, saveGroup, addNewLine, updateGroupName,
    filterLines, filterShift, toggleDepartmentView
} from "./modules/groups.js";
import { dragEmployee, allowDrop, dragEnter, dragLeave, dropEmployee, dropToUnassigned } from "./modules/dragdrop.js";
import { globalSearch, selectEmployee, showEmployeeHistory } from "./modules/search.js";
import { importExcel, uploadExcel, loadBatchList, viewImportLogs } from "./modules/import.js";
import { updatePHTime, fetchAttendanceStatus } from "./modules/attendance.js";
import { viewLineSummary, closeSummaryModal } from "./modules/modal.js";

const DASHBOARD_REFRESH_MS = 60_000;

// ─────────────────────────────────────────
// EXPOSE TO WINDOW
// ─────────────────────────────────────────
// Every one of these is referenced from a string built in render.js,
// e.g. onclick="saveGroup(${g.id})". They must exist as window properties
// for the browser's inline event-attribute parser to find them.
Object.assign(window, {
    // render / paging
    changePage,
    // transfer (Manage Manpower button opens the transfer modal directly)
    toggleTransferMode, toggleEmployee,
    toggleTransferEmpCheckbox, filterTransferEmployeeList,
    closeTransferModal, confirmTransferExecute,
    // modal (assign from unassigned)
    openModal, closeModal, filterEmployees, toggleModalEmployee, assignSelected,
    // group ops
    resetGroup, saveGroup, addNewLine, updateGroupName,
    filterLines, filterShift,
    // department filter
    toggleDepartmentView,
    // employees
    removeEmp,
    // drag & drop
    dragEmployee, allowDrop, dragEnter, dragLeave, dropEmployee, dropToUnassigned,
    // search / history
    globalSearch, selectEmployee, showEmployeeHistory,
    // import
    importExcel, uploadExcel, viewImportLogs,
});
window.state = state;
window.viewLineSummary = viewLineSummary;
window.closeSummaryModal = closeSummaryModal;

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
// Everything that depends on knowing who's logged in (access scoping in
// render.js via state.currentUser, plus the role-based UI locks below)
// now waits on getCurrentUser() before load()/render() ever runs — this
// replaces the old fire-and-forget DOMContentLoaded handler, which fetched
// the user but never stored it on `state`, and never blocked `load()` from
// running first.
document.addEventListener("DOMContentLoaded", async () => {
    try {
        state.currentUser = await getCurrentUser();
    } catch (err) {
        console.error("Failed to load current user:", err);
        state.currentUser = null; // unscoped fallback — see note below
    }

    const user = state.currentUser;

    if (user) {
        if (!["Admin", "Supervisor"].includes(user.role)) {
            document.querySelector(".btn-import").disabled = true;
        }
        if (user.role === "Viewer") {
            document.querySelector(".btn-transfer").disabled = true;
        }
    }

    setInterval(updatePHTime, 1000);
    updatePHTime();
    setInterval(() => {
        // A hidden tab cannot be observed, so don't repeatedly fetch and
        // render the complete roster in the background. Visibility handling
        // below refreshes it as soon as the user returns.
        if (!document.hidden && !state.localUpdate) load();
    }, DASHBOARD_REFRESH_MS);
    loadBatchList();
    load();
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.localUpdate) {
        load();
    }
});