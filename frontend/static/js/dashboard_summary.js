import { fetchAllLines, fetchLineSummary } from "./dashboard/modules/api.js";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 10000; // strictly 10 seconds
const GRID_SELECTOR = "#sheetSummaryGrid";

let pollTimerId = null;
let isFetchInFlight = false; // guards against overlapping requests if a poll is slow

// ---------------------------------------------------------------------------
// FORMATTING
// ---------------------------------------------------------------------------

/**
 * Computes Present/Late/Absent percentages (1 decimal place) from raw counts,
 * per the required formula: (count / total) * 100.
 */
function computePercentages(metrics) {
    const total = metrics.total_employees || 0;

    const presentCount = metrics.present_count || 0;
    const lateCount = metrics.late_count || 0;
    const absentCount = metrics.absent_count || 0;

    const pct = (count) => (total > 0 ? ((count / total) * 100).toFixed(1) : "0.0");

    return {
        total,
        presentCount,
        presentPct: pct(presentCount),
        latePct: pct(lateCount),
        absentPct: pct(absentCount),
    };
}

/**
 * Builds the exact required single-line string:
 * "[LINE NAME] [Present]/[Total] Employees — [Present%]% Present, [Late%]% Late, [Absent%]% Absent"
 */
function formatLineSummaryString(lineMeta, metrics) {
    const { total, presentCount, presentPct, latePct, absentPct } = computePercentages(metrics);
    const lineLabel = lineMeta.shift
        ? `${lineMeta.line_name} (${lineMeta.shift})`
        : lineMeta.line_name;

    return `${lineLabel} ${presentCount}/${total} Employees — ${presentPct}% Present, ${latePct}% Late, ${absentPct}% Absent`;
}

// ---------------------------------------------------------------------------
// RENDERING (minimalist — plain centered text, no cards/grids/borders)
// ---------------------------------------------------------------------------

/**
 * Renders/updates the summary panel in place. Patches existing text nodes
 * when the number of lines hasn't changed, so updates apply instantly
 * without a flicker or full re-render.
 */
function renderLineSummaries(lines) {
    const grid = document.querySelector(GRID_SELECTOR);
    if (!grid) return;

    const existing = grid.querySelectorAll("[data-line-summary]");

    if (existing.length === lines.length) {
        existing.forEach((node, i) => {
            if (node.textContent !== lines[i]) {
                node.textContent = lines[i];
            }
        });
        return;
    }

    grid.innerHTML = "";
    lines.forEach((line) => {
        const p = document.createElement("p");
        p.className = "sheet-summary-line";
        p.setAttribute("data-line-summary", "true");
        p.textContent = line;
        grid.appendChild(p);
    });
}

// ---------------------------------------------------------------------------
// FETCH + POLLING ENGINE
// ---------------------------------------------------------------------------

/**
 * Fetches all line groups and their live summaries, then renders them.
 * Fails silently to the UI (logs only) so a single dropped poll never
 * disrupts the currently displayed numbers.
 */
async function loadSummary() {
    if (isFetchInFlight) return; // skip this tick if the previous poll hasn't resolved
    isFetchInFlight = true;

    try {
const lines = await fetchAllLines();

console.log("ALL LINES:", lines);

if (!Array.isArray(lines)) {
    console.error("Expected an array but got:", lines);
    return;
}

const summaries = await Promise.all(
    lines.map((l) => fetchLineSummary(l.line, l.shift))
);

        const formatted = summaries.map((s, i) =>
            formatLineSummaryString(lines[i], s.metrics)
        );

        renderLineSummaries(formatted);
    } catch (err) {
        console.error("[dashboard_summary] loadSummary failed:", err);
    } finally {
        isFetchInFlight = false;
    }
}

/**
 * Starts the 10-second background polling loop. Paints immediately, then
 * silently re-fetches on a fixed interval to capture live changes such as
 * a time_out event.
 */
function startSummaryPolling() {
    loadSummary();

    if (pollTimerId !== null) return; // avoid duplicate intervals on re-init
    pollTimerId = setInterval(loadSummary, POLL_INTERVAL_MS);
}

/**
 * Stops polling — call on teardown/navigation away to avoid leaked timers.
 */
function stopSummaryPolling() {
    if (pollTimerId !== null) {
        clearInterval(pollTimerId);
        pollTimerId = null;
    }
}

// Pause polling when the tab isn't visible, resume when it is — avoids
// piling up unnecessary requests in background tabs.
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopSummaryPolling();
    } else {
        startSummaryPolling();
    }
});

startSummaryPolling();

export { loadSummary, startSummaryPolling, stopSummaryPolling };
function buildLiveLineSummary(groups){

    const container =
        document.getElementById("liveLineSummaryContent");

    if(!container) return;

    container.innerHTML = "";

    groups.forEach(group=>{

        const employees = group.employees || [];

        const total = employees.length;

        let present = 0;
        let late = 0;
        let absent = 0;

        employees.forEach(emp=>{

            const status =
                (emp.status || "")
                .trim()
                .toLowerCase();

            if(status==="present"){
                present++;
            }
            else if(status==="late"){
                present++;
                late++;
            }
            else{
                absent++;
            }

        });

        const presentPct =
            total
                ? ((present/total)*100).toFixed(1)
                : "0.0";

        const absentPct =
            total
                ? ((absent/total)*100).toFixed(1)
                : "0.0";

        const latePct =
            present
                ? ((late/present)*100).toFixed(1)
                : "0.0";

        container.insertAdjacentHTML(
            "beforeend",
            `
            <div class="live-line-summary-row">
                <strong>${group.line_name}</strong>:
                ${present}/${total} Employees (${presentPct}%)
                |
                ${absent} Absent (${absentPct}%)
                |
                ${late} Late (${latePct}%)
            </div>
            `
        );

    });

}
async function refreshLiveSummary(){

    try{

        const response =
            await fetch("/api/dashboard-data");

        const latest =
            await response.json();

        buildLiveLineSummary(
            latest.groups || []
        );

    }
    catch(err){

        console.error(
            "Live Summary",
            err
        );

    }

}