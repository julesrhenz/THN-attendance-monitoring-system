(() => {
    const STORAGE_KEY = "thn_theme";
    const DARK = "dark";

    function getTheme() {
        try { return localStorage.getItem(STORAGE_KEY) === DARK ? DARK : "light"; }
        catch (_) { return "light"; }
    }

    function applyTheme(theme, persist = true) {
        const isDark = theme === DARK;
        // The CSS selectors require data-theme="dark". toggleAttribute()
        // creates an empty attribute, which only worked after a reload when
        // the startup script wrote the value explicitly.
        if (isDark) document.documentElement.setAttribute("data-theme", DARK);
        else document.documentElement.removeAttribute("data-theme");
        document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
            button.textContent = isDark ? "☀️" : "🌙";
            button.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
            button.title = isDark ? "Switch to light mode" : "Switch to dark mode";
        });
        if (persist) {
            try { localStorage.setItem(STORAGE_KEY, isDark ? DARK : "light"); }
            catch (_) {}
        }
        try {
            if (window.Chart) {
                Chart.defaults.color = isDark ? "#c5cde0" : "#666";
                Chart.defaults.borderColor = isDark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.1)";
                Object.values(Chart.instances || {}).forEach((chart) => chart.update());
            }
        } catch (_) {}
        window.dispatchEvent(new CustomEvent("thn-theme-change", { detail: { theme: isDark ? DARK : "light" } }));
    }

    window.THNTheme = { apply: applyTheme, get: getTheme };

    function initialize() {
        applyTheme(getTheme(), false);
        const bindButtons = () => document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
            if (button.dataset.themeBound) return;
            button.dataset.themeBound = "true";
            button.addEventListener("click", (event) => {
                event.preventDefault();
                applyTheme(document.documentElement.hasAttribute("data-theme") ? "light" : DARK);
            });
        });
        bindButtons();
        // Covers sidebar markup inserted after this script by a partial render.
        new MutationObserver(bindButtons).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener("storage", (event) => {
            if (event.key === STORAGE_KEY) applyTheme(getTheme(), false);
        });
    }

    // A deferred script normally runs before DOMContentLoaded, but this also
    // handles cached/dynamically loaded scripts without waiting for a refresh.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
