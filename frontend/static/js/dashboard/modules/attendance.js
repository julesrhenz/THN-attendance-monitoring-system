// ─────────────────────────────────────────
// ATTENDANCE TIME / STATUS LOGIC
// ─────────────────────────────────────────
// Pure time-math helpers plus the one fetch that depends on them for
// debug logging. Kept separate from api.js because this is domain logic
// (shift rules), not a generic HTTP wrapper.

import { fetchAttendanceStatusRequest } from "./api.js";

export function toSeconds(h, m, s) {
    return h * 3600 + m * 60 + s;
}

export function parseTimeToSeconds(timeStr) {
    if (!timeStr) return null;
    const [h, m, s] = timeStr.split(":").map(Number);
    return toSeconds(h, m, s || 0);
}

export function determineStatus(shiftName, timeIn, nowSecs) {
    const isNight = (shiftName || "").toLowerCase().includes("night");
    const timeInSecs = parseTimeToSeconds(timeIn);

    if (isNight) {
        const nightStart = toSeconds(19, 0, 0);
        const nightLate = toSeconds(19, 1, 0);
        const nightOtEnd = toSeconds(9, 0, 0); // next day, so treat as < nightStart

        if (timeInSecs !== null) {
            return timeInSecs >= nightLate ? "Late" : "Present";
        }
        // No time_in
        // If current time is before night shift start and after OT end → shift hasn't started
        if (nowSecs < nightStart && nowSecs > nightOtEnd) return "Pending";
        if (nowSecs >= nightStart || nowSecs <= nightOtEnd) return "Pending";
        return "Absent";

    } else {
        const dayStart = toSeconds(7, 0, 0);
        const dayLate = toSeconds(7, 1, 0);
        const dayOtEnd = toSeconds(21, 0, 0);

        if (timeInSecs !== null) {
            return timeInSecs >= dayLate ? "Late" : "Present";
        }
        // No time_in
        if (nowSecs >= dayStart) return "Absent";
        return "Pending";
    }
}

export async function fetchAttendanceStatus() {
    try {
        const data = await fetchAttendanceStatusRequest();
        if (!data.success) {
            console.error("Attendance fetch failed:", data.message);
            return null;
        }

        console.table(data.records); // quick debug view
        console.log("Summary:", data.summary);
        return data;

    } catch (err) {
        console.error("fetchAttendanceStatus error:", err);
        return null;
    }
}

export function updatePHTime() {
    document.getElementById("phTime").innerText = new Date().toLocaleTimeString();
}