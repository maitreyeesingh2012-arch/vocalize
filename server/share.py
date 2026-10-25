"""Read-only links a singer can send to their teacher."""
import secrets

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from flask_login import current_user, login_required

from .db import get_db
from .sessions import audio_path_for, build_session_payload, send_audio

bp = Blueprint('share', __name__)


def _share_url(token):
    base = current_app.config.get('PUBLIC_BASE_URL') or request.host_url.rstrip('/')
    return f"{base}/r/{token}"


@bp.route('/api/session/<int:session_id>/share', methods=['POST'])
@login_required
def create_share(session_id):
    include_audio = bool((request.get_json(silent=True) or {}).get('include_audio'))
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?",
                            (session_id, current_user.id)).fetchone():
            return jsonify({'success': False, 'error': 'Session not found or access denied.'}), 404
        token = secrets.token_urlsafe(16)
        conn.execute("INSERT INTO share_links (token, user_id, session_id, include_audio) VALUES (?, ?, ?, ?)",
                     (token, current_user.id, session_id, int(include_audio)))
    return jsonify({'success': True, 'token': token, 'url': _share_url(token), 'include_audio': include_audio})


@bp.route('/api/session/<int:session_id>/shares', methods=['GET'])
@login_required
def list_shares(session_id):
    with get_db() as conn:
        rows = conn.execute("""SELECT token, created_at, include_audio, views FROM share_links
                               WHERE session_id = ? AND user_id = ? AND revoked = 0 ORDER BY id DESC""",
                            (session_id, current_user.id)).fetchall()
    return jsonify({'success': True, 'shares': [{**dict(r), 'url': _share_url(r['token'])} for r in rows]})


@bp.route('/api/share/<token>', methods=['DELETE'])
@login_required
def revoke_share(token):
    with get_db() as conn:
        cur = conn.execute("UPDATE share_links SET revoked = 1 WHERE token = ? AND user_id = ?",
                           (token, current_user.id))
    if cur.rowcount == 0:
        return jsonify({'success': False, 'error': 'Link not found.'}), 404
    return jsonify({'success': True})


def _live_link(conn, token):
    return conn.execute("SELECT * FROM share_links WHERE token = ? AND revoked = 0", (token,)).fetchone()


@bp.route('/api/public/share/<token>', methods=['GET'])
def public_report(token):
    with get_db() as conn:
        link = _live_link(conn, token)
        if not link:
            return jsonify({'success': False, 'error': 'This link has expired or was turned off.'}), 404
        payload = build_session_payload(conn, link['session_id'])
        singer = conn.execute("SELECT display_name, is_guest FROM users WHERE id = ?", (link['user_id'],)).fetchone()
        conn.execute("UPDATE share_links SET views = views + 1 WHERE id = ?", (link['id'],))
    payload['session']['has_audio'] = bool(link['include_audio']) and payload['session']['has_audio']
    payload['session'].pop('user_id', None)
    payload['singer'] = 'A Vocalize singer' if singer['is_guest'] else singer['display_name']
    return jsonify({'success': True, 'payload': payload})


@bp.route('/api/public/share/<token>/audio', methods=['GET'])
def public_audio(token):
    with get_db() as conn:
        link = _live_link(conn, token)
        path = audio_path_for(conn, link['session_id']) if link and link['include_audio'] else None
    if not path:
        return jsonify({'success': False, 'error': 'No recording shared.'}), 404
    return send_audio(path)


@bp.route('/r/<token>')
def share_page(token):
    return send_from_directory(current_app.config['WEB_DIR'], 'share.html')
