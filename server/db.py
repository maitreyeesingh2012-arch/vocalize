"""SQLite access and schema migrations."""
import json
import re
import sqlite3
from contextlib import contextmanager

from flask import current_app


@contextmanager
def get_db(db_path=None):
    conn = sqlite3.connect(db_path or current_app.config['DB_PATH'], timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def table_columns(conn, table):
    return {r['name'] for r in conn.execute(f"PRAGMA table_info({table})")}


def add_missing_columns(conn, table, columns):
    existing = table_columns(conn, table)
    for name, col_type in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_type}")


def dumps(value):
    return json.dumps(value, separators=(',', ':'))


def loads(text, default=None):
    if not text:
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


SESSION_METRICS_DDL = """
    CREATE TABLE IF NOT EXISTS session_metrics (
        session_id          INTEGER PRIMARY KEY,
        f0_mean_hz          REAL,
        f0_range_semitones  REAL,
        vibrato_present     BOOLEAN,
        vibrato_rate_hz     REAL,
        vibrato_extent_st   REAL,
        avg_phrase_s        REAL,
        register_breaks     INTEGER,
        dynamic_range_db    REAL,
        intonation_level    TEXT,
        breath_level        TEXT,
        resonance_level     TEXT,
        intonation_score    REAL,
        stability_score     REAL,
        vibrato_score       REAL,
        breath_score        REAL,
        resonance_score     REAL,
        dynamics_score      REAL,
        passaggio_score     REAL,
        pitch_bias          TEXT,
        ref_melody_accuracy REAL,
        ref_rhythm_accuracy REAL,
        ref_pitch_dev_cents REAL,
        ref_missed_pct      REAL,
        ref_early_late_ms   REAL,
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    )"""

# Columns added after the first release; older databases get them via ALTER TABLE.
USER_EXTRA_COLUMNS = {
    'email': 'TEXT', 'password_hash': 'TEXT', 'is_guest': 'INTEGER NOT NULL DEFAULT 0',
    'known_issues': 'TEXT', 'onboarded': 'INTEGER NOT NULL DEFAULT 0', 'voice_type': 'TEXT',
    'reminder_time': 'TEXT',
}
SESSION_EXTRA_COLUMNS = {'issues': 'TEXT', 'has_reference': 'INTEGER NOT NULL DEFAULT 0',
                         'learned_score': 'REAL', 'singing_probability': 'REAL', 'rule_overall_score': 'REAL', 'score_source': 'TEXT',
                         'usable_probability': 'REAL'}
METRIC_EXTRA_COLUMNS = {
    'intonation_score': 'REAL', 'stability_score': 'REAL', 'vibrato_score': 'REAL',
    'breath_score': 'REAL', 'resonance_score': 'REAL', 'dynamics_score': 'REAL',
    'passaggio_score': 'REAL', 'pitch_bias': 'TEXT',
    'ref_melody_accuracy': 'REAL', 'ref_rhythm_accuracy': 'REAL', 'ref_pitch_dev_cents': 'REAL',
    'ref_missed_pct': 'REAL', 'ref_early_late_ms': 'REAL',
}


def initialize_database(db_path):
    """Create tables if missing and upgrade databases made by older versions."""
    with get_db(db_path) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                email               TEXT UNIQUE NOT NULL,
                password_hash       TEXT NOT NULL,
                display_name        TEXT NOT NULL,
                is_guest            INTEGER NOT NULL DEFAULT 0,
                created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                years_singing       TEXT,
                takes_lessons       BOOLEAN,
                self_assessed_level TEXT,
                practice_days_pw    INTEGER,
                genres              TEXT,
                goals               TEXT,
                known_issues        TEXT,
                onboarded           INTEGER NOT NULL DEFAULT 0,
                voice_type          TEXT,
                reminder_time       TEXT
            )""")
        add_missing_columns(conn, 'users', USER_EXTRA_COLUMNS)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER NOT NULL,
                timestamp      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                label          TEXT,
                voice_type     TEXT,
                reference_song TEXT,
                duration_s     REAL,
                overall_score  REAL,
                audio_filename TEXT,
                issues         TEXT,
                has_reference  INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )""")
        add_missing_columns(conn, 'sessions', SESSION_EXTRA_COLUMNS)
        # Upgrade previously overridden scores once, retaining the learned output
        # for diagnosis. This also keeps history, progress and shared reports aligned.
        conn.execute("""
            UPDATE sessions SET overall_score = rule_overall_score, score_source = 'technique-v1'
            WHERE score_source IS NULL AND rule_overall_score IS NOT NULL
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, timestamp)")

        # Earlier app versions pointed session_metrics.session_id at users(id).
        # SQLite can't alter a foreign key, so rebuild the table if needed.
        old = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_metrics'").fetchone()
        if old and re.search(r"REFERENCES\s+users", old['sql'], re.IGNORECASE):
            old_cols = table_columns(conn, 'session_metrics')
            conn.execute("ALTER TABLE session_metrics RENAME TO session_metrics_old")
            conn.execute(SESSION_METRICS_DDL)
            shared = ', '.join(sorted(old_cols & table_columns(conn, 'session_metrics')))
            conn.execute(f"INSERT INTO session_metrics ({shared}) SELECT {shared} FROM session_metrics_old")
            conn.execute("DROP TABLE session_metrics_old")
        else:
            conn.execute(SESSION_METRICS_DDL)
            add_missing_columns(conn, 'session_metrics', METRIC_EXTRA_COLUMNS)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS session_tips (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                category   TEXT NOT NULL,
                severity   TEXT NOT NULL,
                headline   TEXT NOT NULL,
                detail     TEXT NOT NULL,
                exercise   TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
            )""")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS session_series (
                session_id INTEGER PRIMARY KEY,
                data       TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
            )""")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_tokens (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id      INTEGER NOT NULL,
                token_hash   TEXT UNIQUE NOT NULL,
                label        TEXT,
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )""")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS practice_results (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                kind       TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                score      REAL,
                data       TEXT,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_practice_user ON practice_results (user_id, kind, created_at)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS practice_plans (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id           INTEGER NOT NULL,
                created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                source_session_id INTEGER,
                focus             TEXT,
                summary           TEXT,
                active            INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (source_session_id) REFERENCES sessions (id) ON DELETE SET NULL
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS plan_items (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                plan_id  INTEGER NOT NULL,
                day      INTEGER NOT NULL,
                position INTEGER NOT NULL,
                kind     TEXT NOT NULL,
                title    TEXT NOT NULL,
                detail   TEXT,
                target   TEXT,
                done_at  TIMESTAMP,
                FOREIGN KEY (plan_id) REFERENCES practice_plans (id) ON DELETE CASCADE
            )""")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS share_links (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                token         TEXT UNIQUE NOT NULL,
                user_id       INTEGER NOT NULL,
                session_id    INTEGER NOT NULL,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                include_audio INTEGER NOT NULL DEFAULT 0,
                revoked       INTEGER NOT NULL DEFAULT 0,
                views         INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
            )""")
