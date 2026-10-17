// ─────────────────────────────────────────
// DRAG & DROP
// ─────────────────────────────────────────

import { state } from "./state.js";
import { assignEmployee, removeEmployee } from "./api.js";
import { render } from "./render.js";
import { askSection } from "./employees.js";

export function dragEmployee(event, empId) { state.draggedEmployeeId = empId; }
export function allowDrop(event) { event.preventDefault(); }
export function dragEnter(event) { event.currentTarget.classList.add("drag-over"); }
export function dragLeave(event) { event.currentTarget.classList.remove("drag-over"); }

export async function dropEmployee(event, groupId) {
    if (!state.editMode) return;
    event.preventDefault();
    event.currentTarget.classList.remove("drag-over");
    if (!state.draggedEmployeeId) return;

    const section = await askSection();
    if (!section) { state.draggedEmployeeId = null; return; }

    try {
        state.localUpdate = true;
        const result = await assignEmployee(state.draggedEmployeeId, groupId, section);
        if (!result.success) return;

        let employee = null;
        const unassignedIndex = (state.data.unassigned || []).findIndex(e => e.id === state.draggedEmployeeId);
        if (unassignedIndex !== -1) {
            employee = state.data.unassigned.splice(unassignedIndex, 1)[0];
        }

        state.data.groups.forEach(group => {
            const index = group.employees.findIndex(e => e.id === state.draggedEmployeeId);
            if (index !== -1) {
                employee = group.employees.splice(index, 1)[0];
                group.count = group.employees.length;
            }
        });

        if (employee) {
            const targetGroup = state.data.groups.find(g => g.id === groupId);
            if (targetGroup) {
                targetGroup.employees.push({ ...employee, section });
                targetGroup.count = targetGroup.employees.length;
            }
        }
        render();
    } catch (err) {
        console.error(err);
    }
    state.draggedEmployeeId = null;
}

export async function dropToUnassigned(event) {
    if (!state.editMode) return;
    event.preventDefault();
    event.currentTarget.classList.remove("drag-over");
    if (!state.draggedEmployeeId) return;

    try {
        state.localUpdate = true;
        const result = await removeEmployee(state.draggedEmployeeId);
        if (!result.success) return;

        state.data.groups.forEach(group => {
            const index = group.employees.findIndex(e => e.id === state.draggedEmployeeId);
            if (index !== -1) {
                const [emp] = group.employees.splice(index, 1);
                group.count = group.employees.length;
                if (!state.data.unassigned) state.data.unassigned = [];
                state.data.unassigned.push(emp);
            }
        });
        render();
    } catch (err) {
        console.error(err);
    }
    state.draggedEmployeeId = null;
}