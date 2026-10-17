// ============================================================
// USER MANAGEMENT  (static/js/user_management.js)
// ============================================================
// Create, edit, and delete accounts. Only visible/usable by a global
// administrator: /api/me must report
//   access_level GLOBAL, department ADMINISTRATION, role Admin, is_admin true
// (that rule lives in isUserManager() in sidebar.js so the sidebar link and
// this page can never disagree).
//
// NOTE: like the rest of the front end, the access check here is display-only.
// The real enforcement is on the server (see user_management_routes.py).
//
// Endpoints this page talks to:
//   GET    /api/me                   -> current user (already exists)
//   GET    /api/users                -> { users: [...] }
//   POST   /api/users                -> { success, message }      (same body as /register)
//   PUT    /api/users/<id|username>  -> { success, message }      (edit an existing account)
//   DELETE /api/users/<id|username>  -> { success, message }
//   GET    /api/available-lines?department=X  (already exists; fills the Line dropdown)
//
// NOTE ON PASSWORDS: passwords are hashed server-side and are never sent back
// by GET /api/users, so there is no "current password" to display in the
// Edit dialog. Instead, the Edit dialog's password field is a plain-text
// (not masked) field for setting a *new* password -- left blank, the
// account's existing password is untouched. See update_account() in
// user_management_routes.py.
// ============================================================

(function () {
    "use strict";

    // ---- small helpers -------------------------------------------------
    const $ = (id) => document.getElementById(id);

    const esc = (value) =>
        String(value ?? "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));

    async function readJson(res) {
        try { return await res.json(); } catch (e) { return null; }
    }

    // Human labels, mirroring index.html's old register form / sidebar.js.
    const ACCESS_LEVEL_LABELS = {
        LINE:       "Level 1 — Line (single line/shift only)",
        SECTION:    "Level 2 — Section (one Production sub-section)",
        DEPARTMENT: "Level 3 — Department (whole department)",
        GLOBAL:     "Level 4 — Global / HR (unrestricted)"
    };
    const ROLE_HINTS = {
        Admin:      "Sees everything company-wide, no matter which department or access level is chosen.",
        Supervisor: "Can edit within the department, section, or line set below.",
        Viewer:     "Read-only within the department, section, or line set below."
    };

    // ---- state ---------------------------------------------------------
    const state = { me: null, users: [], visible: [], selected: new Set(), pendingDelete: null, editing: null };
    const DEFAULT_PASSWORD = "0000";

    // ---- element refs (resolved on init) -------------------------------
    let el = {};

    // ====================================================================
    // ACCESS GATE
    // ====================================================================
    function showDenied(message) {
        $("umChecking").hidden = true;
        $("umContent").hidden = true;
        if (message) $("umDeniedText").textContent = message;
        $("umDenied").hidden = false;
    }

    async function init() {
        el = {
            rows: $("userRows"),
            table: $("tableScroll"),
            stateBox: $("stateBox"),
            count: $("countLabel"),
            search: $("searchInput"),
            createDlg: $("createDialog"),
            editDlg: $("editDialog"),
            deleteDlg: $("deleteDialog"),
            resetDlg: $("resetDialog")
        };

        let me = null;
        try {
            const res = await fetch("/api/me", { credentials: "same-origin" });
            if (res.status === 401) { window.location.href = "/"; return; }
            if (!res.ok) throw new Error("me " + res.status);
            me = await res.json();
        } catch (err) {
            console.error(err);
            showDenied("We couldn't verify your access. Refresh the page to try again.");
            return;
        }

        if (typeof isUserManager !== "function" || !isUserManager(me)) {
            showDenied();
            return;
        }

        state.me = me;
        $("umChecking").hidden = true;
        $("umContent").hidden = false;

        wireEvents();
        resetCreateForm();
        loadUsers();
    }

    // ====================================================================
    // LIST
    // ====================================================================
    function displayName(u) {
        return (u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Unknown user").trim();
    }

    function initialsOf(u) {
        const name = displayName(u);
        const parts = name.split(/\s+/);
        return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
    }

    // /register posts `roles`, /api/me returns `role` -- accept either.
    const roleOf = (u) => u.role || u.roles || "";
    const keyOf = (u) => String(u.id ?? u.username);

    function isSelf(u) {
        return !!(state.me && u.username && state.me.username &&
            String(u.username).toLowerCase() === String(state.me.username).toLowerCase());
    }

    function rowHtml(u) {
        const name = displayName(u);
        const self = isSelf(u);

        const checked = state.selected.has(keyOf(u));

        return `<tr>
            <td class="td-select">
                <input type="checkbox" class="row-check" data-select="${esc(keyOf(u))}"
                       aria-label="Select ${esc(name)}"
                       ${checked ? "checked" : ""}
                       ${self ? 'disabled title="You can\'t reset your own password here"' : ""}>
            </td>
            <td class="td-account">
                <div class="acct">
                    <span class="avatar" aria-hidden="true">${esc(initialsOf(u))}</span>
                    <span class="acct-text">
                        <span class="acct-name">${esc(name)}${self ? '<span class="you">You</span>' : ""}</span>
                        <span class="acct-user">${esc(u.username)}</span>
                    </span>
                </div>
            </td>
            <td class="td-actions">
                <button type="button" class="btn btn-quiet" data-edit="${esc(keyOf(u))}"
                        aria-label="Edit account for ${esc(name)}">Edit</button>
                <button type="button" class="btn btn-row-delete" data-delete="${esc(keyOf(u))}"
                        aria-label="Delete account for ${esc(name)}"
                        ${self ? 'disabled title="You can\'t delete your own account"' : ""}>Delete</button>
            </td>
        </tr>`;
    }

    function showState(title, text, actionLabel, onAction) {
        el.table.hidden = true;
        el.stateBox.hidden = false;
        el.stateBox.innerHTML = `<strong>${esc(title)}</strong>${esc(text)}`;
        if (actionLabel) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn btn-quiet";
            btn.textContent = actionLabel;
            btn.addEventListener("click", onAction);
            el.stateBox.appendChild(document.createElement("br"));
            el.stateBox.appendChild(btn);
        }
    }

    function render() {
        const q = el.search.value.trim().toLowerCase();

        const list = state.users
            .filter((u) => !q || displayName(u).toLowerCase().includes(q) ||
                String(u.username || "").toLowerCase().includes(q))
            .sort((a, b) => displayName(a).localeCompare(displayName(b)));

        state.visible = list;

        // drop selections for accounts that no longer exist
        const existing = new Set(state.users.map(keyOf));
        state.selected.forEach((k) => { if (!existing.has(k)) state.selected.delete(k); });

        const total = state.users.length;
        el.count.textContent = list.length === total
            ? `${total} ${total === 1 ? "account" : "accounts"}`
            : `${list.length} of ${total} accounts`;

        if (total === 0) {
            showState("No accounts yet", "Create the first account to get started.", "Create account", openCreate);
            return;
        }
        if (list.length === 0) {
            showState("No accounts match", "Try a different name or username.", "Clear search", () => {
                el.search.value = "";
                render();
            });
            return;
        }

        el.stateBox.hidden = true;
        el.table.hidden = false;
        el.rows.innerHTML = list.map(rowHtml).join("");
        updateSelectionUi();
    }

    // ====================================================================
    // SELECTION + BULK PASSWORD RESET
    // ====================================================================
    function selectableVisible() {
        return state.visible.filter((u) => !isSelf(u));
    }

    function updateSelectionUi() {
        const n = state.selected.size;
        const btn = $("resetSelectedBtn");
        btn.disabled = n === 0;
        btn.textContent = n > 0
            ? `Reset password to ${DEFAULT_PASSWORD} (${n})`
            : `Reset password to ${DEFAULT_PASSWORD}`;

        const all = $("selectAll");
        const pool = selectableVisible();
        const picked = pool.filter((u) => state.selected.has(keyOf(u))).length;
        all.checked = pool.length > 0 && picked === pool.length;
        all.indeterminate = picked > 0 && picked < pool.length;
        all.disabled = pool.length === 0;
    }

    function openReset() {
        const users = state.users.filter((u) => state.selected.has(keyOf(u)));
        if (users.length === 0) return;

        setAlert("resetAlert", "");
        $("resetText").textContent = users.length === 1
            ? `${displayName(users[0])} (${users[0].username}) will have their password set to ${DEFAULT_PASSWORD}.`
            : `${users.length} accounts will have their password set to ${DEFAULT_PASSWORD}.`;
        $("resetConfirm").disabled = false;
        $("resetConfirm").textContent = `Reset to ${DEFAULT_PASSWORD}`;
        el.resetDlg.showModal();
    }

    // Password-only reset. Calls a dedicated endpoint so department / access
    // level / role are never touched (the normal PUT requires all of them).
    async function resetOne(user) {
        const res = await fetch(`/api/users/${encodeURIComponent(keyOf(user))}/password`, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: DEFAULT_PASSWORD })
        });
        const data = await readJson(res);
        if (res.status === 401) { window.location.href = "/"; throw new Error("unauthorized"); }
        if (!res.ok || (data && data.success === false)) {
            throw new Error((data && data.message) || `HTTP ${res.status}`);
        }
    }

    async function confirmReset() {
        const users = state.users.filter((u) => state.selected.has(keyOf(u)));
        if (users.length === 0) return;

        const btn = $("resetConfirm");
        btn.disabled = true;
        btn.textContent = "Resetting…";
        setAlert("resetAlert", "");

        const failed = [];
        for (const u of users) {
            try {
                await resetOne(u);
                state.selected.delete(keyOf(u));
            } catch (err) {
                console.error(err);
                failed.push(`${u.username}: ${err.message}`);
            }
        }

        const okCount = users.length - failed.length;
        render();

        if (failed.length === 0) {
            el.resetDlg.close();
            toast(`Password reset to ${DEFAULT_PASSWORD} for ${okCount} ${okCount === 1 ? "account" : "accounts"}`);
        } else {
            if (okCount > 0) toast(`Reset ${okCount}, failed ${failed.length}`);
            setAlert("resetAlert", `Couldn't reset ${failed.length} account(s) — ${failed.join("; ")}`);
            $("resetText").textContent = "The accounts that failed are still selected. You can try again.";
            btn.disabled = false;
            btn.textContent = "Try again";
        }
    }

    async function loadUsers(silent) {
        if (!silent) {
            el.count.textContent = "";
            showState("Loading accounts…", "");
        }
        try {
            const res = await fetch("/api/users", { credentials: "same-origin" });
            if (res.status === 401) { window.location.href = "/"; return; }
            if (res.status === 403) { showDenied(); return; }
            if (!res.ok) throw new Error("users " + res.status);
            const data = await res.json();
            state.users = Array.isArray(data) ? data : (data.users || data.data || []);
            render();
        } catch (err) {
            console.error(err);
            showState("Couldn't load accounts", "Check your connection and try again.", "Try again", () => loadUsers());
        }
    }

    // ====================================================================
    // TOASTS
    // ====================================================================
    function toast(message) {
        const node = document.createElement("div");
        node.className = "toast";
        node.textContent = message;
        $("toastRegion").appendChild(node);
        setTimeout(() => node.remove(), 4200);
    }

    function setAlert(id, message) {
        const box = $(id);
        box.textContent = message || "";
        box.className = message ? "alert error" : "alert";
    }

    // ====================================================================
    // SHARED FORM LOGIC (used by both the Create and Edit dialogs)
    // ----------------------------------------------------------------
    // Every field id below is prefixed "nu" on the Create form and "eu" on
    // the Edit form (e.g. nuDepartment / euDepartment), so these helpers
    // take that prefix and work for either one.
    // ====================================================================
    function selectedRole(prefix) {
        return document.querySelector(`input[name='${prefix}Role']:checked`)?.value || "Viewer";
    }

    function checkStrength(value) {
        const fill = $("strengthFill");
        const label = $("strengthLabel");
        if (!fill || !label) return;
        let score = 0;
        if (value.length >= 8) score++;
        if (/[A-Z]/.test(value)) score++;
        if (/[0-9]/.test(value)) score++;
        if (/[^A-Za-z0-9]/.test(value)) score++;

        const levels = [
            { w: "0%",   bg: "transparent", txt: "Enter a password" },
            { w: "25%",  bg: "#f87171", txt: "Weak" },
            { w: "50%",  bg: "#fb923c", txt: "Fair" },
            { w: "75%",  bg: "#facc15", txt: "Good" },
            { w: "100%", bg: "#4ade80", txt: "Strong" }
        ];
        const lvl = value.length === 0 ? levels[0] : (levels[score] || levels[4]);
        fill.style.width = lvl.w;
        fill.style.background = lvl.bg;
        label.textContent = lvl.txt;
    }

    // Rebuilds the Access Level options to match what the server accepts for
    // the chosen department + role (same rules the old register form used):
    //   ADMINISTRATION -> GLOBAL only (locked)
    //   PRODUCTION     -> Line, Section, Department (+ Global if Admin)
    //   QUALITY        -> Line, Department (+ Global if Admin)
    //   TECHNICAL      -> Department (+ Global if Admin)
    function populateAccessLevels(prefix, keepValue) {
        const department = $(prefix + "Department").value;
        const role = selectedRole(prefix);
        const select = $(prefix + "AccessLevel");
        const previous = keepValue !== undefined ? keepValue : select.value;

        select.disabled = false;

        if (!department) {
            select.innerHTML = '<option value="">Select department first…</option>';
            toggleScopeFields(prefix, "");
            return;
        }

        let levels;
        if (department === "ADMINISTRATION") {
            levels = ["GLOBAL"];
        } else if (department === "PRODUCTION") {
            levels = ["LINE", "SECTION", "DEPARTMENT"];
            if (role === "Admin") levels.push("GLOBAL");
        } else if (department === "QUALITY") {
            levels = ["LINE", "DEPARTMENT"];
            if (role === "Admin") levels.push("GLOBAL");
        } else {
            levels = ["DEPARTMENT"];
            if (role === "Admin") levels.push("GLOBAL");
        }

        select.innerHTML = '<option value="">Select access level…</option>' +
            levels.map((l) => `<option value="${l}">${esc(ACCESS_LEVEL_LABELS[l])}</option>`).join("");

        if (department === "ADMINISTRATION") {
            select.value = "GLOBAL";
            select.disabled = true;
        } else if (levels.includes(previous)) {
            select.value = previous;
        }

        toggleScopeFields(prefix, select.value);
    }

    function toggleScopeFields(prefix, level, keepLine) {
        $(prefix + "LineShiftFields").style.display = level === "LINE" ? "grid" : "none";
        $(prefix + "SectionField").style.display = level === "SECTION" ? "block" : "none";

        if (level === "LINE") {
            const department = $(prefix + "Department").value;
            if (department) loadAvailableLines(prefix, department, keepLine);
        }
    }

    let lineRequestId = 0;
    async function loadAvailableLines(prefix, department, keepValue) {
        const select = $(prefix + "Line");
        const previous = keepValue !== undefined ? keepValue : select.value;
        const requestId = ++lineRequestId;

        select.innerHTML = '<option value="">Loading lines…</option>';
        select.disabled = true;

        try {
            const res = await fetch(`/api/available-lines?department=${encodeURIComponent(department)}`, { credentials: "same-origin" });
            const data = await res.json();
            if (requestId !== lineRequestId) return; // a newer request superseded this one

            const lines = (data && data.lines) || [];
            if (lines.length === 0) {
                select.innerHTML = '<option value="">No lines found for this department</option>';
                return;
            }

            select.innerHTML = '<option value="">Select line…</option>' +
                lines.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
            select.disabled = false;
            if (lines.includes(previous)) select.value = previous;
        } catch (err) {
            if (requestId !== lineRequestId) return;
            select.innerHTML = '<option value="">Couldn\'t load lines. Try again.</option>';
        }
    }

    function updateRoleHint(prefix) {
        $(prefix + "RoleHint").textContent = ROLE_HINTS[selectedRole(prefix)] || "";
    }

    // ====================================================================
    // CREATE ACCOUNT
    // ====================================================================
    function resetCreateForm() {
        $("createForm").reset();
        setAlert("createAlert", "");
        checkStrength("");
        updateRoleHint("nu");
        populateAccessLevels("nu");
    }

    function openCreate() {
        resetCreateForm();
        el.createDlg.showModal();
    }

    function validateCreate(v) {
        if (!v.first_name || !v.last_name || !v.username || !v.password || !v.confirm || !v.department || !v.access_level) {
            return "Fill in all required fields, including department and access level.";
        }
        if (v.access_level === "LINE" && (!v.assigned_line || !v.assigned_shift)) {
            return "Choose both a line and a shift for Line-level access.";
        }
        if (v.access_level === "SECTION" && !v.assigned_section) {
            return "Choose a section for Section-level access.";
        }
        if (v.password.length < 6) return "Password must be at least 6 characters.";
        if (v.password !== v.confirm) return "Passwords don't match.";
        return "";
    }

    async function submitCreate(event) {
        event.preventDefault();

        const v = {
            first_name: $("nuFirst").value.trim(),
            last_name: $("nuLast").value.trim(),
            username: $("nuUsername").value.trim(),
            password: $("nuPassword").value,
            confirm: $("nuConfirm").value,
            roles: selectedRole("nu"),
            department: $("nuDepartment").value,
            access_level: $("nuAccessLevel").value,
            assigned_line: $("nuLine").value.trim(),
            assigned_shift: $("nuShift").value,
            assigned_section: $("nuSection").value
        };

        const problem = validateCreate(v);
        if (problem) { setAlert("createAlert", problem); return; }
        setAlert("createAlert", "");

        const btn = $("createSubmit");
        btn.disabled = true;
        btn.textContent = "Creating account…";

        try {
            const res = await fetch("/api/users", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    first_name: v.first_name,
                    last_name: v.last_name,
                    username: v.username,
                    password: v.password,
                    roles: v.roles,
                    department: v.department,
                    access_level: v.access_level,
                    assigned_line:    v.access_level === "LINE"    ? v.assigned_line    : null,
                    assigned_shift:   v.access_level === "LINE"    ? v.assigned_shift   : null,
                    assigned_section: v.access_level === "SECTION" ? v.assigned_section : null
                })
            });
            const data = await readJson(res);

            if (res.status === 401) { window.location.href = "/"; return; }
            if (res.status === 403) {
                setAlert("createAlert", "You don't have permission to create accounts.");
            } else if (res.ok && data && data.success !== false) {
                el.createDlg.close();
                toast(`Account created for ${v.first_name} ${v.last_name}`);
                loadUsers(true);
            } else {
                setAlert("createAlert", (data && data.message) || "Couldn't create the account. Try again.");
            }
        } catch (err) {
            console.error(err);
            setAlert("createAlert", "Network error. Check your connection and try again.");
        } finally {
            btn.disabled = false;
            btn.textContent = "Create account";
        }
    }

    // ====================================================================
    // EDIT ACCOUNT
    // ====================================================================
    // NOTE: passwords are hashed server-side, so there is nothing to "show"
    // for the existing password -- euPassword is left blank and only sets a
    // *new* password when the admin types one in.
    function openEdit(key) {
        const user = state.users.find((u) => keyOf(u) === key);
        if (!user) return;

        state.editing = user;
        setAlert("editAlert", "");

        $("euFirst").value = user.first_name || "";
        $("euLast").value = user.last_name || "";
        $("euUsername").value = user.username || "";
        $("euPassword").value = "";

        const role = roleOf(user) || "Viewer";
        const roleRadio = document.querySelector(`input[name='euRole'][value='${role}']`);
        if (roleRadio) roleRadio.checked = true;
        else $("euRoleViewer").checked = true;
        updateRoleHint("eu");

        const department = String(user.department || "").toUpperCase();
        $("euDepartment").value = department;
        populateAccessLevels("eu", String(user.access_level || "").toUpperCase());

        const level = String(user.access_level || "").toUpperCase();
        if (level === "LINE") {
            $("euShift").value = user.assigned_shift || "";
            loadAvailableLines("eu", department, user.assigned_line || "");
        } else if (level === "SECTION") {
            $("euSection").value = String(user.assigned_section || "").toUpperCase();
        }

        el.editDlg.showModal();
    }

    function validateEdit(v) {
        if (!v.first_name || !v.last_name || !v.username || !v.department || !v.access_level) {
            return "Fill in all required fields, including department and access level.";
        }
        if (v.access_level === "LINE" && (!v.assigned_line || !v.assigned_shift)) {
            return "Choose both a line and a shift for Line-level access.";
        }
        if (v.access_level === "SECTION" && !v.assigned_section) {
            return "Choose a section for Section-level access.";
        }
        if (v.password && v.password.length < 6) return "Password must be at least 6 characters.";
        return "";
    }

    async function submitEdit(event) {
        event.preventDefault();
        const user = state.editing;
        if (!user) return;

        const v = {
            first_name: $("euFirst").value.trim(),
            last_name: $("euLast").value.trim(),
            username: $("euUsername").value.trim(),
            password: $("euPassword").value, // "" means "leave unchanged"
            roles: selectedRole("eu"),
            department: $("euDepartment").value,
            access_level: $("euAccessLevel").value,
            assigned_line: $("euLine").value.trim(),
            assigned_shift: $("euShift").value,
            assigned_section: $("euSection").value
        };

        const problem = validateEdit(v);
        if (problem) { setAlert("editAlert", problem); return; }
        setAlert("editAlert", "");

        const btn = $("editSubmit");
        btn.disabled = true;
        btn.textContent = "Saving…";

        try {
            const res = await fetch(`/api/users/${encodeURIComponent(keyOf(user))}`, {
                method: "PUT",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    first_name: v.first_name,
                    last_name: v.last_name,
                    username: v.username,
                    password: v.password || null, // null/omitted -> keep current password
                    roles: v.roles,
                    department: v.department,
                    access_level: v.access_level,
                    assigned_line:    v.access_level === "LINE"    ? v.assigned_line    : null,
                    assigned_shift:   v.access_level === "LINE"    ? v.assigned_shift   : null,
                    assigned_section: v.access_level === "SECTION" ? v.assigned_section : null
                })
            });
            const data = await readJson(res);

            if (res.status === 401) { window.location.href = "/"; return; }
            if (res.status === 403) {
                setAlert("editAlert", "You don't have permission to edit accounts.");
            } else if (res.ok && data && data.success !== false) {
                el.editDlg.close();
                toast(`Account updated for ${v.first_name} ${v.last_name}`);
                state.editing = null;
                loadUsers(true);
            } else {
                setAlert("editAlert", (data && data.message) || "Couldn't save changes. Try again.");
            }
        } catch (err) {
            console.error(err);
            setAlert("editAlert", "Network error. Check your connection and try again.");
        } finally {
            btn.disabled = false;
            btn.textContent = "Save changes";
        }
    }

    // ====================================================================
    // DELETE ACCOUNT
    // ====================================================================
    function openDelete(key) {
        const user = state.users.find((u) => keyOf(u) === key);
        if (!user || isSelf(user)) return;

        state.pendingDelete = user;
        setAlert("deleteAlert", "");
        $("deleteText").textContent =
            `${displayName(user)} (${user.username}) will no longer be able to sign in. This can't be undone.`;
        $("deleteConfirm").disabled = false;
        $("deleteConfirm").textContent = "Delete account";
        el.deleteDlg.showModal();
    }

    async function confirmDelete() {
        const user = state.pendingDelete;
        if (!user) return;

        const btn = $("deleteConfirm");
        btn.disabled = true;
        btn.textContent = "Deleting account…";
        setAlert("deleteAlert", "");

        try {
            const res = await fetch(`/api/users/${encodeURIComponent(keyOf(user))}`, {
                method: "DELETE",
                credentials: "same-origin"
            });
            const data = await readJson(res);

            if (res.status === 401) { window.location.href = "/"; return; }
            if (res.ok && (!data || data.success !== false)) {
                el.deleteDlg.close();
                state.users = state.users.filter((u) => keyOf(u) !== keyOf(user));
                render();
                toast(`Account deleted for ${displayName(user)}`);
                state.pendingDelete = null;
            } else {
                setAlert("deleteAlert", res.status === 403
                    ? "You don't have permission to delete accounts."
                    : ((data && data.message) || "Couldn't delete the account. Try again."));
                btn.disabled = false;
                btn.textContent = "Delete account";
            }
        } catch (err) {
            console.error(err);
            setAlert("deleteAlert", "Network error. Check your connection and try again.");
            btn.disabled = false;
            btn.textContent = "Delete account";
        }
    }

    // ====================================================================
    // EVENTS
    // ====================================================================
    function wireEvents() {
        $("createBtn").addEventListener("click", openCreate);
        $("createClose").addEventListener("click", () => el.createDlg.close());
        $("createCancel").addEventListener("click", () => el.createDlg.close());
        $("createForm").addEventListener("submit", submitCreate);

        $("nuDepartment").addEventListener("change", () => populateAccessLevels("nu"));
        $("nuAccessLevel").addEventListener("change", () => toggleScopeFields("nu", $("nuAccessLevel").value));
        document.querySelectorAll("input[name='nuRole']").forEach((r) =>
            r.addEventListener("change", () => { updateRoleHint("nu"); populateAccessLevels("nu"); }));
        $("nuPassword").addEventListener("input", (e) => checkStrength(e.target.value));

        $("editClose").addEventListener("click", () => el.editDlg.close());
        $("editCancel").addEventListener("click", () => el.editDlg.close());
        $("editForm").addEventListener("submit", submitEdit);

        $("euDepartment").addEventListener("change", () => populateAccessLevels("eu"));
        $("euAccessLevel").addEventListener("change", () => toggleScopeFields("eu", $("euAccessLevel").value));
        document.querySelectorAll("input[name='euRole']").forEach((r) =>
            r.addEventListener("change", () => { updateRoleHint("eu"); populateAccessLevels("eu"); }));

        $("deleteClose").addEventListener("click", () => el.deleteDlg.close());
        $("deleteCancel").addEventListener("click", () => el.deleteDlg.close());
        $("deleteConfirm").addEventListener("click", confirmDelete);
        // Clicking the dimmed backdrop dismisses the delete prompt (nothing typed to lose).
        el.deleteDlg.addEventListener("click", (e) => { if (e.target === el.deleteDlg) el.deleteDlg.close(); });

        el.rows.addEventListener("click", (e) => {
            const editBtn = e.target.closest("[data-edit]");
            if (editBtn) { openEdit(editBtn.getAttribute("data-edit")); return; }
            const delBtn = e.target.closest("[data-delete]");
            if (delBtn && !delBtn.disabled) openDelete(delBtn.getAttribute("data-delete"));
        });

        el.search.addEventListener("input", render);

        // bulk password reset
        el.rows.addEventListener("change", (e) => {
            const box = e.target.closest("[data-select]");
            if (!box) return;
            const key = box.getAttribute("data-select");
            if (box.checked) state.selected.add(key); else state.selected.delete(key);
            updateSelectionUi();
        });
        $("selectAll").addEventListener("change", (e) => {
            selectableVisible().forEach((u) => {
                if (e.target.checked) state.selected.add(keyOf(u)); else state.selected.delete(keyOf(u));
            });
            render();
        });
        $("resetSelectedBtn").addEventListener("click", openReset);
        $("resetClose").addEventListener("click", () => el.resetDlg.close());
        $("resetCancel").addEventListener("click", () => el.resetDlg.close());
        $("resetConfirm").addEventListener("click", confirmReset);
    }

    document.addEventListener("DOMContentLoaded", init);
})();