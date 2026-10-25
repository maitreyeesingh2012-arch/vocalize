"""Recording analysis, session history, audio replay and progress."""
import os
import shutil
import tempfile
from collections import Counter
from datetime import timedelta

import librosa
from flask import Blueprint, current_app, jsonify, request, send_file
from flask_login import current_user, login_required

from . import analysis
from .analysis import AREA_COLUMNS, local_today, parse_tz_offset, to_local
from .db import get_db, loads

bp = Blueprint('sessions', __name__)


def tz_offset():
    return parse_tz_offset(request.headers.get('X-Timezone-Offset') or request.args.get('tz'))


def hz_to_note(hz):
    try:
        return librosa.hz_to_note(hz) if hz and hz > 0 else None
    except Exception:
        return None


def build_session_payload(conn, session_id, user_id=None, include_series=True):
    """One session's full report. With user_id, returns None unless the session is theirs."""
    if user_id is None:
        sess = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    else:
        sess = conn.execute("SELECT * FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id)).fetchone()
    if not sess:
        return None
    met = conn.execute("SELECT * FROM session_metrics WHERE session_id = ?", (session_id,)).fetchone()
    tips = conn.execute(
        "SELECT category, severity, headline, detail, exercise FROM session_tips WHERE session_id = ? ORDER BY id",
        (session_id,)).fetchall()
    met = dict(met) if met else {}
    sess = dict(sess)
    has_audio = bool(sess.pop('audio_filename', None))
    sess.pop('issues', None)

    payload = {
        'session': {**sess, 'has_audio': has_audio},
        # Sessions saved before per-area scores were stored have None here; the UI shows levels instead.
        'scores': {
            'intonation': met.get('intonation_score'),
            'stability': met.get('stability_score'),
            'vibrato': met.get('vibrato_score'),
            'breath': met.get('breath_score'),
            'resonance': met.get('resonance_score'),
            'dynamics': met.get('dynamics_score'),
            'passaggio': met.get('passaggio_score'),
        },
        'levels': {
            'intonation': met.get('intonation_level'),
            'breath': met.get('breath_level'),
            'resonance': met.get('resonance_level'),
        },
        'metrics': {
            'f0_mean_hz': met.get('f0_mean_hz'),
            'centre_note': hz_to_note(met.get('f0_mean_hz')),
            'f0_range_semitones': met.get('f0_range_semitones'),
            'pitch_bias': met.get('pitch_bias'),
            'vibrato_present': bool(met.get('vibrato_present')),
            'vibrato_rate_hz': met.get('vibrato_rate_hz'),
            'vibrato_extent_st': met.get('vibrato_extent_st'),
            'avg_phrase_s': met.get('avg_phrase_s'),
            'register_breaks': met.get('register_breaks'),
            'dynamic_range_db': met.get('dynamic_range_db'),
        },
        'reference': None if met.get('ref_melody_accuracy') is None else {
            'melody_accuracy': met['ref_melody_accuracy'],
            'rhythm_accuracy': met['ref_rhythm_accuracy'],
            'pitch_dev_cents': met['ref_pitch_dev_cents'],
            'missed_pct': met['ref_missed_pct'],
            'early_late_ms': met['ref_early_late_ms'],
        },
        'tips': [dict(t) for t in tips],
    }
    if include_series:
        row = conn.execute("SELECT data FROM session_series WHERE session_id = ?", (session_id,)).fetchone()
        payload['series'] = loads(row['data']) if row else None
    return payload


# ─────────────────────────────────────────────────────────────
# Analysis jobs
# ─────────────────────────────────────────────────────────────

def _save_upload(file_storage, prefix):
    suffix = os.path.splitext(file_storage.filename or '')[1].lower() or '.wav'
    if len(suffix) > 6:
        suffix = '.bin'
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix)
    os.close(fd)
    file_storage.save(path)
    return path


@bp.route('/api/analyze', methods=['POST'])
@login_required
def start_analysis():
    audio = request.files.get('audio')
    if not audio or not audio.filename:
        return jsonify({'success': False, 'error': 'Missing audio file.'}), 400
    reference = request.files.get('reference')
    label = request.form.get('label', '').strip()[:80] or 'Practice session'
    ref_name = request.form.get('reference_query', '').strip()[:120]
    if reference and reference.filename and not ref_name:
        ref_name = os.path.splitext(reference.filename)[0][:120]

    audio_path = _save_upload(audio, 'vocalize_take_')
    ref_path = _save_upload(reference, 'vocalize_ref_') if reference and reference.filename else None
    job_id = analysis.submit(current_app._get_current_object(), current_user.id, audio_path, ref_path,
                             label, ref_name, tz_offset())
    return jsonify({'success': True, 'job_id': job_id}), 202


@bp.route('/api/session/<int:session_id>/rescore', methods=['POST'])
@login_required
def rescore_session(session_id):
    """Re-run the analysis on a saved recording with the current scorers, updating the session in place."""
    with get_db() as conn:
        row = conn.execute("SELECT label, reference_song FROM sessions WHERE id = ? AND user_id = ?",
                           (session_id, current_user.id)).fetchone()
        path = row and audio_path_for(conn, session_id, current_user.id)
    if not row:
        return jsonify({'success': False, 'error': 'Session not found or access denied.'}), 404
    if not path:
        return jsonify({'success': False, 'error': 'No recording saved for this session, so it cannot be re-scored.'}), 400
    fd, tmp = tempfile.mkstemp(prefix='vocalize_rescore_', suffix=os.path.splitext(path)[1])
    os.close(fd)
    shutil.copyfile(path, tmp)     # the job deletes its input when done
    job_id = analysis.submit(current_app._get_current_object(), current_user.id, tmp, None,
                             row['label'], row['reference_song'], tz_offset(), session_id=session_id)
    return jsonify({'success': True, 'job_id': job_id}), 202


@bp.route('/api/jobs/<job_id>', methods=['GET'])
@login_required
def job_status(job_id):
    job = analysis.get_job(job_id, current_user.id)
    if not job:
        return jsonify({'success': False, 'error': 'Job not found.'}), 404
    body = {'success': True, 'job': job}
    if job['status'] == 'done':
        with get_db() as conn:
            body['payload'] = build_session_payload(conn, job['session_id'], current_user.id)
    return jsonify(body)


# ─────────────────────────────────────────────────────────────
# History
# ─────────────────────────────────────────────────────────────

@bp.route('/api/history', methods=['GET'])
@login_required
def history():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, timestamp, label, voice_type, reference_song, duration_s, overall_score, has_reference,
                   audio_filename IS NOT NULL AND audio_filename != '' AS has_audio
            FROM sessions WHERE user_id = ? ORDER BY timestamp DESC, id DESC
        """, (current_user.id,)).fetchall()
    return jsonify({'sessions': [dict(r) for r in rows]})


@bp.route('/api/session/<int:session_id>', methods=['GET'])
@login_required
def session_detail(session_id):
    with get_db() as conn:
        payload = build_session_payload(conn, session_id, current_user.id)
    if not payload:
        return jsonify({'success': False, 'error': 'Session not found or access denied.'}), 404
    return jsonify({'success': True, 'payload': payload})


@bp.route('/api/session/<int:session_id>', methods=['PATCH'])
@login_required
def rename_session(session_id):
    label = str((request.get_json(silent=True) or {}).get('label', '')).strip()[:80]
    if not label:
        return jsonify({'success': False, 'error': 'Name cannot be empty.'}), 400
    with get_db() as conn:
        cur = conn.execute("UPDATE sessions SET label = ? WHERE id = ? AND user_id = ?",
                           (label, session_id, current_user.id))
    if cur.rowcount == 0:
        return jsonify({'success': False, 'error': 'Session not found or access denied.'}), 404
    return jsonify({'success': True})


def audio_path_for(conn, session_id, user_id=None):
    q = "SELECT audio_filename FROM sessions WHERE id = ?" + (" AND user_id = ?" if user_id else "")
    row = conn.execute(q, (session_id, user_id) if user_id else (session_id,)).fetchone()
    if not row or not row['audio_filename']:
        return None
    path = os.path.join(current_app.config['AUDIO_DIR'], os.path.basename(row['audio_filename']))
    return path if os.path.exists(path) else None


def send_audio(path):
    mimetype = 'audio/mpeg' if path.endswith('.mp3') else 'audio/wav'
    return send_file(path, mimetype=mimetype, conditional=True, max_age=3600)   # conditional → Range support


@bp.route('/api/session/<int:session_id>/audio', methods=['GET'])
@login_required
def session_audio(session_id):
    with get_db() as conn:
        path = audio_path_for(conn, session_id, current_user.id)
    if not path:
        return jsonify({'success': False, 'error': 'No recording saved for this session.'}), 404
    return send_audio(path)


@bp.route('/api/session/<int:session_id>', methods=['DELETE'])
@login_required
def delete_session(session_id):
    with get_db() as conn:
        path = audio_path_for(conn, session_id, current_user.id)
        cur = conn.execute("DELETE FROM sessions WHERE id = ? AND user_id = ?", (session_id, current_user.id))
    if cur.rowcount == 0:
        return jsonify({'success': False, 'error': 'Session not found or access denied.'}), 404
    if path:
        os.remove(path)
    return jsonify({'success': True})


# ─────────────────────────────────────────────────────────────
# Progress over time
# ─────────────────────────────────────────────────────────────

AREA_LABELS = {'Pitch': 'Pitch accuracy', 'Stability': 'Pitch stability', 'Vibrato': 'Vibrato',
               'Breath': 'Breath support', 'Resonance': 'Resonance & tone', 'Dynamics': 'Dynamic control',
               'Passaggio': 'Register changes'}


def _streaks(days, today):
    """Current and longest run of consecutive local days with any practice."""
    if not days:
        return 0, 0
    ordered = sorted(days)
    longest = run = 1
    for a, b in zip(ordered, ordered[1:]):
        run = run + 1 if (b - a).days == 1 else 1
        longest = max(longest, run)
    current = 0
    day = today if today in days else today - timedelta(days=1)   # streak survives until today ends
    while day in days:
        current += 1
        day -= timedelta(days=1)
    return current, longest


@bp.route('/api/progress', methods=['GET'])
@login_required
def progress():
    tz = tz_offset()
    today = local_today(tz)
    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT s.id, s.timestamp, s.label, s.overall_score, s.duration_s,
                   {', '.join('m.' + c for c in AREA_COLUMNS.values())}, m.f0_range_semitones
            FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id
            WHERE s.user_id = ? ORDER BY s.timestamp, s.id
        """, (current_user.id,)).fetchall()
        practice = conn.execute("SELECT kind, created_at, score FROM practice_results WHERE user_id = ?",
                                (current_user.id,)).fetchall()

    sessions = [{
        'id': r['id'], 'timestamp': r['timestamp'], 'label': r['label'], 'overall': r['overall_score'],
        'range_st': r['f0_range_semitones'],
        'scores': {area: r[col] for area, col in AREA_COLUMNS.items()},
    } for r in rows]

    activity = Counter()
    for r in rows:
        activity[to_local(r['timestamp'], tz).date()] += 1
    for p in practice:
        activity[to_local(p['created_at'], tz).date()] += 1
    current, longest = _streaks(set(activity), today)

    # Most improved: average of the latest three sessions vs. the three before them.
    improved = None
    scored = [s for s in sessions if s['scores']['Pitch'] is not None]
    if len(scored) >= 2:
        k = min(3, len(scored) // 2)
        best = None
        for area in AREA_COLUMNS:
            recent = [s['scores'][area] for s in scored[-k:] if s['scores'][area] is not None]
            before = [s['scores'][area] for s in scored[-2 * k:-k] if s['scores'][area] is not None]
            if recent and before:
                delta = sum(recent) / len(recent) - sum(before) / len(before)
                if best is None or delta > best[1]:
                    best = (area, delta)
        if best and best[1] > 0:
            improved = {'area': best[0], 'label': AREA_LABELS[best[0]], 'delta': round(best[1], 1)}

    start = today - timedelta(days=83)
    return jsonify({
        'success': True,
        'sessions': sessions,
        'area_labels': AREA_LABELS,
        'streak': {'current': current, 'longest': longest},
        'totals': {'sessions': len(sessions), 'practice': len(practice),
                   'minutes_sung': round(sum((r['duration_s'] or 0) for r in rows) / 60, 1)},
        'most_improved': improved,
        'activity': {(start + timedelta(days=i)).isoformat(): activity.get(start + timedelta(days=i), 0)
                     for i in range(84)},
    })
