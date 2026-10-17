// ─────────────────────────────────────────
// EMPLOYEE SELECTION / TRANSFER
// ─────────────────────────────────────────

import { state, SECTIONS } from "./state.js";
import { fetchAllLines, manualMoveEmployee, removeEmployee } from "./api.js";
import { render, renderTransferToolbar, classifyDepartment } from "./render.js";
import { load } from "./loader.js";

// ── Performance caches / constants ──────────────────────────
const MAX_RENDER = 200;          // max rows rendered in the employee list at once
const SEARCH_DEBOUNCE_MS = 150;  // delay before search filter runs

let cachedLines = null;          // destination lines (fetched once, reused)
let employeeCache = null;        // sorted employee list for the modal
let employeeDeptById = null;     // Map(id -> department) built once per cache
let searchTimer = null;

function invalidateEmployeeCache() {
    employeeCache = null;
    employeeDeptById = null;
}

export function changePage(groupId, direction) {
    if (!state.currentPages[groupId]) state.currentPages[groupId] = 1;
    state.currentPages[groupId] += direction;
    if (state.currentPages[groupId] < 1) state.currentPages[groupId] = 1;
    render();
}

// Kept for backward compatibility — render.js's card-level checkbox path
// (state.transferMode) is no longer entered since toggleTransferMode()
// now opens the modal directly instead of flipping state.transferMode,
// but this stays defined so nothing throws if that legacy path is ever
// re-enabled or still referenced elsewhere.
export function toggleEmployee(empId) {
    const index = state.selectedEmployees.indexOf(empId);
    if (index >= 0) {
        state.selectedEmployees.splice(index, 1);
    } else {
        state.selectedEmployees.push(empId);
    }
    renderTransferToolbar();

    document.querySelectorAll(".emp").forEach(el => {
        const cb = el.querySelector("input[type=checkbox]");
        if (!cb) return;
        const id = cb.getAttribute("onchange")?.match(/'([^']+)'/)?.[1];
        if (!id) return;
        const isSelected = state.selectedEmployees.includes(id);
        cb.checked = isSelected;
        el.classList.toggle("emp-selected", isSelected);
    });
}

// ─────────────────────────────────────────
// TRANSFER MODAL (single-screen: employees + destination)
// ─────────────────────────────────────────
// "Manage Manpower" button now opens one modal directly instead of
// entering a per-card checkbox "transfer mode" + bottom toolbar.

export function toggleTransferMode() {
    openTransferSelectionModal();
}

// Gather every employee across all groups + unassigned, tagged with
// their current line/shift so the modal can show where they are now.
// Result is cached — reset when the modal opens/closes.
function gatherAllEmployeesForTransfer() {
    if (employeeCache) return employeeCache;

    const list = [];
    (state.data.groups || []).forEach(g => {
        (g.employees || []).forEach(e => {
            list.push({
                id: e.id,
                name: e.name,
                currentLine: g.line_name,
                currentShift: g.shift,
                department: classifyDepartment(e.department)
            });
        });
    });
    (state.data.unassigned || []).forEach(e => {
        list.push({
            id: e.id,
            name: e.name,
            currentLine: "Unassigned",
            currentShift: "",
            department: classifyDepartment(e.department)
        });
    });

    employeeCache = list.sort((a, b) => a.name.localeCompare(b.name));
    employeeDeptById = new Map(employeeCache.map(e => [e.id, e.department]));
    return employeeCache;
}

function renderTransferEmployeeList(list) {
    const container = document.getElementById("transferEmployeeList");
    if (!container) return;

    if (!list.length) {
        container.innerHTML = `<div style="color:#94a3b8;font-size:12px;text-align:center;padding:10px;">No employees found</div>`;
        return;
    }

    const visible = list.slice(0, MAX_RENDER);
    const selected = new Set(state.selectedEmployees);

    let html = visible.map(e => `
        <label style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 4px;cursor:pointer;border-bottom:1px solid #f1f5f9;">
            <span style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" value="${e.id}"
                       ${selected.has(e.id) ? "checked" : ""}
                       onchange="toggleTransferEmpCheckbox('${e.id}', this.checked)">
                ${e.name}
            </span>
            <span style="font-size:11px;color:#94a3b8;">${e.currentLine}${e.currentShift ? ` (${e.currentShift})` : ""}</span>
        </label>
    `).join("");

    if (list.length > MAX_RENDER) {
        html += `<div style="color:#94a3b8;font-size:11px;text-align:center;padding:8px;">
            Showing ${MAX_RENDER} of ${list.length} — use the search box to narrow down.
        </div>`;
    }

    container.innerHTML = html;
}

export function toggleTransferEmpCheckbox(empId, checked) {
    if (checked) {
        if (!state.selectedEmployees.includes(empId)) state.selectedEmployees.push(empId);
    } else {
        state.selectedEmployees = state.selectedEmployees.filter(id => id !== empId);
    }
    populateTransferSectionDropdown();
}

// Debounced so we don't rebuild the list on every keystroke.
export function filterTransferEmployeeList(value) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        const all = gatherAllEmployeesForTransfer();
        const q = (value || "").trim().toLowerCase();
        renderTransferEmployeeList(q ? all.filter(e => e.name.toLowerCase().includes(q)) : all);
    }, SEARCH_DEBOUNCE_MS);
}

// Section dropdown rules (Manage Manpower):
//   options = sections from the imported Excel data that exist
//             (a) on the selected DESTINATION LINE, and
//             (b) among employees of the same DEPARTMENT as the
//                 employee(s) being transferred.
// Recomputed whenever the line or the checked employees change.
function getSelectedDepartments() {
    gatherAllEmployeesForTransfer(); // ensures employeeDeptById is built
    const byId = employeeDeptById;
    return new Set(state.selectedEmployees.map(id => byId.get(id)).filter(Boolean));
}

function findDestinationGroups(lineVal) {
    const [line, lineName, shift] = lineVal.split("||");
    const groups = state.data.groups || [];

    let matched = groups.filter(g => g.line_name === lineName && (g.shift || "") === (shift || ""));
    if (!matched.length) {
        // Fallback: match by line number (e.g. "LINE 11") + shift
        const key = s => ((s || "").match(/line\s*(\d+)/i) || [])[1];
        const wanted = key(line) || key(lineName);
        matched = wanted
            ? groups.filter(g => key(g.line_name) === wanted && (g.shift || "") === (shift || ""))
            : [];
    }
    return matched;
}

function gatherSectionsForTransfer(lineVal, departments) {
    const found = new Set();
    findDestinationGroups(lineVal).forEach(g => {
        (g.employees || []).forEach(e => {
            if (!departments.has(classifyDepartment(e.department))) return;
            const sec = (e.section || "").trim().toUpperCase();
            if (sec && sec !== "UNASSIGNED SECTION" && sec !== "UNASSIGNED") found.add(sec);
        });
    });

    const known = SECTIONS.filter(s => found.has(s));
    const others = [...found].filter(s => !SECTIONS.includes(s)).sort((a, b) => a.localeCompare(b));
    return [...known, ...others];
}

export function populateTransferSectionDropdown() {
    const select = document.getElementById("transferNewSection");
    if (!select) return;

    const lineVal = document.getElementById("transferLineSelect")?.value || "";
    const departments = getSelectedDepartments();
    const previous = select.value;

    if (!lineVal || departments.size === 0) {
        select.innerHTML = `<option value="">-- Select employee(s) & destination line first --</option>`;
        return;
    }

    const sections = gatherSectionsForTransfer(lineVal, departments);
    select.innerHTML = sections.length
        ? `<option value="">-- Select Section / Process --</option>` +
          sections.map(s => `<option value="${s}">${s}</option>`).join("")
        : `<option value="">-- No section for this department on this line --</option>`;

    if (previous && sections.includes(previous)) select.value = previous;
}

// ── Destination line loading (non-blocking + cached) ────────
function renderLineOptions(lineSelect, lines) {
    lineSelect.innerHTML = `<option value="">-- Select Line --</option>` +
        lines.map(l => `<option value="${l.line}||${l.line_name}||${l.shift}">${l.line}</option>`).join("");
}

async function loadTransferLines(lineSelect) {
    if (cachedLines) {
        renderLineOptions(lineSelect, cachedLines);
        return;
    }

    lineSelect.innerHTML = `<option value="">Loading...</option>`;
    try {
        cachedLines = await fetchAllLines();
        renderLineOptions(lineSelect, cachedLines);
    } catch (e) {
        console.error(e);
        lineSelect.innerHTML = `<option value="">-- Failed to load lines --</option>`;
    }
}

// Opens the modal immediately; lines load in the background.
export function openTransferSelectionModal() {
    state.selectedEmployees = [];
    invalidateEmployeeCache(); // always start from fresh state.data

    const lineSelect = document.getElementById("transferLineSelect");
    lineSelect.onchange = populateTransferSectionDropdown;

    populateTransferSectionDropdown();
    document.getElementById("transferEmpSearch").value = "";

    // Show the modal right away — don't wait for the network
    document.getElementById("transferModal").style.display = "block";

    // Employee list (built once, cached)
    renderTransferEmployeeList(gatherAllEmployeesForTransfer());

    // Fire and forget — fills the "Line" dropdown when ready
    loadTransferLines(lineSelect);
}

export function closeTransferModal() {
    clearTimeout(searchTimer);
    const el = document.getElementById("transferModal");
    if (el) el.style.display = "none";
    state.selectedEmployees = [];
    invalidateEmployeeCache();
}

export async function confirmTransferExecute() {
    if (state.selectedEmployees.length === 0) {
        Swal.fire("No employees selected", "Please check at least one employee.", "info");
        return;
    }

    const lineVal = document.getElementById("transferLineSelect").value;
    if (!lineVal) { Swal.fire("Missing line", "Please select a destination line.", "info"); return; }
    const [finalLine, finalLineName, finalShift] = lineVal.split("||");

    const section = document.getElementById("transferNewSection").value.trim().toUpperCase();
    if (!section) { Swal.fire("Missing section", "Please select a section/process.", "info"); return; }
    if (!SECTIONS.includes(section)) SECTIONS.push(section);
    try {
        state.localUpdate = true;

        for (const empId of state.selectedEmployees) {
            const result = await manualMoveEmployee({
                emp_id: empId,
                new_line: finalLine,           // column LINE value e.g. "LINE 11"
                new_line_name: finalLineName,  // sheet name e.g. "L11"
                new_process: section,
                new_shift: finalShift
            });

            if (!result.success) {
                Swal.fire("Error", result.message || "Unable to move employee.", "error");
                return;
            }
        }

        const movedCount = state.selectedEmployees.length;

        // Clear selection state
        state.selectedEmployees = [];
        closeTransferModal();

        // Lines may have changed after a transfer — refetch next time
        cachedLines = null;

        // Show success then re-fetch clean state from server
        await Swal.fire({
            icon: "success",
            title: "Transfer Complete!",
            html: `<b>${movedCount} employee(s)</b> successfully moved to <br><b>${finalLine}</b> › <b>${section}</b>`,
            timer: 1800,
            timerProgressBar: true,
            showConfirmButton: false
        });

        // Re-fetch from server — no local data manipulation needed.
        // This guarantees employees appear in the correct existing card
        // without creating duplicate line cards.
        state.localUpdate = false;
        await load();

    } catch (err) {
        console.error(err);
        Swal.fire("Error", "Something went wrong.", "error");
    }
}

// Shared section picker used by the assign modal and drag/drop assignment.
export async function askSection() {
    const { value: section, isConfirmed } = await Swal.fire({
        title: "Assign to Section",
        html: `
            <div style="text-align:left;">
                <label style="display:block;margin-bottom:5px;font-weight:600;">Select Existing Section</label>
                <select id="sectionSelect" class="swal2-input" style="width:100%;margin:0;">
                    <option value="">-- Select Section --</option>
                    ${SECTIONS.map(s => `<option value="${s}">${s}</option>`).join("")}
                </select>
                <div style="text-align:center;margin:10px 0;color:#64748b;font-size:12px;">OR</div>
                <label style="display:block;margin-bottom:5px;font-weight:600;">Create New Section</label>
                <input id="newSection" class="swal2-input" placeholder="Enter new section name" style="width:100%;margin:0;">
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: "Assign",
        confirmButtonColor: "#2563eb",
        preConfirm: () => {
            const selected = document.getElementById("sectionSelect").value;
            const newSection = document.getElementById("newSection").value.trim().toUpperCase();
            const final = newSection || selected;
            if (!final) { Swal.showValidationMessage("Please select or create a section."); return false; }
            if (newSection && !SECTIONS.includes(newSection)) SECTIONS.push(newSection);
            return final;
        }
    });
    if (!isConfirmed) return null;
    return section;
}

export async function removeEmp(empId, groupId) {
    const confirmed = await Swal.fire({
        title: "Remove employee?",
        text: "They will be moved back to the unassigned pool.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonText: "Remove",
        confirmButtonColor: "#dc2626",
        reverseButtons: true
    });
    if (!confirmed.isConfirmed) return;

    try {
        state.localUpdate = true;
        const result = await removeEmployee(empId);
        if (!result.success) { Swal.fire("Error", "Could not remove employee.", "error"); return; }

        const group = state.data.groups.find(g => g.id === groupId);
        if (group) {
            const idx = group.employees.findIndex(e => e.id === empId);
            if (idx !== -1) {
                const [emp] = group.employees.splice(idx, 1);
                group.count = group.employees.length;
                if (!state.data.unassigned) state.data.unassigned = [];
                state.data.unassigned.push(emp);
            }
        }
        render();
    } catch (err) {
        console.error(err);
        Swal.fire("Error", "Something went wrong.", "error");
    }
}