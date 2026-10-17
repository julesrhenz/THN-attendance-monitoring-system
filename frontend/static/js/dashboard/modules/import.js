// ─────────────────────────────────────────
// IMPORT EXCEL / BATCH LIST
// ─────────────────────────────────────────

import { importGrouping, fetchImportBatches, fetchImportBatchContent } from "./api.js";
import { escapeHtml } from "./utils.js";
import { load } from "./loader.js";

export function importExcel() {
    document.getElementById("excelFile").click();
}

/**
 * Shows a small prompt asking whether this import should take effect
 * immediately or at a scheduled date/time, and which agency the import
 * should apply to. Returns:
 *   { confirmed: true,  mode: "immediate", agencyScope: "ALL" }
 *   { confirmed: true,  mode: "scheduled", effectiveAt: "2026-07-10T14:30", agencyScope: "THN" }
 *   { confirmed: false }                                  // user cancelled
 */
async function askEffectivity() {
    const { value, isConfirmed } = await Swal.fire({
        title: "Import Settings",
        html: `
            <div style="text-align:left;margin-top:10px;">
                <label style="display:block;font-size:12.5px;font-weight:700;color:#64748b;letter-spacing:.4px;text-transform:uppercase;margin-bottom:6px;">
                    Agency
                </label>
                <select id="agencyScopeSelect"
                    style="width:100%;padding:9px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;margin-bottom:6px;">
                    <option value="ALL" selected>All Agencies</option>
                    <option value="THN">THN only</option>
                    <option value="CCI">CCI only</option>
                    <option value="EMIS">EMIS only</option>
                    <option value="NATCORP">NATCORP only</option>
                </select>
                <div style="font-size:11.5px;color:#888;margin-bottom:16px;">
                    Employee rows for other agencies in the file will be skipped.
                    Employees already in the system for other agencies are not affected.
                    <br>Operators in the selected agency who are no longer in the file can be
                    marked inactive (you'll see the list and confirm first).
                </div>

                <label style="display:block;font-size:12.5px;font-weight:700;color:#64748b;letter-spacing:.4px;text-transform:uppercase;margin-bottom:6px;">
                    When should this take effect?
                </label>
                <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;font-size:14px;">
                    <input type="radio" name="effMode" value="immediate" checked
                        onchange="document.getElementById('effScheduleRow').style.display='none';">
                    Effective Immediately
                </label>
                <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;font-size:14px;">
                    <input type="radio" name="effMode" value="scheduled"
                        onchange="document.getElementById('effScheduleRow').style.display='block';">
                    Schedule for a specific date &amp; time
                </label>
                <div id="effScheduleRow" style="display:none;margin-top:8px;">
                    <input type="datetime-local" id="effDateTime"
                        style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;">
                </div>
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: "Continue",
        cancelButtonText: "Cancel",
        focusConfirm: false,
        preConfirm: () => {
            const agencyScope = document.getElementById("agencyScopeSelect")?.value || "ALL";
            const mode = document.querySelector('input[name="effMode"]:checked')?.value || "immediate";
            if (mode === "scheduled") {
                const dt = document.getElementById("effDateTime")?.value;
                if (!dt) {
                    Swal.showValidationMessage("Please choose a date and time.");
                    return false;
                }
                const chosen = new Date(dt);
                if (chosen.getTime() <= Date.now()) {
                    Swal.showValidationMessage("Scheduled time must be in the future.");
                    return false;
                }
                return { mode, effectiveAt: dt, agencyScope };
            }
            return { mode, agencyScope };
        }
    });

    if (!isConfirmed || !value) return { confirmed: false };
    return { confirmed: true, ...value };
}

/**
 * Dry-run ng import: tinatanong ang backend kung sino ang ACTIVE sa system
 * (sa napiling agency) pero wala na sa Excel file. Kapag may lumabas,
 * ipinapakita ang listahan at hinihingi ang confirmation.
 * Returns { cancelled: true } o { cancelled: false, deactivate: boolean }.
 */
async function previewAndConfirmRemovals(formData, effectivity, input) {
    const previewData = new FormData();
    for (const [k, v] of formData.entries()) previewData.append(k, v);
    previewData.set("dry_run", "1");

    Swal.fire({
        title: "Checking file...",
        html: "Comparing the Excel file with the current roster.",
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => Swal.showLoading()
    });

    let preview;
    try {
        preview = await importGrouping(previewData);
    } catch (err) {
        Swal.close();
        console.error(err);
        await Swal.fire({ icon: "error", title: "Upload Failed", text: err.message || "Network or server error." });
        return { cancelled: true };
    }
    Swal.close();

    if (!preview.success) {
        await Swal.fire({
            icon: "error", title: "Import Failed",
            html: `<pre style="text-align:left;font-size:12px;white-space:pre-wrap;">${escapeHtml(preview.message || "Unknown error")}</pre>`
        });
        return { cancelled: true };
    }

    // OPTIMIZATION: if the backend caches the parsed workbook during the dry run,
    // it returns a token so the real import doesn't re-upload + re-parse the file.
    const previewToken = preview.preview_token || null;

    const list = preview.will_deactivate || [];
    if (list.length === 0) return { cancelled: false, deactivate: true, previewToken }; // walang matatanggal

    const deptLabel = (preview.departments_in_file || []).map(escapeHtml).join(", ") || "—";

    const scopeLabel = preview.agency_scope && preview.agency_scope !== "ALL"
        ? `${escapeHtml(preview.agency_scope)} only` : "All Agencies";
    const when = effectivity.mode === "scheduled"
        ? "when this import goes live"
        : "immediately";
    const rows = list.map(e => `
        <tr>
            <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(String(e.emp_id))}</td>
            <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(e.full_name)}</td>
            <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(e.line_name)}</td>
        </tr>`).join("");
    const protectedNote = (preview.protected_sheets || []).length
        ? `<div style="margin-top:10px;font-size:12px;color:#d97706;">
               Skipped (sheet had problems, nobody removed from these):
               ${preview.protected_sheets.map(escapeHtml).join(", ")}
           </div>`
        : "";

    const res = await Swal.fire({
        icon: "warning",
        title: `${list.length} operator(s) not in the file`,
        width: 640,
        html: `
            <div style="text-align:left;font-size:13px;">
                These are active in the system (${scopeLabel}, department: <b>${deptLabel}</b>)
                but are no longer in the Excel file (${preview.total_in_file} operators in file).
                Other departments are not affected.
                They will be marked <b>inactive</b> ${when}.
                History is kept, and they return automatically if they appear in a later upload.
                <div style="max-height:260px;overflow:auto;margin-top:10px;border:1px solid #e2e8f0;border-radius:8px;">
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead><tr style="background:#f8fafc;text-align:left;">
                            <th style="padding:6px 8px;">ID</th><th style="padding:6px 8px;">Name</th><th style="padding:6px 8px;">Line</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                ${protectedNote}
            </div>`,
        showDenyButton: true,
        showCancelButton: true,
        confirmButtonText: `Import &amp; deactivate ${list.length}`,
        denyButtonText: "Import only (keep them)",
        cancelButtonText: "Cancel",
        focusCancel: true
    });

    if (res.isConfirmed) return { cancelled: false, deactivate: true, previewToken };
    if (res.isDenied) return { cancelled: false, deactivate: false, previewToken };
    return { cancelled: true };
}

export async function uploadExcel() {
    const input = document.getElementById("excelFile");
    if (!input.files.length) return;

    const effectivity = await askEffectivity();
    if (!effectivity.confirmed) {
        input.value = "";
        return;
    }

    const formData = new FormData();
    formData.append("file", input.files[0]);
    formData.append("effective_mode", effectivity.mode);
    formData.append("agency_scope", effectivity.agencyScope || "ALL");
    if (effectivity.mode === "scheduled") {
        // datetime-local gives "YYYY-MM-DDTHH:MM" (no seconds/timezone) -- fine for
        // Python's datetime.fromisoformat() on the backend as-is.
        formData.append("effective_at", effectivity.effectiveAt);
    }

    // ── Preview: sino ang mawawala sa system kapag wala na sila sa Excel? ──
    const removal = await previewAndConfirmRemovals(formData, effectivity, input);
    if (removal.cancelled) {
        input.value = "";
        return;
    }
    formData.set("deactivate_missing", removal.deactivate ? "1" : "0");

    // OPTIMIZATION: reuse the server-side parse from the dry run instead of
    // uploading and parsing the same workbook a second time.
    const excelFile = input.files[0];
    if (removal.previewToken) {
        formData.delete("file");
        formData.set("preview_token", removal.previewToken);
    }
    // The web UI reloads the roster itself via load(), so skip the big payload.
    formData.set("include_state", "0");

    let progress = 0;
    const steps = [
        "Opening Excel workbook...", "Reading worksheets...", "Extracting employee data...",
        "Validating records...", "Saving employees...", "Detecting employee movements...", "Finalizing import..."
    ];
    let stepIndex = 0;

    Swal.fire({
        title: "Importing Employee Grouping",
        html: `
            <div style="margin-top:15px">
                <div id="importStep" style="font-size:15px;font-weight:600;margin-bottom:15px;">${steps[0]}</div>
                <div style="width:100%;height:12px;background:#e5e7eb;border-radius:999px;overflow:hidden;">
                    <div id="fakeProgress" style="width:0%;height:100%;background:#2563eb;transition:width .5s ease;"></div>
                </div>
                <div id="progressText" style="margin-top:10px;color:#666;font-size:13px;">0%</div>
                <p style="margin-top:18px;font-size:12px;color:#888;">Please don't close this window.</p>
            </div>
        `,
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => {
            window.importInterval = setInterval(() => {
                if (progress >= 95) return;
                progress += Math.floor(Math.random() * 4) + 1;
                if (progress > 95) progress = 95;
                document.getElementById("fakeProgress").style.width = progress + "%";
                document.getElementById("progressText").innerHTML = progress + "%";
                const newStep = Math.min(Math.floor(progress / 15), steps.length - 1);
                if (newStep !== stepIndex) {
                    stepIndex = newStep;
                    document.getElementById("importStep").innerHTML = steps[stepIndex];
                }
            }, 500);
        }
    });

    try {
        let result = await importGrouping(formData);

        // Cached parse expired / was used / belongs to another session:
        // quietly fall back to uploading the file again.
        if (!result.success && result.code === "preview_expired") {
            formData.delete("preview_token");
            formData.set("file", excelFile);
            result = await importGrouping(formData);
        }

        input.value = "";
        clearInterval(window.importInterval);
        Swal.close();

        if (!result.success) {
            Swal.fire({
                icon: "error", title: "Import Failed",
                html: `<pre style="text-align:left;font-size:12px;white-space:pre-wrap;">${escapeHtml(result.message || "Unknown error")}</pre>`
            });
            return;
        }

        const notices = [
            ...(result.errors || []).map(e => `⚠️ Skipped: ${e}`),
            ...(result.warnings || []).map(w => `ℹ️ ${w}`)
        ];

        localStorage.removeItem("active_batch_id");
        const batchFilter = document.getElementById("batchFilter");
        if (batchFilter) batchFilter.value = "";
        // OPTIMIZATION: don't block the result dialog on the table refresh.
        load().catch(err => console.error("Reload after import failed:", err));

        const totalEmployees = (result.imported_sheets || []).reduce((sum, l) => sum + l.employee_count, 0);
        const linesLoaded = (result.imported_sheets || []).length;

        const isScheduled = result.effective_mode === "scheduled";
        const title = isScheduled ? "Import Scheduled" : "Import Complete";

        const scopeLabel = result.agency_scope && result.agency_scope !== "ALL"
            ? `${escapeHtml(result.agency_scope)} only`
            : "All Agencies";

        let html = "";
        if (isScheduled) {
            const when = result.effective_at
                ? new Date(result.effective_at).toLocaleString()
                : "the scheduled time";
            html += `<b>${linesLoaded} line(s)</b> with <b>${totalEmployees} employee(s)</b> (${scopeLabel}) will go live on <b>${when}</b>.`;
        } else {
            html += `<b>${linesLoaded} line(s)</b> loaded with <b>${totalEmployees} employee(s)</b> (${scopeLabel}).`;
        }

        if (isScheduled && result.deactivate_requested) {
            html += `<div style="margin-top:8px;font-size:12px;color:#d97706;">Operators no longer in the file will be marked inactive when this import goes live.</div>`;
        } else if (result.deactivated_count > 0) {
            html += `<div style="margin-top:8px;font-size:12px;color:#d97706;"><b>${result.deactivated_count} operator(s)</b> no longer in the file were marked inactive.</div>`;
        }

        // ── NEW: show who performed this import ──
        if (result.imported_by) {
            html += `<div style="margin-top:8px;font-size:12px;color:#888;">Imported by: <b>${escapeHtml(result.imported_by)}</b></div>`;
        }

        if (notices.length) {
            html += `
                <details style="margin-top:12px;text-align:left;font-size:12px;">
                    <summary style="cursor:pointer;color:#d97706;">${notices.length} notice(s) — click to expand</summary>
                    <ul style="margin-top:8px;padding-left:16px;">${notices.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
                </details>
            `;
        }

        Swal.fire({ icon: isScheduled ? "info" : "success", title, html, confirmButtonText: "OK" });

    } catch (err) {
        clearInterval(window.importInterval);
        Swal.close();
        input.value = "";
        console.error(err);
        Swal.fire({ icon: "error", title: "Upload Failed", text: err.message || "Network or server error." });
    }
}

export async function loadBatchList() {
    const batches = await fetchImportBatches();
    const select = document.getElementById("batchFilter");
    if (!select) return;

    select.innerHTML = `<option value="">Live Database</option>`;
    batches.forEach(batch => {
        // ── NEW: show uploader inline in the dropdown for quick scanning ──
        const uploaderLabel = batch.imported_by ? ` — ${batch.imported_by}` : "";
        const option = document.createElement("option");
        option.value = batch.id;
        option.textContent = `${batch.filename}${uploaderLabel}`;
        if (batch.imported_by) {
            option.title = `Imported by ${batch.imported_by}`;
        }
        select.appendChild(option);
    });

    const saved = localStorage.getItem("active_batch_id");
    if (saved) select.value = saved;

    select.addEventListener("change", () => {
        const val = select.value;
        if (val) localStorage.setItem("active_batch_id", val);
        else localStorage.removeItem("active_batch_id");
        load();
    });
}

const MAX_PREVIEW_ROWS = 500;

/** Normalizes one sheet so rows are always arrays of cell values. */
function normalizeSheet(sheet) {
    const rawRows = sheet.rows || [];
    let columns = sheet.columns;
    if (!columns || !columns.length) {
        columns = rawRows.length && !Array.isArray(rawRows[0]) ? Object.keys(rawRows[0]) : [];
    }
    const rows = rawRows.map(r => Array.isArray(r) ? r : columns.map(c => r[c]));
    return { name: sheet.name || "Sheet", columns, rows };
}

/**
 * NEW: modal showing the actual content of an uploaded Excel file —
 * one tab per sheet/line, with a search box. "Back" returns to the logs.
 */
async function viewBatchContent(batch) {
    Swal.fire({
        title: "Loading file content...",
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => Swal.showLoading()
    });

    let sheets;
    try {
        const data = await fetchImportBatchContent(batch.id);
        if (data.success === false) throw new Error(data.message || "Failed to load file content.");
        sheets = (data.sheets || []).map(normalizeSheet);
    } catch (err) {
        console.error(err);
        await Swal.fire({ icon: "error", title: "Failed to load content", text: err.message || "Network or server error." });
        return viewImportLogs();
    }

    if (!sheets.length) {
        await Swal.fire({ icon: "info", title: "No content found", text: "No stored rows for this import." });
        return viewImportLogs();
    }

    const tabsHtml = sheets.map((s, i) => `
        <button type="button" data-tab="${i}"
            style="padding:5px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-size:12px;cursor:pointer;">
            ${escapeHtml(s.name)} (${s.rows.length})
        </button>`).join("");

    const result = await Swal.fire({
        title: escapeHtml(batch.filename || "Import Content"),
        width: 950,
        showDenyButton: true,
        denyButtonText: "← Back to Logs",
        confirmButtonText: "Close",
        html: `
            <div style="text-align:left;font-size:12px;color:#64748b;margin-bottom:8px;">
                Imported by <b>${escapeHtml(batch.imported_by || "—")}</b>
                on ${batch.imported_at ? escapeHtml(new Date(batch.imported_at).toLocaleString()) : "—"}
            </div>
            <div id="batchTabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${tabsHtml}</div>
            <input id="batchContentSearch" type="text" placeholder="Search in this sheet..."
                style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;margin-bottom:8px;">
            <div id="batchContentInfo" style="text-align:left;font-size:11.5px;color:#94a3b8;margin-bottom:6px;"></div>
            <div id="batchContentTable" style="max-height:420px;overflow:auto;text-align:left;border:1px solid #e2e8f0;border-radius:8px;"></div>
        `,
        didOpen: () => {
            let active = 0;
            let query = "";
            const tableBox = document.getElementById("batchContentTable");
            const infoBox = document.getElementById("batchContentInfo");
            const tabBtns = document.querySelectorAll("#batchTabs [data-tab]");

            const render = () => {
                const sheet = sheets[active];
                const q = query.trim().toLowerCase();
                const filtered = q
                    ? sheet.rows.filter(r => r.some(c => String(c ?? "").toLowerCase().includes(q)))
                    : sheet.rows;
                const shown = filtered.slice(0, MAX_PREVIEW_ROWS);

                infoBox.textContent = filtered.length > MAX_PREVIEW_ROWS
                    ? `Showing first ${MAX_PREVIEW_ROWS} of ${filtered.length} rows — use search to narrow down.`
                    : `${filtered.length} row(s)`;

                const th = sheet.columns.map(c =>
                    `<th style="padding:6px 8px;text-align:left;position:sticky;top:0;background:#f8fafc;white-space:nowrap;">${escapeHtml(String(c))}</th>`
                ).join("");
                const body = shown.map(r => `<tr>${r.map(c =>
                    `<td style="padding:5px 8px;border-top:1px solid #e2e8f0;white-space:nowrap;">${escapeHtml(String(c ?? ""))}</td>`
                ).join("")}</tr>`).join("");

                tableBox.innerHTML = `
                    <table style="width:100%;font-size:12px;border-collapse:collapse;">
                        <thead><tr>${th}</tr></thead>
                        <tbody>${body || `<tr><td colspan="${sheet.columns.length || 1}" style="padding:14px;text-align:center;color:#94a3b8;">No matching rows.</td></tr>`}</tbody>
                    </table>`;

                tabBtns.forEach((b, i) => {
                    b.style.background = i === active ? "#2563eb" : "#fff";
                    b.style.color = i === active ? "#fff" : "#111";
                });
            };

            tabBtns.forEach(b => b.addEventListener("click", () => {
                active = Number(b.dataset.tab);
                render();
            }));
            document.getElementById("batchContentSearch").addEventListener("input", e => {
                query = e.target.value;
                render();
            });
            render();
        }
    });

    if (result.isDenied) viewImportLogs();
}

/**
 * Shows a modal listing every import batch — filename, uploader,
 * date, status, and a View button that opens the file's actual content.
 */
export async function viewImportLogs() {
    let batches;
    try {
        batches = await fetchImportBatches();
    } catch (err) {
        console.error(err);
        Swal.fire({ icon: "error", title: "Failed to load logs", text: err.message || "Network or server error." });
        return;
    }

    const rows = batches.map((b, i) => {
        const statusLabel = b.applied === false ? "⏳ Scheduled" : "✅ Applied";
        const dateLabel = b.imported_at ? new Date(b.imported_at).toLocaleString() : "—";
        return `
            <tr>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(b.filename || "—")}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;"><b>${escapeHtml(b.imported_by || "—")}</b></td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${dateLabel}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${statusLabel}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">
                    <button type="button" data-view-batch="${i}"
                        style="padding:4px 10px;border:1px solid #2563eb;border-radius:6px;background:#eff6ff;color:#2563eb;font-size:12px;cursor:pointer;">
                        👁 View
                    </button>
                </td>
            </tr>
        `;
    }).join("");

    Swal.fire({
        title: "📋 Import Logs",
        width: 800,
        html: `
            <div style="max-height:420px;overflow-y:auto;text-align:left;">
                <table style="width:100%;font-size:12.5px;border-collapse:collapse;">
                    <thead>
                        <tr style="background:#f8fafc;">
                            <th style="padding:6px 8px;text-align:left;">File</th>
                            <th style="padding:6px 8px;text-align:left;">Uploaded By</th>
                            <th style="padding:6px 8px;text-align:left;">Date</th>
                            <th style="padding:6px 8px;text-align:left;">Status</th>
                            <th style="padding:6px 8px;text-align:left;">Content</th>
                        </tr>
                    </thead>
                    <tbody>${rows || `<tr><td colspan="5" style="padding:14px;text-align:center;color:#94a3b8;">No imports yet.</td></tr>`}</tbody>
                </table>
            </div>
        `,
        confirmButtonText: "Close",
        didOpen: () => {
            document.querySelectorAll("[data-view-batch]").forEach(btn => {
                btn.addEventListener("click", () => viewBatchContent(batches[Number(btn.dataset.viewBatch)]));
            });
        }
    });
}