// ============================================================
// SIDEBAR SETTINGS
// ============================================================
const SIDEBAR_MOBILE_MQ = "(max-width: 480px)";
const SIDEBAR_AUTO_RAIL_MAX = 900;               // 481-900px: icon rail by default
const SIDEBAR_COLLAPSE_KEY = "sidebar-collapsed";
const ATTENDANCE_NOTIF_POLL_MS = 30 * 1000;      // shared across all pages, keep it cheap
const ME_CACHE_MS = 5 * 60 * 1000;               // /api/me is re-checked at most every 5 min
// Shown in the Help dialog. Replace with your real support contact.
const SUPPORT_CONTACT = "Need more help? Contact your system administrator or HR.";

// --vh mirrors the real visible viewport height so the fixed sidebar
// never runs short or tall on mobile (address bar show/hide, etc).
//
// IMPORTANT: this must NOT be derived from anything that can shrink
// because of page *content* (e.g. a horizontal scrollbar appearing on
// a wide table/chart eats into window.innerHeight). window.visualViewport
// is the actual on-screen viewport and is NOT affected by page layout.
function setSidebarVh() {
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty("--vh", `${h * 0.01}px`);
}
setSidebarVh();

if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setSidebarVh);
} else {
    window.addEventListener("resize", setSidebarVh);
}
window.addEventListener("orientationchange", setSidebarVh);

// ============================================================
// SMALL HELPERS (layout state, accessibility)
// ============================================================
function isMobileView() {
    return window.matchMedia(SIDEBAR_MOBILE_MQ).matches;
}

function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function hideHoverPanel() {
    document.getElementById("sidebarHoverPanel")?.classList.remove("visible");
}

// null = user never chose, true/false = explicit choice
function readCollapsePref() {
    try {
        const v = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
        return v === "true" ? true : (v === "false" ? false : null);
    } catch (e) {
        return null;
    }
}

// Same rule as the inline script in sidebar.html.
function shouldRailCollapse() {
    if (isMobileView()) return false;
    const pref = readCollapsePref();
    if (pref !== null) return pref;
    return window.innerWidth <= SIDEBAR_AUTO_RAIL_MAX;
}

// Items inside a collapsed section are invisible but would still be
// reachable with Tab -- mark them inert so keyboard focus skips them.
function syncSectionInert() {
    const filtering = document.body.classList.contains("sidebar-filtering");
    const rail = document.body.classList.contains("sidebar-collapsed");
    document.querySelectorAll(".menu-section").forEach(section => {
        const itemsEl = section.querySelector(".menu-section-items");
        if (!itemsEl) return;
        const hidden = section.classList.contains("collapsed") && !filtering && !rail;
        itemsEl.toggleAttribute("inert", hidden);
    });
}

// A closed mobile drawer sits off-screen; keep it out of the tab order
// and away from screen readers until it's opened.
function syncDrawerA11y() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    const closedDrawer = isMobileView() && !document.body.classList.contains("sidebar-open");
    sidebar.toggleAttribute("inert", closedDrawer);
    if (closedDrawer) {
        sidebar.setAttribute("aria-hidden", "true");
    } else {
        sidebar.removeAttribute("aria-hidden");
    }
}

function applyRailState() {
    const collapsed = shouldRailCollapse();
    document.body.classList.toggle("sidebar-collapsed", collapsed);

    const toggle = document.querySelector(".sidebar-collapse-toggle");
    if (toggle) {
        const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", label);
        toggle.title = label;
    }

    // Parts that are visually folded away in the rail must not be focusable.
    document.querySelectorAll(
        ".sidebar-search, .sidebar-search-empty, .language-picker, .sidebar-footer, .menu-section-header"
    ).forEach(el => el.toggleAttribute("inert", collapsed));

    syncSectionInert();
    hideHoverPanel();
}

function setRailCollapsed(collapsed) {
    try {
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "true" : "false");
    } catch (e) {
        // Storage unavailable -- toggle still works for this view.
    }
    applyRailState();
}

// ============================================================
// DIALOG (logout confirmation + help) -- replaces window.confirm()
// ============================================================
let sidebarModalState = null;

function openSidebarModal({ title, body, confirmText = "OK", cancelText = "Cancel",
                            variant = "primary", hideCancel = false, focus = "confirm", onConfirm = null }) {
    const modal = document.getElementById("sidebarModal");
    const titleEl = document.getElementById("sidebarModalTitle");
    const bodyEl = document.getElementById("sidebarModalBody");
    const confirmBtn = document.getElementById("sidebarModalConfirm");
    const cancelBtn = document.getElementById("sidebarModalCancel");

    if (!modal || !titleEl || !bodyEl || !confirmBtn || !cancelBtn) {
        // Markup missing on this page -- fall back to the browser dialog.
        if (onConfirm && window.confirm(typeof body === "string" ? body : title)) onConfirm();
        return;
    }

    titleEl.textContent = title;
    bodyEl.textContent = "";
    if (body instanceof Node) {
        bodyEl.appendChild(body);
    } else {
        bodyEl.textContent = body || "";
    }

    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("sm-btn-danger", variant === "danger");
    confirmBtn.classList.toggle("sm-btn-primary", variant !== "danger");
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = hideCancel;

    sidebarModalState = { onConfirm, lastFocus: document.activeElement };
    modal.hidden = false;
    hideHoverPanel();
    (focus === "cancel" && !hideCancel ? cancelBtn : confirmBtn).focus();
}

function closeSidebarModal() {
    const modal = document.getElementById("sidebarModal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    const last = sidebarModalState && sidebarModalState.lastFocus;
    sidebarModalState = null;
    if (last && typeof last.focus === "function") last.focus();
}

function initSidebarModal() {
    const modal = document.getElementById("sidebarModal");
    if (!modal) return;

    document.getElementById("sidebarModalConfirm")?.addEventListener("click", () => {
        const cb = sidebarModalState && sidebarModalState.onConfirm;
        closeSidebarModal();
        if (cb) cb();
    });
    document.getElementById("sidebarModalCancel")?.addEventListener("click", closeSidebarModal);
    document.getElementById("sidebarModalBackdrop")?.addEventListener("click", closeSidebarModal);

    modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeSidebarModal();
            return;
        }
        if (e.key === "Tab") {
            // Keep focus inside the dialog.
            const buttons = Array.from(modal.querySelectorAll("button")).filter(b => !b.hidden);
            if (!buttons.length) return;
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });
}

function showSidebarHelp() {
    const wrap = document.createElement("div");
    const dl = document.createElement("dl");
    const rows = [
        ["Search", "Press / or Ctrl+K to find a page. Enter opens the first match, and \u2191 \u2193 move between results."],
        ["Collapse the menu", "Use the round arrow on the sidebar edge to shrink it to icons. Hover an icon to see what the page does."],
        ["Red number on Attendance Logs", "Time-in/time-out correction requests waiting for your approval. A grey ! means the count could not be loaded; it retries automatically."],
        ["Access line under your name", "Your access level. It decides which pages and employee records you can see."],
        ["Keyboard", "Esc closes menus and dialogs. ? opens this help."]
    ];
    rows.forEach(([term, desc]) => {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = desc;
        dl.appendChild(dt);
        dl.appendChild(dd);
    });
    wrap.appendChild(dl);

    const p = document.createElement("p");
    p.textContent = SUPPORT_CONTACT;
    wrap.appendChild(p);

    openSidebarModal({
        title: "Using the menu",
        body: wrap,
        confirmText: "Got it",
        hideCancel: true
    });
}

function logoutUser(e) {
    if (e && e.preventDefault) e.preventDefault();

    openSidebarModal({
        title: "Log out?",
        body: "You will be signed out of Time Hub Network. Any unsaved changes on this page will be lost.",
        confirmText: "Log out",
        cancelText: "Stay signed in",
        variant: "danger",
        focus: "cancel",
        onConfirm: () => { window.location.href = "/logout"; }
    });
}

// ============================================================
// MAIN WIRING
// ============================================================
document.addEventListener("DOMContentLoaded", () => {

    const toggle = document.querySelector(".sidebar-toggle");
    const sidebar = document.querySelector(".sidebar");
    const closeBtn = document.querySelector(".sidebar-close");

    // Backdrop so the mobile drawer can be dismissed by tapping outside.
    let backdrop = document.querySelector(".sidebar-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.className = "sidebar-backdrop";
        document.body.appendChild(backdrop);
    }

    function openSidebar() {
        document.body.classList.add("sidebar-open");
        toggle?.setAttribute("aria-expanded", "true");
        syncDrawerA11y();
        closeBtn?.focus({ preventScroll: true });
    }

    function closeSidebar(returnFocus) {
        const wasOpen = document.body.classList.contains("sidebar-open");
        document.body.classList.remove("sidebar-open");
        toggle?.setAttribute("aria-expanded", "false");
        syncDrawerA11y();
        if (wasOpen && returnFocus === true) toggle?.focus({ preventScroll: true });
    }

    toggle?.addEventListener("click", () => {
        setSidebarVh(); // refresh before toggling
        if (document.body.classList.contains("sidebar-open")) {
            closeSidebar(true);
        } else {
            openSidebar();
        }
    });

    closeBtn?.addEventListener("click", () => closeSidebar(true));
    backdrop.addEventListener("click", () => closeSidebar(true));

    // Swipe left inside the open drawer to close it.
    let touchX = null;
    let touchY = null;
    sidebar?.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        touchX = t.clientX;
        touchY = t.clientY;
    }, { passive: true });
    sidebar?.addEventListener("touchend", (e) => {
        if (touchX === null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchX;
        const dy = t.clientY - touchY;
        touchX = touchY = null;
        if (document.body.classList.contains("sidebar-open") && dx < -60 && Math.abs(dy) < 40) {
            closeSidebar(true);
        }
    }, { passive: true });

    // Desktop icon-rail toggle (initial state already restored inline).
    document.querySelector(".sidebar-collapse-toggle")?.addEventListener("click", () => {
        setRailCollapsed(!document.body.classList.contains("sidebar-collapsed"));
    });

    // Search icon in the rail: expand, then focus the search box.
    document.getElementById("railSearchBtn")?.addEventListener("click", () => {
        setRailCollapsed(false);
        const input = document.getElementById("sidebarSearchInput");
        input?.focus();
        setTimeout(() => input?.focus(), 260);
    });

    function focusSearch() {
        const input = document.getElementById("sidebarSearchInput");
        if (!input) return;
        if (isMobileView()) {
            openSidebar();
        } else if (document.body.classList.contains("sidebar-collapsed")) {
            setRailCollapsed(false);
        }
        input.focus();
        input.select();
        setTimeout(() => input.focus(), 260);
    }

    // Global shortcuts: "/" or Ctrl/Cmd+K = search, "?" = help, Esc = close.
    document.addEventListener("keydown", (e) => {
        const modalOpen = !document.getElementById("sidebarModal")?.hidden;

        if (e.key === "Escape") {
            hideHoverPanel();
            if (!modalOpen && document.body.classList.contains("sidebar-open")) {
                closeSidebar(true);
            }
            return;
        }
        if (modalOpen || e.altKey) return;

        if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            focusSearch();
            return;
        }
        if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey) return;

        if (e.key === "/") {
            e.preventDefault();
            focusSearch();
        } else if (e.key === "?") {
            e.preventDefault();
            showSidebarHelp();
        }
    });

    // Resize: keep rail / drawer state consistent with the viewport.
    let lastIsMobile = isMobileView();
    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const nowMobile = isMobileView();
            if (lastIsMobile && !nowMobile) closeSidebar(false);
            lastIsMobile = nowMobile;
            applyRailState();
            syncDrawerA11y();
        }, 80);
    });

    // NOTE: active-item highlighting and the initial section/rail state are
    // set by the inline <script> in sidebar.html, before first paint. Here
    // we only wire up the clicks.
    document.querySelectorAll(".menu-section").forEach((section, index) => {

        const header = section.querySelector(".menu-section-header");
        if (!header || section.classList.contains("section-static")) return;

        const sectionId = header.dataset.section || String(index);
        const storageKey = `sidebar-section-${sectionId}`;

        header.addEventListener("click", () => {
            section.classList.toggle("collapsed");
            const collapsed = section.classList.contains("collapsed");
            header.setAttribute("aria-expanded", String(!collapsed));

            try {
                localStorage.setItem(storageKey, collapsed ? "collapsed" : "expanded");
            } catch (e) {
                // Storage unavailable -- works for this page view only.
            }
            syncSectionInert();
        });
    });

    // Menu items: close the drawer on tap, subtle hover nudge, arrow-key nav.
    const menuItems = Array.from(document.querySelectorAll(".menu-item"));

    menuItems.forEach(item => {
        item.addEventListener("click", () => closeSidebar(false));

        item.addEventListener("mouseenter", () => {
            if (prefersReducedMotion()) return;
            item.animate(
                [{ transform: "translateX(0px)" }, { transform: "translateX(4px)" }],
                { duration: 180, fill: "forwards", easing: "ease-out" }
            );
        });

        item.addEventListener("mouseleave", () => {
            if (prefersReducedMotion()) return;
            item.animate(
                [{ transform: "translateX(4px)" }, { transform: "translateX(0px)" }],
                { duration: 180, fill: "forwards", easing: "ease-out" }
            );
        });
    });

    sidebar?.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const current = e.target.closest?.(".menu-item");
        if (!current) return;

        const navigable = menuItems.filter(i =>
            !i.hidden &&
            !i.hasAttribute("data-search-hidden") &&
            !i.closest(".menu-section-items[inert]")
        );
        const idx = navigable.indexOf(current);
        if (idx === -1) return;

        e.preventDefault();
        if (e.key === "ArrowDown") {
            navigable[Math.min(idx + 1, navigable.length - 1)]?.focus();
        } else if (idx === 0) {
            const input = document.getElementById("sidebarSearchInput");
            if (input && !input.closest("[inert]")) input.focus();
        } else {
            navigable[idx - 1]?.focus();
        }
    });

    // Logout + help buttons
    document.getElementById("logoutBtn")?.addEventListener("click", logoutUser);
    document.getElementById("sidebarHelpBtn")?.addEventListener("click", showSidebarHelp);

    // Back/forward cache: force a reload so Flask can re-check the session.
    window.addEventListener("pageshow", function (event) {
        const nav = performance.getEntriesByType("navigation")[0];
        if (event.persisted || (nav && nav.type === "back_forward")) {
            window.location.reload();
        }
    });

    initSidebarModal();
    initSidebarHoverPanels();
    initSidebarSearch();
    syncLanguageSelect();
    applyRailState();
    syncDrawerA11y();

    // Profile + approvals (share one cached /api/me request).
    updateSidebarUserInfo();
    updateAttendanceNotifDot();
    startNotifPolling();
});

// ============================================================
// SIDEBAR SEARCH / FILTER
// ============================================================
// Matches the page name, its short description and its hover text, so
// "export", "late" or "upload" also find the right page. Enter opens the
// first match, the arrow keys move between results, "x" clears.
function initSidebarSearch() {
    const input = document.getElementById("sidebarSearchInput");
    const emptyMsg = document.getElementById("sidebarSearchEmpty");
    if (!input || !emptyMsg) return; // sidebar markup not updated on this page yet

    const wrap = input.closest(".sidebar-search");
    const clearBtn = wrap?.querySelector(".sidebar-search-clear");
    const items = Array.from(document.querySelectorAll(".menu-item"));

    // Remember each label so highlighting can always restore it.
    items.forEach(item => {
        const label = item.querySelector(".label");
        if (label) label.dataset.original = label.textContent;
    });

    const haystack = (item) => [
        item.querySelector(".label")?.dataset.original || "",
        item.querySelector(".desc")?.textContent || "",
        (item.getAttribute("data-tooltip") || "").replace("||", " ")
    ].join(" ").toLowerCase();

    const visibleMatches = () =>
        items.filter(i => !i.hidden && !i.hasAttribute("data-search-hidden"));

    function highlight(labelEl, words) {
        const text = labelEl.dataset.original || "";
        labelEl.textContent = "";
        const lower = text.toLowerCase();
        const word = words.find(w => lower.includes(w));
        if (!word) {
            labelEl.textContent = text;
            return;
        }
        const at = lower.indexOf(word);
        labelEl.appendChild(document.createTextNode(text.slice(0, at)));
        const mark = document.createElement("mark");
        mark.textContent = text.slice(at, at + word.length);
        labelEl.appendChild(mark);
        labelEl.appendChild(document.createTextNode(text.slice(at + word.length)));
    }

    function run() {
        const raw = input.value.trim();
        const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
        wrap?.classList.toggle("has-value", input.value.length > 0);

        if (!words.length) {
            document.body.classList.remove("sidebar-filtering");
            items.forEach(item => {
                item.removeAttribute("data-search-hidden");
                const label = item.querySelector(".label");
                if (label) label.textContent = label.dataset.original || label.textContent;
            });
            document.querySelectorAll(".menu-section[data-search-empty]")
                .forEach(s => s.removeAttribute("data-search-empty"));
            emptyMsg.style.display = "none";
            syncSectionInert();
            return;
        }

        document.body.classList.add("sidebar-filtering");

        let anyVisible = false;
        items.forEach(item => {
            const label = item.querySelector(".label");
            const hay = haystack(item);
            const matches = !item.hidden && words.every(w => hay.includes(w));
            if (matches) {
                item.removeAttribute("data-search-hidden");
                anyVisible = true;
                if (label) highlight(label, words);
            } else {
                item.setAttribute("data-search-hidden", "");
                if (label) label.textContent = label.dataset.original || label.textContent;
            }
        });

        document.querySelectorAll(".menu-section").forEach(section => {
            const hasMatch = section.querySelector(".menu-item:not([data-search-hidden]):not([hidden])");
            section.toggleAttribute("data-search-empty", !hasMatch);
        });

        emptyMsg.textContent = `No page matches \u201C${raw}\u201D. Try a shorter word.`;
        emptyMsg.style.display = anyVisible ? "none" : "block";
        syncSectionInert();
    }

    function clearSearch() {
        input.value = "";
        run();
    }

    input.addEventListener("input", run);

    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && input.value) {
            clearSearch();
            e.stopPropagation();
        } else if (e.key === "Enter") {
            const first = visibleMatches()[0];
            if (input.value.trim() && first) {
                e.preventDefault();
                first.click();
            }
        } else if (e.key === "ArrowDown") {
            const first = visibleMatches().find(i => !i.closest(".menu-section-items[inert]"));
            if (first) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    clearBtn?.addEventListener("click", () => {
        clearSearch();
        input.focus();
    });
}

// ============================================================
// LANGUAGE SELECT SYNC
// ============================================================
// Reflects whichever language i18n.js actually persisted instead of
// always showing English after a reload.
function syncLanguageSelect() {
    const select = document.querySelector("[data-language-select]");
    if (!select) return;

    let current = "en";
    try {
        if (window.i18n && typeof window.i18n.getLanguage === "function") {
            current = window.i18n.getLanguage() || current;
        } else {
            current = localStorage.getItem("lang") || current;
        }
    } catch (e) {
        // Storage/i18n unavailable -- keep the "en" default.
    }

    if ([...select.options].some(opt => opt.value === current)) {
        select.value = current;
    }
}

// ============================================================
// SIDEBAR MENU HOVER / FOCUS SUMMARY PANEL
// ============================================================
// Any .menu-item with data-tooltip="Title||Body" gets a floating summary
// on hover AND on keyboard focus. An optional data-extra="..." (set by
// the approvals badge code) adds a live status line under the text.
//
// Positioned with position:fixed + getBoundingClientRect() because
// .sidebar has overflow-y:auto, which would clip an absolutely
// positioned child spilling past its right edge.
//
// Disabled on mobile (CSS) -- the drawer shows a short description under
// each label instead, since touch has no hover.
function initSidebarHoverPanels() {

    const panel = document.getElementById("sidebarHoverPanel");
    const titleEl = document.getElementById("sidebarHoverPanelTitle");
    const bodyEl = document.getElementById("sidebarHoverPanelBody");
    const extraEl = document.getElementById("sidebarHoverPanelExtra");
    if (!panel || !titleEl || !bodyEl) return;

    const items = document.querySelectorAll(".menu-item[data-tooltip]");
    let hideTimer = null;
    let showTimer = null;

    function positionPanel(item) {
        const rect = item.getBoundingClientRect();

        panel.style.left = `${rect.right + 14}px`;
        panel.style.top = `${rect.top + rect.height / 2}px`;

        // Keep the panel inside the viewport on short screens.
        requestAnimationFrame(() => {
            const panelRect = panel.getBoundingClientRect();
            const margin = 10;

            if (panelRect.top < margin) {
                panel.style.top = `${margin + panelRect.height / 2}px`;
            } else if (panelRect.bottom > window.innerHeight - margin) {
                panel.style.top = `${window.innerHeight - margin - panelRect.height / 2}px`;
            }
        });
    }

    function showPanel(item) {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);

        showTimer = setTimeout(() => {
            const raw = item.getAttribute("data-tooltip") || "";
            const sep = raw.indexOf("||");
            titleEl.textContent = sep === -1 ? raw : raw.slice(0, sep);
            bodyEl.textContent = sep === -1 ? "" : raw.slice(sep + 2);

            if (extraEl) {
                const extra = item.dataset.extra || "";
                extraEl.textContent = extra;
                extraEl.hidden = !extra;
            }

            positionPanel(item);
            panel.classList.add("visible");
        }, 120); // small delay so quick mouse passes don't flash the panel
    }

    function hidePanel() {
        clearTimeout(showTimer);
        hideTimer = setTimeout(() => panel.classList.remove("visible"), 80);
    }

    items.forEach(item => {
        item.addEventListener("mouseenter", () => showPanel(item));
        item.addEventListener("mouseleave", hidePanel);
        // Keyboard users get the same explanation (mouse clicks don't
        // match :focus-visible, so this doesn't double-fire).
        item.addEventListener("focus", () => {
            if (item.matches(":focus-visible")) showPanel(item);
        });
        item.addEventListener("blur", hidePanel);
    });

    // Moving from the item into the panel (e.g. to copy text) keeps it open.
    panel.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    panel.addEventListener("mouseleave", hidePanel);

    // Scrolling the sidebar or toggling a section moves items: just hide.
    document.querySelector(".sidebar")?.addEventListener("scroll", hideHoverPanel);
    document.querySelectorAll(".menu-section-header").forEach(header => {
        header.addEventListener("click", hideHoverPanel);
    });
}

// ============================================================
// SESSION + PROFILE (/api/me is fetched once and cached)
// ============================================================
let sessionExpired = false;
let notifTimer = null;
const meCache = { time: 0, promise: null };

// Resolves to { state: "ok" | "expired" | "error", me }.
// "expired" covers a 401 and also a redirect to an HTML login page that
// comes back as 200 -- both mean the person must log in again.
function getMe(force = false) {
    const now = Date.now();
    if (!force && meCache.promise && now - meCache.time < ME_CACHE_MS) {
        return meCache.promise;
    }
    meCache.time = now;
    meCache.promise = (async () => {
        try {
            const res = await fetch("/api/me", {
                credentials: "same-origin",
                headers: { Accept: "application/json" }
            });
            const isJson = (res.headers.get("content-type") || "").includes("json");
            if (res.status === 401 || (res.ok && !isJson)) return { state: "expired", me: null };
            if (!res.ok) return { state: "error", me: null };
            return { state: "ok", me: await res.json() };
        } catch (err) {
            console.error(err);
            return { state: "error", me: null };
        }
    })().then(result => {
        // Don't cache failures -- the next poll should try again.
        if (result.state !== "ok") meCache.promise = null;
        return result;
    });
    return meCache.promise;
}

function markSessionExpired() {
    if (sessionExpired) return;
    sessionExpired = true;
    stopNotifPolling();

    document.getElementById("sidebarUserProfile")?.classList.remove("is-loading");
    const nameEl = document.getElementById("sidebarUserName");
    const deptEl = document.getElementById("sidebarUserDept");
    const avatarEl = document.getElementById("sidebarUserAvatar");
    const accessEl = document.getElementById("sidebarUserAccess");
    const notice = document.getElementById("sidebarSessionNotice");

    if (nameEl) nameEl.textContent = "Session expired";
    if (deptEl) deptEl.textContent = "Signed out";
    if (avatarEl) avatarEl.textContent = "!";
    if (accessEl) accessEl.hidden = true;
    if (notice) notice.hidden = false;

    setApprovalBadge("none");
}

// Friendly labels for Production's named sub-sections.
const PRODUCTION_SECTION_LABELS = {
    ASSEMBLY:  "Assembly",
    WH:        "WH",
    CC:        "CC",
};

// Production users scoped to a named sub-section (access_level === "SECTION")
// show "Production - Assembly" etc.; everyone else shows the plain
// title-cased department.
function formatSidebarDepartment(me) {
    const dept = (me.department || "").trim().toUpperCase();
    const accessLevel = (me.access_level || "").trim().toUpperCase();

    if (dept === "PRODUCTION" && accessLevel === "SECTION" && me.assigned_section) {
        const sectionKey = me.assigned_section.trim().toUpperCase();
        const label = PRODUCTION_SECTION_LABELS[sectionKey] || me.assigned_section;
        return `Production - ${label}`;
    }

    return dept
        ? dept.charAt(0) + dept.slice(1).toLowerCase()
        : "\u2014";
}

// "Admin \u00B7 Global access", "Line access", ... -- explains why some pages
// are or aren't in the menu.
function formatSidebarAccess(me) {
    const level = (me.access_level || "").toString().trim();
    if (!level) return "";
    const text = `${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()} access`;
    return (me.role || "") === "Admin" ? `Admin \u00B7 ${text}` : text;
}

// Who may open User Management. Mirrors the /api/me shape:
//   access_level GLOBAL + department ADMINISTRATION + role Admin + is_admin true
// Display-only -- /user_management and /api/users enforce it server-side.
function isUserManager(me) {
    if (!me) return false;
    return me.is_admin === true
        && (me.role || "") === "Admin"
        && (me.access_level || "").toString().trim().toUpperCase() === "GLOBAL"
        && (me.department || "").toString().trim().toUpperCase() === "ADMINISTRATION";
}

async function updateSidebarUserInfo() {
    const profile = document.getElementById("sidebarUserProfile");
    const avatarEl = document.getElementById("sidebarUserAvatar");
    const nameEl = document.getElementById("sidebarUserName");
    const deptEl = document.getElementById("sidebarUserDept");
    const accessEl = document.getElementById("sidebarUserAccess");
    if (!nameEl || !deptEl) return;

    const result = await getMe();
    profile?.classList.remove("is-loading");

    if (result.state === "expired") {
        markSessionExpired();
        return;
    }

    if (result.state === "error") {
        // Never leave the card on "Loading…" -- that reads as broken.
        nameEl.textContent = "Couldn't load profile";
        deptEl.textContent = "Refresh to retry";
        if (avatarEl) avatarEl.textContent = "!";
        return;
    }

    const me = result.me;

    // The User Management link ships hidden; reveal it only for managers.
    const userMgmtLink = document.getElementById("menu-user-management");
    if (userMgmtLink) userMgmtLink.hidden = !isUserManager(me);

    nameEl.textContent = me.full_name || me.username || "Unknown User";
    deptEl.textContent = formatSidebarDepartment(me);

    if (accessEl) {
        const access = formatSidebarAccess(me);
        accessEl.textContent = access;
        accessEl.hidden = !access;
    }

    if (avatarEl) {
        const initials = (me.full_name
            ? me.full_name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join("")
            : (me.username || "?").slice(0, 2)
        ).toUpperCase();
        avatarEl.textContent = initials || "?";
    }
}

// ============================================================
// PENDING APPROVALS BADGE (Attendance Logs)
// ============================================================
// The sidebar is on every page, but approval lists only live in
// attendance_logs.js. This mirrors its department-visibility rule just
// enough to count what the current person can act on. Display-only --
// real enforcement stays server-side.
const CLAIMED_DEPTS_SIDEBAR = new Set(["QUALITY", "TECHNICAL", "ADMINISTRATION"]);

function sidebarCanViewDepartment(userDept, empDepartment) {
    const empDept = (empDepartment || "").toString().trim().toUpperCase();
    const dept = (userDept || "").toString().trim().toUpperCase();
    if (!dept) return false;
    if (dept === "ADMINISTRATION") return true;
    if (dept === "QUALITY") return empDept === "QUALITY";
    if (dept === "TECHNICAL") return empDept === "TECHNICAL";
    if (dept === "PRODUCTION") return !CLAIMED_DEPTS_SIDEBAR.has(empDept);
    return false;
}

// state: "none" | "count" | "error"
//  - count: red number (also on the section header while it's collapsed)
//  - error: grey "!" so a failed check is never mistaken for "nothing pending"
function setApprovalBadge(state, count = 0) {
    const dot = document.getElementById("attendanceNotifDot");
    if (!dot) return;
    const link = dot.closest(".menu-item");
    const sectionBadge = dot.closest(".menu-section")?.querySelector(".section-badge");

    dot.classList.remove("has-count", "is-error");
    sectionBadge?.classList.remove("is-error");

    if (state === "count") {
        const label = `${count} pending approval${count === 1 ? "" : "s"}`;
        const text = count > 99 ? "99+" : String(count);
        dot.textContent = text;
        dot.title = label;
        dot.setAttribute("aria-label", label);
        dot.classList.add("has-count");
        dot.style.display = "flex";
        if (link) link.dataset.extra = `${label} waiting for your review`;
        if (sectionBadge) {
            sectionBadge.textContent = text;
            sectionBadge.title = label;
            sectionBadge.hidden = false;
        }
    } else if (state === "error") {
        const label = "Couldn't check pending approvals. Will retry shortly.";
        dot.textContent = "!";
        dot.title = label;
        dot.setAttribute("aria-label", label);
        dot.classList.add("has-count", "is-error");
        dot.style.display = "flex";
        if (link) link.dataset.extra = label;
        if (sectionBadge) {
            sectionBadge.textContent = "!";
            sectionBadge.title = label;
            sectionBadge.classList.add("is-error");
            sectionBadge.hidden = false;
        }
    } else {
        dot.textContent = "";
        dot.removeAttribute("title");
        dot.removeAttribute("aria-label");
        dot.style.display = "none";
        if (link) delete link.dataset.extra;
        if (sectionBadge) {
            sectionBadge.textContent = "";
            sectionBadge.removeAttribute("title");
            sectionBadge.hidden = true;
        }
    }
}

async function fetchApprovalList(status) {
    try {
        const res = await fetch(
            `/api/attendance/time-in-request?status=${encodeURIComponent(status)}`,
            { credentials: "same-origin" }
        );
        if (res.status === 401) return { state: "expired", list: [] };
        if (res.status === 403) return { state: "ok", list: [] }; // not an approver for this list
        if (!res.ok) return { state: "error", list: [] };
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.request || data.data || []);
        return { state: "ok", list };
    } catch (err) {
        return { state: "error", list: [] };
    }
}

async function updateAttendanceNotifDot() {
    const dot = document.getElementById("attendanceNotifDot");
    if (!dot || sessionExpired) return; // markup missing, or already signed out

    try {
        const meResult = await getMe();
        if (meResult.state === "expired") { markSessionExpired(); return; }
        if (meResult.state === "error") { setApprovalBadge("error"); return; }

        const me = meResult.me;
        const userDept = me.department || "";
        const isHrApprover = !!me.is_hr_approver;

        // HR approvers only count Pending HR Approval; first approval
        // is no longer theirs to see or act on.
        const [first, hr] = await Promise.all([
            isHrApprover
                ? Promise.resolve({ state: "ok", list: [] })
                : fetchApprovalList("Pending First Approval"),
            isHrApprover
                ? fetchApprovalList("Pending HR Approval")
                : Promise.resolve({ state: "ok", list: [] })
        ]);

        if (first.state === "expired" || hr.state === "expired") { markSessionExpired(); return; }
        if (first.state === "error" || hr.state === "error") { setApprovalBadge("error"); return; }

        const visibleCount =
            first.list.filter(r => sidebarCanViewDepartment(userDept, r.department)).length +
            hr.list.filter(r => sidebarCanViewDepartment(userDept, r.department)).length;

        setApprovalBadge(visibleCount > 0 ? "count" : "none", visibleCount);
    } catch (err) {
        console.error(err);
        setApprovalBadge("error");
    }
}

function startNotifPolling() {
    stopNotifPolling();
    notifTimer = setInterval(() => {
        if (!document.hidden) updateAttendanceNotifDot(); // skip background tabs
    }, ATTENDANCE_NOTIF_POLL_MS);
}

function stopNotifPolling() {
    if (notifTimer) {
        clearInterval(notifTimer);
        notifTimer = null;
    }
}

// Coming back to the tab: refresh right away instead of waiting up to 30s.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !sessionExpired) updateAttendanceNotifDot();
});