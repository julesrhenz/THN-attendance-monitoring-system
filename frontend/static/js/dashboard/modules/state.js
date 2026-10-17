// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
// Centralized mutable state. Other modules import `state` and mutate its
// properties directly (e.g. `state.data = ...`) rather than reassigning the
// whole export, since `export let data` cannot be reassigned from outside
// the module that declares it.

export const state = {
    data: {},
    selectedGroup: null,
    transferMode: false,
    selectedEmployees: [],
    localUpdate: false,
    filteredEmployees: [],
    currentPages: {},
    loading: false,
    editMode: false,
    draggedEmployeeId: null,
    departmentViewActive: false,   // ← toggles grouped-by-department grid

    // ── Current logged-in user (from /api/me) ──
    // Shape: { access_level, assigned_line, assigned_section, assigned_shift,
    //          department, first_name, full_name, is_admin, is_hr_approver,
    //          last_name, role, username }
    // Populated once on app init (see api.js:getCurrentUser). If access_level
    // is not "LINE", no scoping is applied (admin/full-access roles see everything).
    currentUser: null,

    // ── Summary modal ──
    summaryModalOpen: false,
    summaryModalLine: null,   // group.id of the line group currently shown
    summaryModalData: null,   // last computed summary payload
};

// `io()` is assumed to be loaded globally via <script src=".../socket.io.js">
export const socket = io();

export const SECTIONS = [
    "LINE LEADER", "ASST LEADER", "FEEDER", "SUB (WIRE INSERTION)", "LAYOUT", "TAPING",
    "BAND CABLE ATTACHMENT", "GROMMET ATTACHMENT", "PROTECTOR ATTACHMENT",
    "PACKING", "CIRCUIT INSPECTION", "CONSTRUCTION INSPECTION", "VISUAL INSPECTION"
];

export const SHIFT_RULES = {
    day: {
        lateAfter:   { h: 7,  m: 1, s: 0 },   // 07:01:00
        absentAfter: { h: 7,  m: 0, s: 0 },   // after 07:00 with no time_in = absent
        otEnd:       { h: 21, m: 0, s: 0 },   // 21:00:00
    },
    night: {
        lateAfter:  { h: 19, m: 1, s: 0 },   // 19:01:00
        shiftStart: { h: 19, m: 0, s: 0 },   // 19:00:00
        otEnd:      { h: 9,  m: 0, s: 0 },   // 09:00:00 next day
    }
};