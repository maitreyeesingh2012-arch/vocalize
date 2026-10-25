"""
Vocalize server entry point.

    python app.py            production-style server (waitress) on http://127.0.0.1:5000
    python app.py --dev      Flask development server with auto-reload

Settings come from environment variables; see server/config.py and DEPLOYMENT.md.
"""
import os
import sys

from server import create_app

app = create_app()

if __name__ == '__main__':
    host = os.environ.get('VOCALIZE_HOST', '127.0.0.1')
    port = int(os.environ.get('VOCALIZE_PORT', '5000'))
    print(f"Vocalize server online at http://{host}:{port}")
    from server.learned import warm_up
    warm_up()
    if '--dev' in sys.argv:
        app.run(host=host, port=port, debug=True, use_reloader=True)
    else:
        from waitress import serve
        serve(app, host=host, port=port, threads=8)
