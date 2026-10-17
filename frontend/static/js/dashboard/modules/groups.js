// ─────────────────────────────────────────
// GROUP OPERATIONS
// ─────────────────────────────────────────

import { state } from "./state.js";
import { resetGroupRequest, saveLineSnapshot, addLine, updateGroupNameRequest } from "./api.js";
import { render } from "./render.js";
import { load } from "./loader.js";

export async function resetGroup(groupId) {
    const group = (state.data.groups || []).find(g => g.id === groupId);
    if (!group) { Swal.fire("Error", "Group not found.", "error"); return; }
    if (!group.employees || group.employees.length === 0) {
        Swal.fire("Nothing to reset", "This line already has no employees.", "info");
        return;
    }

    const result = await Swal.fire({
        title: "Reset Line?",
        text: "All employees in this line will be removed.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonText: "Yes, Reset",
        cancelButtonText: "Cancel",
        confirmButtonColor: "#dc2626",
        reverseButtons: true
    });
    if (!result.isConfirmed) return;

    try {
        const res = await resetGroupRequest(groupId);
        if (res.success) {
            await Swal.fire({ title: "Success!", text: "Line has been reset.", icon: "success", timer: 1200, showConfirmButton: false });
            socket.emit("data_updated");
        } else {
            Swal.fire("Failed", res.message || "Unable to reset line.", "error");
        }
    } catch (err) {
        Swal.fire("Error", "Something went wrong.", "error");
    }
}

export async function saveGroup(groupId) {
    const group = (state.data.groups || []).find(g => g.id === groupId);
    if (!group) { Swal.fire("Error", "Group not found.", "error"); return; }
    if (!group.employees || group.employees.length === 0) {
        Swal.fire("Info", "No employees assigned.", "info");
        return;
    }

    const result = await Swal.fire({
        title: "Export Group Attendance?",
        text: `This will generate per-agency sheets for ${group.name}`,
        icon: "question",
        showCancelButton: true,
        confirmButtonText: "Yes, Export Excel",
        confirmButtonColor: "#16a34a",
        reverseButtons: true
    });

    await saveLineSnapshot(groupId);

    if (!result.isConfirmed) return;

    const wb = XLSX.utils.book_new();
    const now = new Date();
    const dateStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    const timeStr = String(now.getHours()).padStart(2, "0") + "-" + String(now.getMinutes()).padStart(2, "0") + "-" + String(now.getSeconds()).padStart(2, "0");

    const groupedByAgency = {};
    group.employees.forEach(emp => {
        const agency = emp.agency || "UNKNOWN";
        if (!groupedByAgency[agency]) groupedByAgency[agency] = [];
        groupedByAgency[agency].push(emp);
    });

    Object.entries(groupedByAgency).forEach(([agency, employees]) => {
        const sheetData = [
            ["Agency", agency],
            ["Group Name", group.name],
            ["Date", dateStr],
            ["Time", now.toLocaleTimeString()],
            [],
            ["Name", "Status"]
        ];
        employees.forEach(emp => sheetData.push([emp.name, emp.status]));
        sheetData.push([]);
        sheetData.push(["Total Employees", employees.length]);
        const ws = XLSX.utils.aoa_to_sheet(sheetData);
        const sheetName = agency.replace(/[\[\]\*\/\\\?\:]/g, "").substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    XLSX.writeFile(wb, `${group.name}_ByAgency_${dateStr}_${timeStr}.xlsx`);
    Swal.fire({ icon: "success", title: "Export Complete", text: "Employees are separated per agency sheet" });
}

export async function addNewLine() {
    const selectedPlant = document.getElementById("plantFilter").value;
    const { value: lineName } = await Swal.fire({
        title: "Add New Line",
        input: "text",
        inputLabel: "Line Name",
        inputPlaceholder: "e.g. Line 15",
        showCancelButton: true
    });
    if (!lineName) return;

    const result = await addLine(lineName, selectedPlant);

    if (result.success) {
        await load();
        Swal.fire({ icon: "success", title: "Line Added", text: `"${lineName}" was added to ${selectedPlant}.`, timer: 1500, showConfirmButton: false });
    } else {
        Swal.fire({ icon: "error", title: "Failed", text: result.message || "Unable to add line." });
    }
}

export async function updateGroupName(groupId) {
    const input = document.getElementById(`groupName_${groupId}`);
    if (!input) return;
    const newName = input.value.trim();
    if (!newName) { Swal.fire("Error", "Line name cannot be empty", "error"); return; }

    const result = await updateGroupNameRequest(groupId, newName);
    if (result.success) socket.emit("data_updated");
}

export function filterLines() { render(); }
export function filterShift() { render(); }

// ── NEW: Filter by Department toggle ──────────────────────────
export function toggleDepartmentView() {
    state.departmentViewActive = !state.departmentViewActive;

    const btn = document.getElementById("deptFilterBtn");
    if (btn) {
        btn.classList.toggle("active", state.departmentViewActive);
        btn.textContent = state.departmentViewActive ? "📋 Show All Lines" : "🏢 Filter by Department";
    }

    render();
}