from datetime import datetime, date

from routes.extensions import db


class EmployeeGrouping(db.Model):
    __tablename__  = "employee_groupings"
    __table_args__ = {"schema": "frontend"}

    emp_no       = db.Column("emp_id", db.String(50), primary_key=True)
    last_name    = db.Column(db.String(100))
    first_name   = db.Column(db.String(100))
    full_name    = db.Column(db.String(150))
    agency       = db.Column(db.String(50))
    line_name    = db.Column(db.String(100))
    section_name = db.Column(db.String(100))
    shift        = db.Column(db.String(20))
    process      = db.Column(db.String(100))
    line         = db.Column(db.String(50))
    emp          = db.Column(db.String(50))
    date_hired   = db.Column(db.Date)
    batch_id     = db.Column(db.Integer)
    updated_at   = db.Column(db.DateTime, default=datetime.utcnow)


class LineSnapshot(db.Model):
    __tablename__  = "line_snapshots"
    __table_args__ = {"schema": "frontend"}

    id            = db.Column(db.Integer, primary_key=True)
    snapshot_date = db.Column(db.Date, default=date.today)
    line_name     = db.Column(db.String(100))
    emp_no        = db.Column(db.String(50))
    employee_name = db.Column(db.String(150))
    agency        = db.Column(db.String(100))
    section       = db.Column(db.String(100))


class User(db.Model):
    __tablename__  = "users"
    __table_args__ = {"schema": "frontend"}

    username      = db.Column(db.String(50), primary_key=True, nullable=False)
    first_name    = db.Column(db.String(100))
    last_name     = db.Column(db.String(100))
    password_hash = db.Column(db.String(255), nullable=False)
    roles         = db.Column(db.String(30), nullable=False)


class ImportBatch(db.Model):
    __tablename__  = "import_batches"
    __table_args__ = {"schema": "frontend"}

    id              = db.Column(db.Integer, primary_key=True)
    filename        = db.Column(db.String(255))
    imported_by     = db.Column(db.String(100))
    imported_at     = db.Column(db.DateTime, default=datetime.utcnow)
    total_lines     = db.Column(db.Integer, default=0)
    total_employees = db.Column(db.Integer, default=0)