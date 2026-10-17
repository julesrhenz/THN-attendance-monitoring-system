from .database import get_db_connection

def init_tables():

    conn = get_db_connection()
    cur = conn.cursor()

    # Create schema if it doesn't exist, then set search path
    cur.execute("CREATE SCHEMA IF NOT EXISTS backend")
    cur.execute("SET search_path TO backend, public")

    # ==========================================
    # Shifts
    # ==========================================
    cur.execute("""
    CREATE TABLE IF NOT EXISTS backend.shifts (
        shift_id SERIAL PRIMARY KEY,
        shift_name VARCHAR(50),
        start_time TIME,
        end_time TIME
    );
    """)

    # ==========================================
    # Agencies
    # ==========================================
    cur.execute("""
    CREATE TABLE IF NOT EXISTS backend.agencies (
        emp SERIAL PRIMARY KEY,
        emp_name VARCHAR(20) UNIQUE NOT NULL
    );
    """)

    # ==========================================
    # Scanners
    # ==========================================
    cur.execute("""
    CREATE TABLE IF NOT EXISTS backend.scanners (
        scanner_id SERIAL PRIMARY KEY,
        emp INTEGER NOT NULL
            REFERENCES agencies(emp)
            ON DELETE CASCADE,
        ip_address VARCHAR(50) UNIQUE NOT NULL,
        port INTEGER,
        location VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scanner_type VARCHAR(20) NOT NULL CHECK (scanner_type IN ('ZKTeco', 'Anviz')),
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE
    );
    """)

    # These ALTERs are intentionally separate from CREATE TABLE: production
    # installations already have scanners, and CREATE TABLE IF NOT EXISTS
    # never adds columns to an existing table.  Port is device-specific so
    # future agencies can use their actual configured endpoint rather than a
    # source-code mapping keyed only by agency.
    cur.execute("ALTER TABLE backend.scanners ADD COLUMN IF NOT EXISTS port INTEGER")
    cur.execute("ALTER TABLE backend.scanners ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE")
    cur.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'chk_scanners_port_range'
                  AND conrelid = 'backend.scanners'::regclass
            ) THEN
                ALTER TABLE backend.scanners
                ADD CONSTRAINT chk_scanners_port_range
                CHECK (port IS NULL OR port BETWEEN 1 AND 65535);
            END IF;
        END $$;
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_scanners_enabled
        ON backend.scanners (scanner_id)
        WHERE is_enabled = TRUE
    """)

    # ==========================================
    # Biometric Logs
    # ==========================================
    cur.execute("""
    CREATE TABLE IF NOT EXISTS backend.biometric_logs (
        id BIGSERIAL PRIMARY KEY,
        scanner_id INTEGER NOT NULL
            REFERENCES scanners(scanner_id),
        emp INTEGER,
        emp_id VARCHAR(30),
        emp_no VARCHAR(20),
        employee_status VARCHAR(20) DEFAULT 'ACTIVE',
        punch_time TIMESTAMP NOT NULL,
        punch_type INTEGER NOT NULL,
        processed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (scanner_id, emp_no, punch_time, punch_type)
    );
    """)

    # Match the recurring pipeline queries. These partial indexes keep the
    # pending/reconciliation scans bounded as biometric history grows.
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_biometric_logs_pending_emp_time
        ON backend.biometric_logs (emp_id, punch_time)
        WHERE processed = FALSE
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_biometric_logs_unknown_scanner_emp_no
        ON backend.biometric_logs (scanner_id, emp_no)
        WHERE employee_status = 'UNKNOWN/RESIGNED'
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_biometric_logs_scanner_latest_punch
        ON backend.biometric_logs (scanner_id, punch_time DESC)
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS backend.attendance_logs (
    id BIGSERIAL PRIMARY KEY,
    emp CHAR(1),
    emp_no VARCHAR(20) NOT NULL,
    full_name TEXT,
    emp_status VARCHAR(20),
    attendance_date DATE,
    shift_name VARCHAR(20),
    time_in TIMESTAMP,
    time_in_status VARCHAR(20),
    time_in_location VARCHAR(100),
    time_out TIMESTAMP,
    time_out_status VARCHAR(20),
    time_out_location VARCHAR(100),
    UNIQUE (emp, emp_no, attendance_date)
        );
    """)

    # ==========================================
    # Employee Record Audit
    # ==========================================
    cur.execute("""
    CREATE TABLE IF NOT EXISTS backend.employee_record_audit (
        audit_id BIGSERIAL PRIMARY KEY,
        emp_id VARCHAR(50),
        emp_no VARCHAR(50),
        action_type VARCHAR(20) NOT NULL
            CHECK (action_type IN ('INSERT', 'UPDATE', 'DELETE')),
        changed_by VARCHAR(100),
        old_data JSONB,
        new_data JSONB,
        changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cur.execute("""   
    CREATE TABLE IF NOT EXISTS frontend.import_batches (
    id              SERIAL PRIMARY KEY,
    filename        VARCHAR(255),
    imported_by     VARCHAR(100),
    imported_at     TIMESTAMP DEFAULT NOW(),
    total_lines     INTEGER DEFAULT 0,
    total_employees INTEGER DEFAULT 0,
    effective_at    TIMESTAMP DEFAULT NOW(),
    applied         BOOLEAN DEFAULT TRUE,
    raw_payload     JSONB 
    ); """)

    cur.execute("ALTER TABLE frontend.import_batches ADD COLUMN IF NOT EXISTS schedule_effective_at TIMESTAMP")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS frontend.employee_groupings (
    emp_id          VARCHAR(50) PRIMARY KEY,
    emp_no          VARCHAR(20),
    emp             INTEGER,
    last_name       VARCHAR(100),
    first_name      VARCHAR(100),
    full_name       VARCHAR(200),
    position        VARCHAR(100),
    department      VARCHAR(100),
    line_name       VARCHAR(100),
    shift           VARCHAR(50),
    process         TEXT,
    line            VARCHAR(50),
    employee_status VARCHAR(20) DEFAULT 'ACTIVE',
    date_hired      DATE,
    tenure          NUMERIC(10,2),
    remarks         TEXT,
    source          VARCHAR(30) DEFAULT 'SYSTEM',
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_employee_list_agency
        FOREIGN KEY (emp)
        REFERENCES backend.agencies(emp)
        ON DELETE CASCADE
    ); """)

    cur.execute("""
            CREATE TABLE IF NOT EXISTS frontend.employee_movements (
            id BIGSERIAL PRIMARY KEY,
            emp_id VARCHAR(50) NOT NULL,
            full_name VARCHAR(255),
            field_name VARCHAR(50) NOT NULL,
            old_value TEXT,
            new_value TEXT,
            from_batch_id INTEGER,
            to_batch_id INTEGER,
            detected_at TIMESTAMP DEFAULT NOW()
        );""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_movements_emp_id
        ON frontend.employee_movements(emp_id);""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_movements_to_batch
        ON frontend.employee_movements(to_batch_id);""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_movements_detected
        ON frontend.employee_movements(detected_at);""")

    # Dashboard and import activation query these predicates on every refresh.
    cur.execute("""CREATE INDEX IF NOT EXISTS idx_groupings_line_shift
        ON frontend.employee_groupings(line_name, shift);""")

    # ==========================================
    # No Work Schedule (HR-declared "no work needed" days)
    # ==========================================
    # A row can scope to one specific employee (emp_id set), or to a whole
    # line/shift (emp_id NULL, line_name and/or shift set) for plant/line-wide
    # shutdown days. Resolution of scoped rows into concrete emp_ids happens
    # in the application layer against employee_groupings.
    cur.execute("""
    CREATE TABLE IF NOT EXISTS frontend.no_work_schedule (
        id          SERIAL PRIMARY KEY,
        emp_id      VARCHAR(50),
        line_name   VARCHAR(100),
        shift       VARCHAR(50),
        work_date   DATE NOT NULL,
        reason      TEXT,
        created_by  VARCHAR(100),
        created_at  TIMESTAMP DEFAULT NOW(),
        CONSTRAINT chk_no_work_scope
            CHECK (emp_id IS NOT NULL OR line_name IS NOT NULL OR shift IS NOT NULL)
    );
    """)

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_no_work_date
        ON frontend.no_work_schedule(work_date);""")

    # Prevents the same employee being double-declared for the same day.
    # Partial (emp_id IS NOT NULL) since scoped (line/shift) rows can't be
    # deduplicated this way -- app layer checks those for overlap on insert.
    cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_no_work_emp_date_unique
        ON frontend.no_work_schedule(emp_id, work_date)
        WHERE emp_id IS NOT NULL;""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_no_work_line_shift_date
        ON frontend.no_work_schedule(work_date, line_name, shift)
        WHERE emp_id IS NULL;""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_import_batches_pending_effective
        ON frontend.import_batches(effective_at)
        WHERE applied = FALSE;""")

    cur.execute("""CREATE TABLE IF NOT EXISTS frontend.employee_snapshot_records (
        id          BIGSERIAL PRIMARY KEY,
        batch_id    INTEGER NOT NULL
                        REFERENCES frontend.import_batches(id)
                        ON DELETE CASCADE,
        emp_id      TEXT NOT NULL,
        emp         TEXT,
        full_name   TEXT,
        line        TEXT,
        shift       TEXT,
        process     TEXT,
        tenure      NUMERIC(10,2),
        date_hired  DATE,
        UNIQUE (batch_id, emp_id)
    );""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_snapshot_records_emp_id
        ON frontend.employee_snapshot_records(emp_id);""")

    cur.execute("""CREATE INDEX IF NOT EXISTS idx_snapshot_records_batch_id
        ON frontend.employee_snapshot_records(batch_id);""")

    conn.commit()
    cur.close()
    conn.close()


if __name__ == "__main__":
    init_tables()
    print("Database tables initialized successfully.")
