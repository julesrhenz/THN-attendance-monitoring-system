// ============================================================
// TIME HUB ASSISTANT — simple keyword-matching FAQ chatbot
// ============================================================
// No backend/API calls. Matches the user's message against a
// small knowledge base by counting keyword hits and returns the
// canned answer with the highest score. Good enough for "how do
// I..." style help questions; anything unrecognized gets a
// fallback pointing them to an Admin/Supervisor.

const CHATBOT_KB = [
    // ── Excel Import ──────────────────────────────────────────
    {
        keywords: ["import", "excel", "upload", "xlsx", "spreadsheet", "file"],
        answer: "To import an Excel file: go to the Grouping dashboard and click \"📥 Import Excel\". Only Admin and Supervisor accounts can do this. You'll be asked whether the import should apply immediately or on a scheduled date/time before it processes."
    },
    {
        keywords: ["import", "fail", "error", "wrong", "sheet", "skipped"],
        answer: "If an import fails or skips a sheet, it's usually because the sheet name doesn't contain \"DS\" or \"NS\" (Day Shift / Night Shift), or the header row is missing an \"Emp No.\" column. Check the sheet name and header row, then try again."
    },
    {
        keywords: ["schedule", "scheduled", "effective", "later", "future date"],
        answer: "When importing, you can choose \"Schedule for a specific date & time\" instead of applying it immediately. Scheduled imports go live automatically once that time passes — you don't need to do anything else."
    },
    {
        keywords: ["movement", "movements", "detect change", "line change", "shift change history"],
        answer: "Every import compares the new data against the previous import batch and logs any Line, Shift, or Process changes as a \"movement\" — you can review these under an employee's movement/history record."
    },

    // ── Roles / Access Levels ────────────────────────────────
    {
        keywords: ["role", "admin", "supervisor", "viewer", "permission", "who can"],
        answer: "There are 3 roles: Admin (full access everywhere), Supervisor (can edit within their assigned scope), and Viewer (read-only within their scope). Admin always sees everything regardless of Department/Access Level."
    },
    {
        keywords: ["viewer", "view only", "read only", "can't edit", "cant edit", "no edit button"],
        answer: "Viewer accounts are read-only everywhere: no Edit buttons on Attendance Logs, no Approve/Decline on approval queues, and the Import/Manage Manpower buttons are disabled. Viewers can still open an employee's history and details."
    },
    {
        keywords: ["access level", "line level", "section level", "department level", "global", "tier", "scope"],
        answer: "There are 4 access levels: Level 1 (Line) — one line/shift only, Level 2 (Section) — one Production sub-section, Level 3 (Department) — the whole department, Level 4 (Global) — unrestricted, reserved for Admins and Administration/HR accounts."
    },
    {
        keywords: ["department", "production", "quality", "technical", "administration", "assembly", "warehouse", "wh", "cc"],
        answer: "Departments are Production, Quality, Technical, and Administration. Production has three named sub-sections: Assembly, WH, and CC — a Section-level account only sees employees in their assigned sub-section."
    },
    {
        keywords: ["register", "create account", "sign up", "new user"],
        answer: "Click \"Create Account\" on the login screen. You'll need to pick a Role, Department, and Access Level — the Line/Section fields only appear when relevant to what you selected."
    },
    {
        keywords: ["list users", "user list", "all users", "who has access"],
        answer: "There's a users list showing every account's username, first/last name, and role — useful for checking who currently has access before adding a new account."
    },

    // ── Manage Manpower / Transfer / Grouping ────────────────
    {
        keywords: ["transfer", "move employee", "manage manpower", "reassign", "change line"],
        answer: "Use the \"🔄 Manage Manpower\" button on the Grouping dashboard to transfer employees between lines or sections. Select the employees, pick a destination sheet/line and section (or type a new section name), then confirm. Admin and Supervisor only."
    },
    {
        keywords: ["assign", "unassigned", "add employee to line"],
        answer: "Employees with no line yet appear in the Unassigned card. Open a line's card, click the assign button, and select from the list — or add someone who isn't in the system yet as an \"Absent Employee\"."
    },
    {
        keywords: ["production line", "assign line", "line dropdown"],
        answer: "A Production Line can be set per employee in Employee Management's Edit form — it's a dropdown populated with lines already in use, or you can pick a new one. This field only shows for non-Administration departments."
    },

    // ── Employee Management ───────────────────────────────────
    {
        keywords: ["remove employee", "delete employee", "bulk delete", "inactive"],
        answer: "In Employee Management, select one or more employees and click \"Bulk Delete\" — this sets them to INACTIVE rather than erasing their record, so history is preserved. Admin only."
    },
    {
        keywords: ["add new employee", "add employee", "create employee", "new hire"],
        answer: "Click \"Add New Employee\" in Employee Management. Fill in name, agency, employee number, department, position, date hired, and shift — Tenure is calculated automatically from the hire date, you don't type it in."
    },
    {
        keywords: ["edit employee", "update employee", "change employee info"],
        answer: "Click \"Edit\" on any employee row in Employee Management to update their name, department, position, line, shift, or hire date. Every edit is logged with the old and new values for audit purposes."
    },
    {
        keywords: ["employee details", "view employee", "employee profile", "employee info"],
        answer: "Click anywhere on an employee's row in Employee Management (not on a button) to open their full details — includes agency, line, process, tenure, status, remarks, and when the record was last updated."
    },
    {
        keywords: ["agency", "thn", "cci", "natcorp", "emis"],
        answer: "Employees belong to one of four agencies: THN, CCI, NATCORP, or EMIS — this is reflected as a prefix in their Employee ID (e.g. \"C-\" for CCI, \"N-\" for NATCORP, \"E-\" for EMIS; THN has no prefix). You can filter the employee table by agency."
    },
    {
        keywords: ["on leave", "leave", "bulk leave", "mark leave", "return from leave", "back to work"],
        answer: "You can mark one or more employees On Leave in bulk — select them and provide a reason (and optionally a return date). They'll show as \"On Leave\" everywhere in the dashboard until someone clicks \"Return to Work\", which clears the leave status."
    },

    // ── Attendance Logs & Approvals ──────────────────────────
    {
        keywords: ["attendance", "clock in", "clock out", "time in", "time out", "punch"],
        answer: "The Attendance Logs page shows every employee's time-in/time-out records, calculated status (Present, Late, Absent, etc.), and lets you request a correction when needed. Click a row (or the ✎ Edit button) to submit a change — Viewers can't do this."
    },
    {
        keywords: ["late", "cutoff", "shift time", "shift start", "what time"],
        answer: "Day Shift starts at 7:00 AM — clocking in at 7:01 AM or later counts as Late, and the shift runs until 4:00 PM (OT window until 9:00 PM). Night Shift starts at 7:00 PM — Late after 7:01 PM, runs until 4:00 AM (OT window until 9:00 AM)."
    },
    {
        keywords: ["missing punch", "missing punches", "incomplete punch", "no time out", "no time in"],
        answer: "The \"⚠ Missing Punches\" report on Attendance Logs lists everyone with only one side of their punch recorded (clocked in but never out, or vice versa) for the selected shift/date — useful for spotting who needs a correction."
    },
    {
        keywords: ["approve", "approval", "pending", "hr approval", "first approval", "two stage", "stages"],
        answer: "Time-in requests go through two stages: First Approval (department/line/section level, based on the requester's scope) and HR/Final Approval. The live attendance record is only actually updated at the final HR approval — first approval just advances the request. Only Admins or Administration-department accounts can act on the HR stage."
    },
    {
        keywords: ["decline", "reject", "deny request"],
        answer: "A Time-In request can be declined at either stage. Who's allowed to decline depends on the request's current stage — the same people who could approve that stage can also decline it."
    },
    {
        keywords: ["notification", "toast", "pop up popup", "new request alert"],
        answer: "When a new Time-In request comes in for your department, a small toast notification pops up in the corner of the Attendance Logs page — click it to jump straight into the relevant approval queue. It refreshes automatically every few seconds."
    },
    {
        keywords: ["status", "present", "absent", "pending status"],
        answer: "Attendance status (Present, Late, Absent, On Leave, Pending) is calculated automatically from each employee's shift cutoff time — you don't need to tag it manually unless you're doing a manual override."
    },
    {
        keywords: ["validation", "benchmark", "checksum", "discrepancy", "expected count"],
        answer: "The dashboard runs a daily validation check comparing the actual THN Day Shift present+late+absent count against an expected benchmark headcount, flagging a discrepancy if they don't match — useful for catching missing or duplicate records."
    },
    {
        keywords: ["audit", "history", "who changed", "record history", "employee history"],
        answer: "Every manual attendance edit — and every employee record add/update/delete — is logged in an audit trail with the old value, new value, who made the change, and when. Click an employee's name on Attendance Logs to see their full attendance history and stats (Present/Late/Absent/On Leave counts)."
    },
    {
        keywords: ["dashboard summary", "analytics", "attendance rate", "chart", "agency stats", "tenure"],
        answer: "The Dashboard page shows attendance rate summaries and breakdowns by agency, tenure, department, or line — both a weekly and monthly view — so you can spot trends beyond just today's numbers."
    },
    {
        keywords: ["filter", "search employee", "search attendance", "position filter", "date filter"],
        answer: "On Attendance Logs, you can filter by Shift, Date, Status, and Position, plus a free-text search by Employee ID or name — combine them for a narrower view, and click any column header to sort."
    },

    // ── General / fallback ────────────────────────────────────
    {
        keywords: ["logout", "sign out", "log out"],
        answer: "Click \"Logout\" at the bottom of the sidebar, then confirm. This ends your session immediately."
    },
    {
        keywords: ["password", "forgot password", "reset password"],
        answer: "There's no self-service password reset yet — please ask an Admin to help you regain access to your account."
    },
];

const CHATBOT_FALLBACK = "I don't have an answer for that yet — try asking about Excel imports, roles/access levels, transferring employees, or attendance approvals. For anything else, please reach out to an Admin or Supervisor.";

const CHATBOT_QUICK_QUESTIONS = [
    "How do I import Excel?",
    "What are access levels?",
    "How do I transfer an employee?",
    "How does HR approval work?",
];

const CHATBOT_GREETING = "Hi! I'm the Time Hub Assistant. Ask me how to use the system, or tap a suggestion below.";

function chatbotFindAnswer(message) {
    const text = message.toLowerCase();
    let bestScore = 0;
    let bestAnswer = null;

    for (const entry of CHATBOT_KB) {
        let score = 0;
        for (const kw of entry.keywords) {
            if (text.includes(kw)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestAnswer = entry.answer;
        }
    }

    return bestAnswer || CHATBOT_FALLBACK;
}

document.addEventListener("DOMContentLoaded", () => {
    const fab = document.getElementById("chatbotFab");
    const panel = document.getElementById("chatbotPanel");
    const closeBtn = document.getElementById("chatbotClose");
    const messagesEl = document.getElementById("chatbotMessages");
    const quickEl = document.getElementById("chatbotQuick");
    const input = document.getElementById("chatbotInput");
    const sendBtn = document.getElementById("chatbotSend");

    if (!fab || !panel) return; // sidebar markup not updated on this page yet

    let greeted = false;

    function addMessage(text, sender) {
        const msg = document.createElement("div");
        msg.className = `chatbot-msg ${sender}`;
        msg.textContent = text;
        messagesEl.appendChild(msg);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderQuickQuestions() {
        quickEl.innerHTML = "";
        CHATBOT_QUICK_QUESTIONS.forEach(q => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chatbot-chip";
            chip.textContent = q;
            chip.addEventListener("click", () => handleUserMessage(q));
            quickEl.appendChild(chip);
        });
    }

    function handleUserMessage(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        addMessage(trimmed, "user");
        input.value = "";

        // Small delay so it reads like a real response rather than an instant echo.
        setTimeout(() => {
            addMessage(chatbotFindAnswer(trimmed), "bot");
        }, 300);
    }

    function openPanel() {
        panel.classList.add("open");
        if (!greeted) {
            addMessage(CHATBOT_GREETING, "bot");
            renderQuickQuestions();
            greeted = true;
        }
        input.focus();
    }

    function closePanel() {
        panel.classList.remove("open");
    }

    fab.addEventListener("click", () => {
        if (panel.classList.contains("open")) {
            closePanel();
        } else {
            openPanel();
        }
    });

    closeBtn?.addEventListener("click", closePanel);

    sendBtn?.addEventListener("click", () => handleUserMessage(input.value));

    input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleUserMessage(input.value);
        }
    });
});