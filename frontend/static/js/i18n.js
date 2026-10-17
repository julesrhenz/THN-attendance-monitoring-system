/* Global UI localization for the Attendance System.
 * Add an English phrase to the catalog below and it will be translated anywhere
 * it appears in the UI, including content rendered later by JavaScript.
 */
(function () {
    "use strict";

    const STORAGE_KEY = "thn-language";
    const supported = { en: "English", ko: "한국어", tl: "Tagalog" };
    const catalog = {
        "Dashboard": ["대시보드", "Dashboard"],
        "Overview": ["개요", "Pangkalahatang-ideya"],
        "System Setup": ["시스템 설정", "Pag-setup ng System"],
        "Workforce": ["인력", "Mga Empleyado"],
        "Time Tracking": ["근태 관리", "Pagsubaybay ng Oras"],
        "Grouping": ["그룹 관리", "Pagpapangkat"],
        "Employee Management": ["직원 관리", "Pamamahala ng Empleyado"],
        "Attendance Logs": ["근태 기록", "Tala ng Attendance"],
        "Scanner Management": ["스캐너 관리", "Pamamahala ng Scanner"],
        "Logout": ["로그아웃", "Mag-log out"],
        "Language": ["언어", "Wika"],
        "English": ["영어", "English"],
        "Korean": ["한국어", "Korean"],
        "Tagalog": ["타갈로그어", "Tagalog"],
        "Attendance Dashboard": ["근태 대시보드", "Dashboard ng Attendance"],
        "Attendance Overview": ["근태 현황", "Pangkalahatang Attendance"],
        "Employee Directory": ["직원 명부", "Direktoryo ng Empleyado"],
        "Search": ["검색", "Maghanap"],
        "Search employees...": ["직원 검색...", "Maghanap ng empleyado..."],
        "Search by name or ID...": ["이름 또는 ID로 검색...", "Maghanap gamit ang pangalan o ID..."],
        "Filter": ["필터", "I-filter"],
        "All": ["전체", "Lahat"],
        "All Departments": ["모든 부서", "Lahat ng Departamento"],
        "All Affiliates": ["모든 계열사", "Lahat ng Affiliate"],
        "Affiliates": ["계열사", "Mga Affiliate"],
        "All Shifts": ["모든 근무조", "Lahat ng Shift"],
        "Day Shift": ["주간 근무", "Day Shift"],
        "Night Shift": ["야간 근무", "Night Shift"],
        "Present": ["출근", "Pumasok"],
        "Absent": ["결근", "Wala"],
        "Late": ["지각", "Late"],
        "On Leave": ["휴가 중", "Naka-leave"],
        "No Work": ["휴무", "Walang Pasok"],
        "Total Employees": ["총 직원", "Kabuuang Empleyado"],
        "Employee": ["직원", "Empleyado"],
        "Employees": ["직원", "Mga Empleyado"],
        "Name": ["이름", "Pangalan"],
        "ID": ["ID", "ID"],
        "Department": ["부서", "Departamento"],
        "Line": ["라인", "Linyo"],
        "Shift": ["근무조", "Shift"],
        "Remarks": ["비고", "Puna"],
        "Time In": ["출근 시간", "Oras ng Pasok"],
        "Time Out": ["퇴근 시간", "Oras ng Uwi"],
        "Date": ["날짜", "Petsa"],
        "Status": ["상태", "Katayuan"],
        "Actions": ["작업", "Mga Aksyon"],
        "Save": ["저장", "I-save"],
        "Cancel": ["취소", "Kanselahin"],
        "Close": ["닫기", "Isara"],
        "Delete": ["삭제", "Burahin"],
        "Edit": ["수정", "I-edit"],
        "Add Employee": ["직원 추가", "Magdagdag ng Empleyado"],
        "Add": ["추가", "Idagdag"],
        "Upload": ["업로드", "I-upload"],
        "Import": ["가져오기", "I-import"],
        "Export": ["내보내기", "I-export"],
        "Download": ["다운로드", "I-download"],
        "Refresh": ["새로고침", "I-refresh"],
        "Clear": ["지우기", "I-clear"],
        "Confirm": ["확인", "Kumpirmahin"],
        "Yes": ["예", "Oo"],
        "No": ["아니요", "Hindi"],
        "Loading...": ["불러오는 중...", "Naglo-load..."],
        "No data available": ["사용 가능한 데이터가 없습니다", "Walang available na data"],
        "No records found": ["기록을 찾을 수 없습니다", "Walang nakitang rekord"],
        "No employees found": ["직원을 찾을 수 없습니다", "Walang nakitang empleyado"],
        "No absences found": ["결근 기록이 없습니다", "Walang nakitang absent"],
        "No present records found": ["출근 기록이 없습니다", "Walang nakitang present"],
        "Absent Employees": ["결근 직원", "Mga Empleyadong Wala"],
        "Present Employees": ["출근 직원", "Mga Empleyadong Pumasok"],
        "Reason (optional)": ["사유 (선택 사항)", "Dahilan (opsyonal)"],
        "Please select": ["선택하세요", "Pumili"],
        "Please fill in all fields.": ["모든 항목을 입력하세요.", "Punan ang lahat ng field."],
        "Network error. Please try again.": ["네트워크 오류입니다. 다시 시도하세요.", "May error sa network. Subukan muli."],
        "Are you sure you want to logout?": ["로그아웃하시겠습니까?", "Sigurado ka bang gusto mong mag-log out?"],
        "Login": ["로그인", "Mag-login"],
        "Register": ["가입", "Mag-register"],
        "Username": ["사용자 이름", "Username"],
        "Password": ["비밀번호", "Password"],
        "Confirm Password": ["비밀번호 확인", "Kumpirmahin ang Password"],
        "First Name": ["이름", "Unang Pangalan"],
        "Last Name": ["성", "Apelyido"],
        "Create Account": ["계정 만들기", "Gumawa ng Account"],
        "Welcome back": ["다시 오신 것을 환영합니다", "Maligayang pagbabalik"],
        "Day Shift Active": ["주간 근무 진행 중", "Aktibo ang Day Shift"],
        "Night Shift Active": ["야간 근무 진행 중", "Aktibo ang Night Shift"],
        "Toggle navigation": ["메뉴 전환", "I-toggle ang navigation"]
    };

    function language() {
        const saved = localStorage.getItem(STORAGE_KEY);
        return supported[saved] ? saved : "en";
    }

    function translate(value) {
        if (typeof value !== "string" || language() === "en") return value;
        const item = catalog[value.trim()];
        if (!item) return value;
        const padding = value.match(/^\s*/)[0] + value.match(/\s*$/)[0];
        return padding ? value.replace(value.trim(), item[language() === "ko" ? 0 : 1]) : item[language() === "ko" ? 0 : 1];
    }

    function translateElement(el) {
        if (!el || el.closest("[data-i18n-ignore]")) return;
        ["placeholder", "title", "aria-label", "data-tooltip"].forEach(attr => {
            if (!el.hasAttribute(attr)) return;
            const source = el.getAttribute(`data-i18n-source-${attr}`) || el.getAttribute(attr);
            el.setAttribute(`data-i18n-source-${attr}`, source);
            if (attr === "data-tooltip") {
                el.setAttribute(attr, source.split("||").map(translate).join("||"));
            } else el.setAttribute(attr, translate(source));
        });
        Array.from(el.childNodes).forEach(node => {
            if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) return;
            const source = node.__i18nSource || node.nodeValue;
            node.__i18nSource = source;
            node.nodeValue = translate(source);
        });
    }

    function apply(root) {
        if (!root) return;
        if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);
        (root.querySelectorAll ? root.querySelectorAll("*") : []).forEach(translateElement);
        document.documentElement.lang = language() === "ko" ? "ko" : language() === "tl" ? "tl" : "en";
    }

    function setLanguage(code) {
        if (!supported[code]) return;
        localStorage.setItem(STORAGE_KEY, code);
        apply(document.body);
        document.querySelectorAll("[data-language-select]").forEach(select => { select.value = code; });
        window.dispatchEvent(new CustomEvent("languagechange", { detail: { language: code } }));
    }

    window.i18n = { t: translate, getLanguage: language, setLanguage, supported, apply };
    document.addEventListener("DOMContentLoaded", () => {
        apply(document.body);
        document.querySelectorAll("[data-language-select]").forEach(select => {
            select.value = language();
        });
        const observer = new MutationObserver(records => records.forEach(record => {
            record.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) apply(node);
                else if (node.nodeType === Node.TEXT_NODE && node.parentElement) translateElement(node.parentElement);
            });
        }));
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();
