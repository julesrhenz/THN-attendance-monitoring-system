// ─────────────────────────────────────────
// GLOBAL SEARCH / EMPLOYEE HISTORY
// ─────────────────────────────────────────

import { state } from "./state.js";
import { fetchEmployeeHistory } from "./api.js";
import { render } from "./render.js";

export function globalSearch(keyword) {
    const resultBox = document.getElementById("searchResults");
    keyword = keyword.trim().toLowerCase();
    if (!keyword) { resultBox.style.display = "none"; resultBox.innerHTML = ""; return; }

    const matches = [];
    (state.data.groups || []).forEach(group => {
        (group.employees || []).forEach(emp => {
            if ((emp.name || "").toLowerCase().includes(keyword) || (emp.id || "").toLowerCase().includes(keyword)) {
                matches.push(`
                    <div onclick="selectEmployee('${emp.id}', '${group.id}', '${group.shift}')"
                        style="padding:8px;border-bottom:1px solid #eee;cursor:pointer;"
                        onmouseover="this.style.background='#f1f5f9'"
                        onmouseout="this.style.background='white'">
                        <b>${emp.id}</b><br>
                        <small>${emp.name}</small><br>
                        <small style="color:#64748b;">${group.line_name} (${group.shift})</small>
                    </div>
                `);
            }
        });
    });

    (state.data.unassigned || []).forEach(emp => {
        if ((emp.name || "").toLowerCase().includes(keyword) || (emp.id || "").toLowerCase().includes(keyword)) {
            matches.push(`
                <div style="padding:8px;border-bottom:1px solid #eee;cursor:default;">
                    <b>${emp.id}</b><br>
                    <small>${emp.name}</small><br>
                    <small style="color:#94a3b8;">Unassigned</small>
                </div>
            `);
        }
    });

    resultBox.style.display = "block";
    resultBox.innerHTML = matches.length === 0
        ? '<div style="padding:8px;color:#94a3b8;">No employee found</div>'
        : matches.join("");
}

export function selectEmployee(empId, groupId, groupShift) {
    // Close search dropdown
    const resultBox = document.getElementById("searchResults");
    resultBox.style.display = "none";
    document.getElementById("globalSearch").value = "";

    // Ensure correct shift filter is active so the group is visible
    const shiftSelect = document.getElementById("shiftFilter");
    if (shiftSelect && groupShift && shiftSelect.value !== groupShift) {
        shiftSelect.value = groupShift;
        render();
    }

    // Wait a tick for render to finish, then scroll + highlight
    setTimeout(() => {
        const card = document.getElementById(`group-card-${groupId}`);
        const empRow = document.getElementById(`emp-row-${empId}`);

        if (card) {
            card.scrollIntoView({ behavior: "smooth", block: "center" });

            // Flash the card
            card.style.transition = "box-shadow .3s ease, border-color .3s ease";
            card.style.boxShadow = "0 0 0 3px #2563eb";
            card.style.borderColor = "#2563eb";

            setTimeout(() => {
                card.style.boxShadow = "";
                card.style.borderColor = "";
            }, 2000);
        }

        if (empRow) {
            empRow.style.transition = "background .3s ease";
            empRow.style.background = "#dbeafe";

            setTimeout(() => {
                empRow.style.background = "";
            }, 2000);
        }
    }, 150);
}

// Close search results when clicking outside
document.addEventListener("click", (e) => {
    const box = document.getElementById("searchResults");
    const input = document.getElementById("globalSearch");
    if (box && !box.contains(e.target) && e.target !== input) {
        box.style.display = "none";
    }
});

export async function showEmployeeHistory(empId, empName) {
    const raw = await fetchEmployeeHistory(empId);

    // Group records by detected_at (same transfer event)
    const grouped = {};
    raw.forEach(h => {
        const key = h.detected_at || "unknown";
        if (!grouped[key]) {
            grouped[key] = { detected_at: h.detected_at, fields: {} };
        }
        grouped[key].fields[h.field] = {
            from: h.from_value,
            to: h.to_value,
        };
    });

    // Sort oldest → newest so the chain reads left to right correctly
    const events = Object.values(grouped).sort(
        (a, b) => new Date(a.detected_at) - new Date(b.detected_at)
    );

    // Build LINE chain
    const lineChain = [];
    events.forEach(e => {
        const lc = e.fields["LINE"];
        if (!lc) return;
        if (lineChain.length === 0) lineChain.push(lc.from || "—");
        lineChain.push(lc.to || "—");
    });

    // Build PROCESS chain
    const processChain = [];
    events.forEach(e => {
        const pc = e.fields["PROCESS"];
        if (!pc) return;
        if (processChain.length === 0) processChain.push(pc.from || "—");
        processChain.push(pc.to || "—");
    });

    const lastDate = events.length ? events[events.length - 1].detected_at.split(" ")[0] : "—";

    const lineHtml = lineChain.length
        ? lineChain.join(`<span style="color:#94a3b8;margin:0 6px;">→</span>`)
        : "No line changes";

    const processHtml = processChain.length
        ? processChain.join(`<span style="color:#cbd5e1;margin:0 6px;">→</span>`)
        : "No process changes";

    const html = `
        <div style="text-align:left;padding:8px 4px;">
            <div style="color:#94a3b8;font-size:11px;margin-bottom:10px;">
                Last updated: ${lastDate}
            </div>

            <div style="margin-bottom:14px;">
                <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">
                    Line History
                </div>
                <div style="font-size:14px;font-weight:700;color:#0f172a;line-height:1.8;">
                    ${lineHtml}
                </div>
            </div>

            <div>
                <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">
                    Process History
                </div>
                <div style="font-size:13px;font-weight:600;color:#64748b;line-height:1.8;">
                    ${processHtml}
                </div>
            </div>
        </div>
    `;

    Swal.fire({
        title: empName,
        html: html,
        width: 550,
        showConfirmButton: true,
        confirmButtonText: "Close",
    });
}