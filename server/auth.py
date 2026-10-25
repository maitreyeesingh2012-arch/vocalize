"""
Accounts and authentication.

The web app uses a Flask-Login session cookie. Native (Capacitor) apps can't rely on
cross-origin cookies, so any login endpoint also returns a bearer token when the
request says it is an app (header `X-Client: app` or JSON `"client": "app"`).
Send it back as `Authorization: Bearer <token>`.
"""
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import re
import secrets
import sqlite3

from flask import Blueprint, current_app, g, jsonify, request
from flask_login import LoginManager, UserMixin, current_user, login_required, login_user, logout_user
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get_db, loads, table_columns

bp = Blueprint('auth', __name__)
login_manager = LoginManager()


@login_manager.unauthorized_handler
def unauthorized():
    return jsonify({'success': False, 'error': 'Please log in first.'}), 401


class User(UserMixin):
    def __init__(self, row):
        self.id = row['id']
        self.email = row['email']
        self.display_name = row['display_name']
        self.is_guest = bool(row['is_guest'])
        self.onboarded = bool(row['onboarded'])

    def to_json(self):
        return {'email': None if self.is_guest else self.email, 'display_name': self.display_name,
                'is_guest': self.is_guest, 'onboarded': self.onboarded}


USER_FIELDS = "id, email, display_name, is_guest, onboarded"


def fetch_user(conn, user_id):
    row = conn.execute(f"SELECT {USER_FIELDS} FROM users WHERE id = ?", (user_id,)).fetchone()
    return User(row) if row else None


@login_manager.user_loader
def load_user(user_id):
    with get_db() as conn:
        return fetch_user(conn, user_id)


def _hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


@login_manager.request_loader
def load_user_from_token(req):
    header = req.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return None
    token_hash = _hash_token(header[7:].strip())
    with get_db() as conn:
        row = conn.execute("SELECT user_id FROM api_tokens WHERE token_hash = ?", (token_hash,)).fetchone()
        if not row:
            return None
        conn.execute("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?", (token_hash,))
        g.bearer_token_hash = token_hash
        return fetch_user(conn, row['user_id'])


def wants_token():
    body = request.get_json(silent=True) or {}
    return request.headers.get('X-Client') == 'app' or body.get('client') == 'app'


def sign_in(conn, user, remember=False):
    """Log the user in (cookie) and, for app clients, mint a bearer token."""
    login_user(user, remember=remember)
    payload = {'success': True, **user.to_json()}
    if wants_token():
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, ?, ?)",
                     (user.id, _hash_token(token), request.headers.get('User-Agent', '')[:120]))
        payload['token'] = token
    return jsonify(payload)


# ─────────────────────────────────────────────────────────────
# CORS for native apps (their web views run on capacitor://localhost etc.)
# ─────────────────────────────────────────────────────────────

@bp.before_app_request
def cors_preflight():
    if request.method == 'OPTIONS' and request.path.startswith('/api/'):
        return current_app.make_default_options_response()


@bp.after_app_request
def add_cors_headers(response):
    origin = request.headers.get('Origin')
    if origin and origin in current_app.config['CORS_ORIGINS'] and request.path.startswith('/api/'):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
        response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Client, X-Timezone-Offset'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        response.headers['Access-Control-Max-Age'] = '600'
    return response


# ─────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────

def is_valid_email(email):
    return bool(re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+$", email))


def read_credentials():
    """Parse and validate email/password from the JSON body. Returns (email, password, error)."""
    data = request.get_json(silent=True) or {}
    email = str(data.get('email', '')).strip().lower()
    password = str(data.get('password', ''))
    if not email or not password:
        return email, password, 'Email and password are required.'
    if not is_valid_email(email):
        return email, password, 'Please enter a valid email address.'
    if len(password) < 8:
        return email, password, 'Password must be at least 8 characters.'
    return email, password, None


def insert_user(conn, email, password_hash, display_name, is_guest=False):
    # Databases from the CLI era also have a required, unique `username` column.
    if 'username' in table_columns(conn, 'users'):
        cur = conn.execute(
            "INSERT INTO users (username, email, password_hash, display_name, is_guest) VALUES (?, ?, ?, ?, ?)",
            (email, email, password_hash, display_name, int(is_guest)))
    else:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, display_name, is_guest) VALUES (?, ?, ?, ?)",
            (email, password_hash, display_name, int(is_guest)))
    return cur.lastrowid


@bp.route('/api/me', methods=['GET'])
def me():
    if current_user.is_authenticated:
        return jsonify({'authenticated': True, **current_user.to_json()})
    return jsonify({'authenticated': False})


AGE_ERROR = 'Vocalize is for singers aged 13 and over. Please confirm your age to continue.'


def age_confirmed():
    """New accounts (including guests) must confirm they are 13+: the app stores voice recordings."""
    return (request.get_json(silent=True) or {}).get('age_confirmed') is True


@bp.route('/api/register', methods=['POST'])
def register():
    if not age_confirmed():
        return jsonify({'success': False, 'error': AGE_ERROR}), 400
    email, password, error = read_credentials()
    if error:
        return jsonify({'success': False, 'error': error}), 400
    name = str((request.get_json(silent=True) or {}).get('display_name', '')).strip()[:40]
    if not name:
        return jsonify({'success': False, 'error': 'Please tell us what to call you.'}), 400
    try:
        with get_db() as conn:
            user_id = insert_user(conn, email, generate_password_hash(password, method='scrypt'), name)
            return sign_in(conn, fetch_user(conn, user_id))
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'An account with this email already exists.'}), 400


@bp.route('/api/config', methods=['GET'])
def public_config():
    """Settings the sign-in page needs (public values only)."""
    return jsonify({'google_client_id': current_app.config.get('GOOGLE_CLIENT_ID') or None})


@bp.route('/api/auth/google', methods=['POST'])
def google_sign_in():
    """Sign in (or sign up) with a Google ID token from Google Identity Services."""
    client_id = current_app.config.get('GOOGLE_CLIENT_ID')
    if not client_id:
        return jsonify({'success': False, 'error': 'Google sign-in is not set up on this server.'}), 404
    data = request.get_json(silent=True) or {}
    url = 'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'id_token': data.get('credential', '')})
    try:   # Google verifies the token's signature and expiry for us
        with urllib.request.urlopen(url, timeout=10) as r:
            info = json.load(r)
    except urllib.error.HTTPError:
        info = {}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return jsonify({'success': False, 'error': "Couldn't reach Google. Please try again."}), 502
    if info.get('aud') != client_id or info.get('email_verified') not in ('true', True) or not info.get('email'):
        return jsonify({'success': False, 'error': 'Google sign-in failed. Please try again.'}), 401
    email = info['email'].lower()
    with get_db() as conn:
        row = conn.execute("SELECT id FROM users WHERE email = ? AND is_guest = 0", (email,)).fetchone()
        if row:
            return sign_in(conn, fetch_user(conn, row['id']))
        if not age_confirmed():
            return jsonify({'success': False, 'error': AGE_ERROR}), 400
        user_id = insert_user(conn, email, generate_password_hash(secrets.token_urlsafe(32), method='scrypt'),
                              (info.get('given_name') or info.get('name') or email.split('@')[0])[:40])
        return sign_in(conn, fetch_user(conn, user_id))


@bp.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get('email', '')).strip().lower()
    password = str(data.get('password', ''))
    with get_db() as conn:
        row = conn.execute("SELECT id, password_hash, is_guest FROM users WHERE email = ?", (email,)).fetchone()
        if row and row['password_hash'] and not row['is_guest'] and check_password_hash(row['password_hash'], password):
            return sign_in(conn, fetch_user(conn, row['id']))
    return jsonify({'success': False, 'error': 'Invalid email or password.'}), 401


@bp.route('/api/guest', methods=['POST'])
def guest_login():
    """Sign in as a throwaway guest account; no email or password needed."""
    if current_user.is_authenticated:
        return jsonify({'success': True, **current_user.to_json()})
    if not age_confirmed():
        return jsonify({'success': False, 'error': AGE_ERROR}), 400
    # The guest can never log in with a password; access is only via this browser's cookie or app token.
    email = f"guest-{secrets.token_hex(8)}@guest.vocalize.local"
    with get_db() as conn:
        user_id = insert_user(conn, email, generate_password_hash(secrets.token_urlsafe(32), method='scrypt'),
                              'Guest', is_guest=True)
        return sign_in(conn, fetch_user(conn, user_id), remember=True)


@bp.route('/api/claim', methods=['POST'])
@login_required
def claim_guest_account():
    """Turn the current guest into a regular account, keeping all its sessions."""
    if not current_user.is_guest:
        return jsonify({'success': False, 'error': 'This account already has a login.'}), 400
    email, password, error = read_credentials()
    if error:
        return jsonify({'success': False, 'error': error}), 400
    try:
        with get_db() as conn:
            conn.execute(
                "UPDATE users SET email = ?, password_hash = ?, display_name = ?, is_guest = 0 WHERE id = ?",
                (email, generate_password_hash(password, method='scrypt'), email.split('@')[0].capitalize(),
                 current_user.id))
            if 'username' in table_columns(conn, 'users'):
                conn.execute("UPDATE users SET username = ? WHERE id = ?", (email, current_user.id))
            user = fetch_user(conn, current_user.id)
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'An account with this email already exists.'}), 400
    login_user(user)
    return jsonify({'success': True, **user.to_json()})


@bp.route('/api/logout', methods=['POST'])
@login_required
def logout():
    token_hash = g.get('bearer_token_hash')
    if token_hash:
        with get_db() as conn:
            conn.execute("DELETE FROM api_tokens WHERE token_hash = ?", (token_hash,))
    logout_user()
    return jsonify({'success': True})


@bp.route('/api/account', methods=['DELETE'])
@login_required
def delete_account():
    """Permanently delete the account and everything in it (required by the App Store)."""
    data = request.get_json(silent=True) or {}
    if data.get('confirm') != 'DELETE':
        return jsonify({'success': False, 'error': 'Type DELETE to confirm.'}), 400
    user_id = current_user.id
    with get_db() as conn:
        files = [r['audio_filename'] for r in
                 conn.execute("SELECT audio_filename FROM sessions WHERE user_id = ?", (user_id,)) if r['audio_filename']]
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    for name in files:
        path = os.path.join(current_app.config['AUDIO_DIR'], os.path.basename(name))
        if os.path.exists(path):
            os.remove(path)
    logout_user()
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────
# Singer profile (onboarding questionnaire)
# ─────────────────────────────────────────────────────────────

PROFILE_FIELDS = ('years_singing', 'takes_lessons', 'self_assessed_level', 'practice_days_pw',
                  'genres', 'goals', 'known_issues', 'reminder_time')


def profile_choices():
    import vocal_analyzer as va
    return {
        'years_singing': ["Less than a year", "1 to 3 years", "3 to 7 years", "More than 7 years"],
        'self_assessed_level': ["Total beginner", "I know the basics",
                                "I sing for people sometimes", "I perform regularly"],
        'practice_days_pw': [{'label': 'Rarely', 'value': 0}, {'label': 'Once or twice', 'value': 1},
                             {'label': 'Three or four times', 'value': 3}, {'label': 'Almost every day', 'value': 6}],
        'genres': va.GENRE_CHOICES,
        'goals': va.GOAL_CHOICES,
        'known_issues': va.KNOWN_ISSUE_CHOICES,
    }


def read_profile(conn, user_id):
    row = conn.execute(f"SELECT display_name, voice_type, {', '.join(PROFILE_FIELDS)} FROM users WHERE id = ?",
                       (user_id,)).fetchone()
    return {
        'display_name': row['display_name'],
        'voice_type': row['voice_type'],
        'years_singing': row['years_singing'],
        'takes_lessons': bool(row['takes_lessons']) if row['takes_lessons'] is not None else None,
        'self_assessed_level': row['self_assessed_level'],
        'practice_days_pw': row['practice_days_pw'],
        'genres': loads(row['genres'], []),
        'goals': loads(row['goals'], []),
        'known_issues': loads(row['known_issues'], []),
        'reminder_time': row['reminder_time'],
    }


@bp.route('/api/profile', methods=['GET'])
@login_required
def get_profile():
    with get_db() as conn:
        return jsonify({'success': True, 'profile': read_profile(conn, current_user.id), 'choices': profile_choices()})


@bp.route('/api/profile', methods=['PUT'])
@login_required
def update_profile():
    import json
    data = request.get_json(silent=True) or {}
    choices = profile_choices()
    updates = {}

    def pick_one(key):
        if key in data and data[key] in choices[key]:
            updates[key] = data[key]

    def pick_many(key, limit=None):
        if key in data and isinstance(data[key], list):
            vals = [v for v in data[key] if v in choices[key]]
            updates[key] = json.dumps(vals[:limit] if limit else vals)

    pick_one('years_singing')
    pick_one('self_assessed_level')
    pick_many('genres')
    pick_many('goals', limit=3)
    pick_many('known_issues')
    if 'takes_lessons' in data:
        updates['takes_lessons'] = 1 if data['takes_lessons'] else 0
    if 'practice_days_pw' in data and data['practice_days_pw'] in (0, 1, 3, 6):
        updates['practice_days_pw'] = data['practice_days_pw']
    if 'reminder_time' in data:
        rt = data['reminder_time']
        updates['reminder_time'] = rt if (rt is None or re.match(r"^\d{2}:\d{2}$", str(rt))) else None
    if 'display_name' in data and str(data['display_name']).strip():
        updates['display_name'] = str(data['display_name']).strip()[:40]
    if data.get('onboarded'):
        updates['onboarded'] = 1

    with get_db() as conn:
        if updates:
            cols = ', '.join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE users SET {cols} WHERE id = ?", (*updates.values(), current_user.id))
        return jsonify({'success': True, 'profile': read_profile(conn, current_user.id),
                        'user': fetch_user(conn, current_user.id).to_json()})
