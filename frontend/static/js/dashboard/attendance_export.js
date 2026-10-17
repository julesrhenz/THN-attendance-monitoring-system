/* ── Export today's attendance to Excel ───────────────────────
   Columns: ID | Name | Line | Process | Time In | Remarks
   Date is shown at the top of the sheet and in the file name.
   Uses GET /api/attendance-export?date=YYYY-MM-DD -> { success, data:[{id,name,line,process,time_in,remarks}] }
─────────────────────────────────────────────────────────────── */
const ATTENDANCE_ENDPOINT = "/api/attendance-export";   // added in attendance.py

async function exportAttendance(){
    // Today's date in Philippine time
    const now      = new Date();
    const isoDate  = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Manila" }).format(now);  // 2026-10-06
    const longDate = new Intl.DateTimeFormat("en-US", {
        timeZone:"Asia/Manila", year:"numeric", month:"long", day:"numeric", weekday:"long"
    }).format(now);

    try{
        const res = await fetch(`${ATTENDANCE_ENDPOINT}?date=${isoDate}`, { credentials:"same-origin" });
        if(!res.ok) throw new Error("Server returned " + res.status);

        const json = await res.json();
        if(json.success === false) throw new Error(json.message || "Attendance fetch failed");
        const rows = Array.isArray(json) ? json : (json.records || json.data || []);

        if(!rows.length){
            return Swal.fire("No attendance", "Walang attendance record para ngayong araw.", "info");
        }

        const pick = (o, ...keys) => {
            for(const k of keys){ if(o[k] !== undefined && o[k] !== null) return o[k]; }
            return "";
        };

        // Empty line/process -> "Unassigned"
        const orUnassigned = (v) => (String(v ?? "").trim() || "Unassigned");

        const header = ["ID", "Name", "Line", "Process", "Time In", "Remarks"];
        const body   = rows.map(r => [
            pick(r, "id", "emp_id", "employee_id"),
            pick(r, "name", "full_name", "employee_name"),
            orUnassigned(pick(r, "line", "line_name", "group_name")),
            orUnassigned(pick(r, "process", "section")),
            pick(r, "time_in", "timeIn", "time"),
            pick(r, "remarks", "remark")
        ]);

        const aoa = [
            ["Attendance Report"],
            ["Date: " + longDate],
            [],
            header,
            ...body
        ];

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"]   = [{wch:14}, {wch:32}, {wch:20}, {wch:24}, {wch:12}, {wch:30}];
        ws["!merges"] = [
            { s:{r:0,c:0}, e:{r:0,c:5} },
            { s:{r:1,c:0}, e:{r:1,c:5} }
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Attendance");
        XLSX.writeFile(wb, `Attendance_${isoDate}.xlsx`);

    }catch(err){
        console.error(err);
        Swal.fire("Export failed", "Hindi na-export ang attendance: " + err.message, "error");
    }
}