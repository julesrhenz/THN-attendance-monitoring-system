import os

from flask import Flask

from routes.extensions import db, socketio


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("ATTENDANCE_SECRET_KEY", "attendance-system-secret-key")
    app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
        "DATABASE_URL", "postgresql://postgres:1234@192.9.224.6/attendance_db"
    )
    app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_BYTES", 25 * 1024 * 1024))

    # Flask's default (True) re-sends Set-Cookie with the CURRENT session
    # snapshot on every single response, even ones that never touch
    # `session` at all (e.g. read-only GET routes). sidebar.js polls
    # /api/me and /api/attendance/time-in-request every 30s on every page,
    # including Scanner Management -- so a poll that started just before,
    # but whose response lands just after, a session-writing request (e.g.
    # scanner-access verify/lock, login) can overwrite the browser's cookie
    # with a stale, pre-write copy of the session. Setting this to False
    # makes Flask only emit Set-Cookie when the session was actually
    # modified (`session.modified`), so read-only polling can no longer
    # race with and roll back real session writes.
    app.config["SESSION_REFRESH_EACH_REQUEST"] = False
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        # Remote Postgres connections can go stale between dashboard refreshes.
        # Validate borrowed connections and recycle them before common network
        # idle limits, while retaining a modest reusable pool for concurrent UI
        # requests.
        "pool_pre_ping": True,
        "pool_recycle": int(os.environ.get("DB_POOL_RECYCLE_SECONDS", 1800)),
        "pool_size": int(os.environ.get("DB_POOL_SIZE", 10)),
        "max_overflow": int(os.environ.get("DB_MAX_OVERFLOW", 10)),
        "pool_timeout": int(os.environ.get("DB_POOL_TIMEOUT_SECONDS", 30)),
        "connect_args": {"options": "-c search_path=frontend,public"},
    }

    db.init_app(app)
    socketio.init_app(app, cors_allowed_origins=os.environ.get("CORS_ALLOWED_ORIGINS", "*"))

    # Models must be imported (not necessarily used directly) so SQLAlchemy
    # is aware of them, e.g. for `flask db` migrations / create_all().
    from routes import models  # noqa: F401

    from routes.auth import auth_bp
    from routes.data import data_bp
    from routes.attendance import attendance_bp
    from routes.employees import employees_bp
    from routes.groupings import groupings_bp
    from routes.notifications import notifications_bp 
    from routes.scanners import scanners_bp
    from routes.user_management import user_management_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(data_bp)
    app.register_blueprint(attendance_bp)
    app.register_blueprint(employees_bp)
    app.register_blueprint(groupings_bp)
    app.register_blueprint(notifications_bp) 
    app.register_blueprint(scanners_bp)
    app.register_blueprint(user_management_bp)

    return app

app = create_app()

if __name__ == "__main__":
    print("\n========== ROUTES ==========")
    for rule in app.url_map.iter_rules():
        print(rule)
    print("============================\n")
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)

print("\n========== REGISTERED ROUTES ==========")
for rule in sorted(app.url_map.iter_rules(), key=lambda r: r.rule):
    print(f"{','.join(rule.methods):25} {rule.rule}")
print("=======================================\n")