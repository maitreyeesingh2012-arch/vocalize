"""Runtime configuration. Every setting can be overridden with an environment variable."""
import os
import secrets

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _secret_key():
    env_key = os.environ.get('VOCALIZE_SECRET_KEY')
    if env_key:
        return env_key
    # Kept beside the app (where earlier versions stored it) so existing logins stay valid.
    path = os.path.join(BASE_DIR, '.secret_key')
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, 'w') as f:
        f.write(key)
    return key


def load_config():
    data_dir = os.environ.get('VOCALIZE_DATA_DIR') or os.path.join(BASE_DIR, 'data')
    cors = os.environ.get('VOCALIZE_CORS_ORIGINS',
                          'capacitor://localhost,http://localhost,https://localhost,ionic://localhost')
    return {
        'BASE_DIR': BASE_DIR,
        'WEB_DIR': os.path.join(BASE_DIR, 'web'),
        'DATA_DIR': data_dir,
        'DB_PATH': os.environ.get('VOCALIZE_DB') or os.path.join(BASE_DIR, 'vocalize_vault.db'),
        'AUDIO_DIR': os.path.join(data_dir, 'audio'),
        'REF_CACHE_DIR': os.path.join(data_dir, 'ref_cache'),
        'SECRET_KEY': _secret_key(),
        'MAX_CONTENT_LENGTH': 80 * 1024 * 1024,        # vocal take + optional reference song
        'CORS_ORIGINS': [o.strip() for o in cors.split(',') if o.strip()],
        'ANALYSIS_WORKERS': int(os.environ.get('VOCALIZE_WORKERS', '2')),
        'GOOGLE_CLIENT_ID': os.environ.get('VOCALIZE_GOOGLE_CLIENT_ID', ''),   # enables "Sign in with Google"
        'SESSION_COOKIE_SAMESITE': 'Lax',
        'REMEMBER_COOKIE_SAMESITE': 'Lax',
        'SESSION_COOKIE_SECURE': os.environ.get('VOCALIZE_SECURE_COOKIES') == '1',
        'REMEMBER_COOKIE_SECURE': os.environ.get('VOCALIZE_SECURE_COOKIES') == '1',
        'TEMPLATES_AUTO_RELOAD': True,
        'SEND_FILE_MAX_AGE_DEFAULT': 0,                 # web assets change often during development
    }
