"""Vocalize API server + web app host."""
import os

from flask import Flask, send_from_directory

from .config import load_config


def create_app(overrides=None):
    config = load_config()
    config.update(overrides or {})
    if os.environ.get('VOCALIZE_PUBLIC_URL'):
        config['PUBLIC_BASE_URL'] = os.environ['VOCALIZE_PUBLIC_URL'].rstrip('/')

    # The web app in web/ is plain static files, so the same bundle can ship inside the native apps.
    app = Flask(__name__, static_folder=config['WEB_DIR'], static_url_path='')
    app.config.update(config)
    os.makedirs(app.config['AUDIO_DIR'], exist_ok=True)
    os.makedirs(app.config['REF_CACHE_DIR'], exist_ok=True)

    from .db import initialize_database
    initialize_database(app.config['DB_PATH'])

    from . import analysis, auth, practice, sessions, share
    auth.login_manager.init_app(app)
    analysis.init_executor(app.config['ANALYSIS_WORKERS'])
    for module in (auth, sessions, practice, share):
        app.register_blueprint(module.bp)

    @app.route('/')
    def index():
        return send_from_directory(app.config['WEB_DIR'], 'index.html')

    @app.route('/api/health')
    def health():
        return {'ok': True}

    return app
