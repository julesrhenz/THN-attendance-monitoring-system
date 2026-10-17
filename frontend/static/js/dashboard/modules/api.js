// ─────────────────────────────────────────
// API
// ─────────────────────────────────────────
// Thin wrappers around every backend endpoint. No DOM access, no state
// mutation — each function takes plain arguments and returns parsed JSON
// (or throws). Callers in other modules are responsible for updating state
// and re-rendering.

const pendingReads = new Map();
function requestJson(url, options) {
    if (options && options.method && options.method !== "GET") return performRequest(url, options);
    if (!pendingReads.has(url)) {
        pendingReads.set(url, performRequest(url, options).finally(() => pendingReads.delete(url)));
    }
    return pendingReads.get(url);
}
async function performRequest(url, options) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
    }
    return payload;
}

export async function fetchDashboardData(batchId) {
    const url = batchId ? `/api/data/${batchId}` : "/api/data";
    return requestJson(url);
}

export async function fetchDashboardSummary() {
    return requestJson("/api/dashboard-summary");
}

export async function fetchAttendanceValidation() {
    return requestJson("/api/attendance-validation");
}

export async function fetchAllLines() {
    return requestJson("/api/all-lines");
}

export async function manualMoveEmployee(payload) {
    return requestJson("/api/manual-move-employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
}

export async function removeEmployee(employeeId) {
    return requestJson("/api/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employeeId })
    });
}

export async function resetGroupRequest(groupId) {
    return requestJson("/api/reset-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId })
    });
}

export async function saveLineSnapshot(groupId) {
    return requestJson("/api/save-line-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId })
    });
}

export async function addLine(lineName, plant) {
    return requestJson("/api/add-line", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_name: lineName, plant })
    });
}

export async function updateGroupNameRequest(groupId, name) {
    return requestJson("/api/update-group-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId, name })
    });
}

export async function fetchEmployeeHistory(empId) {
    return requestJson(`/api/employee-history/${encodeURIComponent(empId)}`);
}

export async function assignEmployee(employeeId, groupId, section) {
    return requestJson("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employeeId, group_id: groupId, section })
    });
}

export async function importGrouping(formData) {
    return requestJson("/api/import-grouping", { method: "POST", body: formData });
}

export async function fetchImportBatches() {
    return requestJson("/api/import-batches");
}

// Stored content (the actual Excel rows) of one import batch. Admin-only on the backend.
// Expected: { success, sheets: [ { name, columns: [...], rows: [ {...} | [...] ] } ] }
export async function fetchImportBatchContent(batchId) {
    return requestJson(`/api/import-batches/${encodeURIComponent(batchId)}/content`);
}

export async function fetchAttendanceStatusRequest() {
    return requestJson("/api/attendance-status");
}
export async function getCurrentUser() {
    return requestJson("/api/me");
}
export async function fetchLineSummary(lineId, shift) {
    const encodedLineId = encodeURIComponent(lineId);
    const url = shift
        ? `/api/lines/${encodedLineId}/summary?shift=${encodeURIComponent(shift)}`
        : `/api/lines/${encodedLineId}/summary`;
    return requestJson(url);
}
export async function updateEmployeeRemark(empId, remark) {
    return requestJson(`/api/employees/${encodeURIComponent(empId)}/remark`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remark })
    });
}

// ── No Work Schedule ──────────────────────────────────────────────────────
// Proxied through attendance_bp on this server → main.py on 192.9.224.6.
// Per-employee entries use emp_ids[]; line/shift-wide entries use line_name
// and/or shift. Both shapes are accepted by the backend.

export async function fetchNoWork(date) {
    const url = date ? `/api/no-work?date=${encodeURIComponent(date)}` : "/api/no-work";
    return requestJson(url);
}

export async function createNoWork(payload) {
    // payload: { work_date, emp_ids?, line_name?, shift?, reason? }
    return requestJson("/api/no-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
}

export async function deleteNoWork(entryId) {
    return requestJson(`/api/no-work/${entryId}`, { method: "DELETE" });
}