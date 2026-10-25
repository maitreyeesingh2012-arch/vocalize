"""Practice tools: drill results, range history, breath trainer and the weekly plan."""
from collections import defaultdict

import librosa
from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from . import plans
from .db import dumps, get_db, loads

bp = Blueprint('practice', __name__)

KINDS = ('warmup', 'pitch_match', 'range', 'breath', 'tuner')


@bp.route('/api/practice/results', methods=['POST'])
@login_required
def save_result():
    data = request.get_json(silent=True) or {}
    kind = data.get('kind')
    if kind not in KINDS:
        return jsonify({'success': False, 'error': 'Unknown practice type.'}), 400
    score = data.get('score')
    score = float(score) if isinstance(score, (int, float)) else None
    detail = data.get('data') if isinstance(data.get('data'), dict) else {}
    with get_db() as conn:
        rid = conn.execute("INSERT INTO practice_results (user_id, kind, score, data) VALUES (?, ?, ?, ?)",
                           (current_user.id, kind, score, dumps(detail)[:20000])).lastrowid
        item_id = data.get('plan_item_id')
        if item_id:
            _mark_item(conn, item_id, True)
    return jsonify({'success': True, 'id': rid})


@bp.route('/api/practice/results', methods=['GET'])
@login_required
def list_results():
    kind = request.args.get('kind')
    limit = min(int(request.args.get('limit', 30)), 200)
    with get_db() as conn:
        q = "SELECT id, kind, created_at, score, data FROM practice_results WHERE user_id = ?"
        args = [current_user.id]
        if kind:
            q += " AND kind = ?"
            args.append(kind)
        rows = conn.execute(q + " ORDER BY created_at DESC, id DESC LIMIT ?", (*args, limit)).fetchall()
    return jsonify({'success': True, 'results': [{**dict(r), 'data': loads(r['data'], {})} for r in rows]})


@bp.route('/api/practice/summary', methods=['GET'])
@login_required
def summary():
    """What the practice tools need to personalize themselves: range, voice type, trouble notes."""
    with get_db() as conn:
        user = conn.execute("SELECT voice_type FROM users WHERE id = ?", (current_user.id,)).fetchone()
        ranges = conn.execute("""SELECT created_at, data FROM practice_results WHERE user_id = ? AND kind = 'range'
                                 ORDER BY created_at DESC, id DESC LIMIT 20""", (current_user.id,)).fetchall()
        best_breath = conn.execute("""SELECT MAX(score) AS best FROM practice_results
                                      WHERE user_id = ? AND kind = 'breath'""", (current_user.id,)).fetchone()['best']
        drills = conn.execute("""SELECT data FROM practice_results WHERE user_id = ? AND kind = 'pitch_match'
                                 ORDER BY created_at DESC LIMIT 30""", (current_user.id,)).fetchall()
        last = conn.execute("""SELECT ss.data FROM sessions s JOIN session_series ss ON ss.session_id = s.id
                               WHERE s.user_id = ? ORDER BY s.timestamp DESC, s.id DESC LIMIT 1""",
                            (current_user.id,)).fetchone()

    # Per-note accuracy from pitch-matching drills
    per_note = defaultdict(lambda: {'tries': 0, 'hits': 0, 'abs_cents': 0.0})
    for d in drills:
        for att in loads(d['data'], {}).get('attempts', []):
            if att.get('target') is None:
                continue
            n = per_note[int(att['target'])]
            n['tries'] += 1
            n['hits'] += 1 if att.get('hit') else 0
            n['abs_cents'] += abs(att.get('cents') or 0)
    note_stats = [{'midi': m, 'name': librosa.midi_to_note(m), 'tries': v['tries'],
                   'accuracy': round(v['hits'] / v['tries'] * 100), 'avg_cents': round(v['abs_cents'] / v['tries'])}
                  for m, v in sorted(per_note.items())]

    trouble = [s['midi'] for s in sorted(note_stats, key=lambda s: s['accuracy']) if s['tries'] >= 2 and s['accuracy'] < 70][:4]
    series = loads(last['data'], {}) if last else {}
    for p in series.get('problem_notes', []):
        m = plans.note_to_midi(p['name'])
        if m and m not in trouble:
            trouble.append(m)
    comfort = plans.comfort_note(series)

    range_history = [{'created_at': r['created_at'], **loads(r['data'], {})} for r in ranges]
    return jsonify({
        'success': True,
        'voice_type': user['voice_type'],
        'range': range_history[0] if range_history else None,
        'range_history': range_history,
        'passaggio': series.get('passaggio'),
        'comfort_note': comfort,
        'trouble_notes': trouble[:6],
        'note_stats': note_stats,
        'best_breath_s': best_breath,
    })


# ─────────────────────────────────────────────────────────────
# Weekly plan
# ─────────────────────────────────────────────────────────────

def _active_plan(conn):
    return conn.execute("SELECT * FROM practice_plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1",
                        (current_user.id,)).fetchone()


@bp.route('/api/plan', methods=['GET'])
@login_required
def get_plan():
    with get_db() as conn:
        plan = _active_plan(conn)
        return jsonify({'success': True, 'plan': plans.plan_payload(conn, plan) if plan else None})


@bp.route('/api/plan', methods=['POST'])
@login_required
def new_plan():
    session_id = (request.get_json(silent=True) or {}).get('session_id')
    with get_db() as conn:
        if session_id:
            ok = conn.execute("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?", (session_id, current_user.id)).fetchone()
        else:
            ok = conn.execute("SELECT id FROM sessions WHERE user_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1",
                              (current_user.id,)).fetchone()
            session_id = ok['id'] if ok else None
        if not ok:
            return jsonify({'success': False, 'error': 'Record a session first so the plan can be built around it.'}), 400
        plans.create_plan(conn, current_user.id, session_id)
        return jsonify({'success': True, 'plan': plans.plan_payload(conn, _active_plan(conn))})


def _mark_item(conn, item_id, done):
    conn.execute("""
        UPDATE plan_items SET done_at = CASE WHEN ? THEN COALESCE(done_at, CURRENT_TIMESTAMP) ELSE NULL END
        WHERE id = ? AND plan_id IN (SELECT id FROM practice_plans WHERE user_id = ?)
    """, (1 if done else 0, item_id, current_user.id))


@bp.route('/api/plan/items/<int:item_id>', methods=['POST'])
@login_required
def set_item(item_id):
    done = bool((request.get_json(silent=True) or {}).get('done', True))
    with get_db() as conn:
        _mark_item(conn, item_id, done)
        plan = _active_plan(conn)
        return jsonify({'success': True, 'plan': plans.plan_payload(conn, plan) if plan else None})
