// ─────────────────────────────────────────
// LOAD (data fetch orchestration)
// ─────────────────────────────────────────
// Ties together api.js (fetch), state.js (write), and render.js (paint).
// This sits above render.js in the dependency graph: render.js never calls
// load(), only the reverse, so there's no cycle.

import { state, socket } from "./state.js";
import { fetchDashboardData } from "./api.js";
import { render, populateLineFilter, loadAttendanceValidation } from "./render.js";

export async function load() {
    if (state.loading) return;
    state.loading = true;

    try {
        const batchId = localStorage.getItem("active_batch_id");
        state.data = await fetchDashboardData(batchId);
        window.data = state.data; // some legacy inline handlers may still reach for window.data
        populateLineFilter();
        render();
        loadAttendanceValidation();
    } catch (e) {
        console.error(e);
    }

    state.loading = false;
}

socket.on("data_updated", async () => {
    if (state.localUpdate) {
        state.localUpdate = false;
        return;
    }
    // The next visibility change performs a full refresh. Avoid doing that
    // work for every socket event while the dashboard is in a background tab.
    if (document.hidden) return;
    await load();
});
