"""
Shared helpers for the agency-prefixed emp_id format used throughout the
attendance system (employee_groupings, biometric_logs, attendance_logs,
and every API endpoint that builds or reads an emp_id).

Canonical format -- NO dash:
    THN     -> "1234"      (THN has no prefix)
    CCI     -> "C1234"
    EMIS    -> "E1234"
    NATCORP -> "N1234"

Previously several places (groupings.py's import, data.py's dashboard
lookups, employees.py's manual-add endpoint) each had their own copy of
this mapping, and some of them still used a dash ("C-1234"), or in
employees.py's case didn't normalize at all. That drift is what let
dashed emp_ids get stored. Import from this module everywhere instead of
re-declaring the maps locally, so there's exactly one place to update.
"""

# Agency code -> emp_id prefix. THN has no prefix.
AGENCY_PREFIX = {
    "THN":     "",
    "CCI":     "C",
    "EMIS":    "E",
    "NATCORP": "N",
}

# Agency code -> `emp` integer FK (frontend.employee_groupings.emp,
# scanners.emp, etc).
AGENCY_ID = {
    "THN":     1,
    "CCI":     2,
    "NATCORP": 3,
    "EMIS":    4,
}

# emp_id prefix character -> agency code, for going the other direction
# (e.g. figuring out which agency an existing emp_id belongs to).
PREFIX_TO_AGENCY = {"C": "CCI", "N": "NATCORP", "E": "EMIS"}


def build_emp_id(agency_code, raw_number: str) -> str:
    """
    Builds the canonical emp_id from an agency code and a raw employee
    number, e.g.:
        build_emp_id("CCI", "1234")  -> "C1234"
        build_emp_id("THN", "1234")  -> "1234"
        build_emp_id(2,     "1234")  -> "C1234"   (agency int FK also accepted)

    Unrecognized agency codes fall back to prefixing the code itself
    (no dash) rather than silently dropping the value.
    """
    if isinstance(agency_code, int):
        code = next((k for k, v in AGENCY_ID.items() if v == agency_code), "")
    else:
        code = (agency_code or "").strip().upper()

    number = (raw_number or "").strip()
    prefix = AGENCY_PREFIX.get(code, code)
    return f"{prefix}{number}".upper()


def normalize_emp_id(raw_emp_id) -> str:
    """
    Cleans up a possibly-dashed emp_id into the canonical no-dash form.
        "THN-1234" -> "1234"
        "CCI-1234" -> "C1234"
        "1234"     -> "1234"     (already clean, left as-is)
        "C1234"    -> "C1234"    (already clean, left as-is)

    Use this on any emp_id/emp_no coming from user input (manual add
    forms, pasted spreadsheet values, API payloads) before it's stored,
    so old dashed values entered by habit don't slip back in.
    """
    if raw_emp_id is None:
        return raw_emp_id

    s = str(raw_emp_id).strip().upper()
    if "-" not in s:
        return s

    company, _, number = s.partition("-")
    prefix = AGENCY_PREFIX.get(company.strip())
    if prefix is None:
        # Unrecognized code before the dash -- strip the dash rather than
        # silently dropping/mangling the value further.
        return s.replace("-", "")

    return f"{prefix}{number.strip()}"


def agency_code_from_emp_id(emp_id) -> str:
    """
    Inverse of build_emp_id: given a stored/normalized emp_id, returns
    which agency it belongs to ("THN", "CCI", "NATCORP", "EMIS").

    THN has no prefix, so anything not starting with a recognized letter
    prefix is assumed THN -- this matches the prior "no dash -> THN"
    fallback behavior for bare-numeric ids.
    """
    s = str(emp_id or "").strip().upper()
    if not s:
        return ""
    return PREFIX_TO_AGENCY.get(s[0], "THN")