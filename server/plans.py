"""
Seven-day practice plans built from a session's weakest areas.

Each plan item points at an in-app tool (`kind`) with parameters (`target`), so the
client can open the right exercise directly:
  warmup      {routine}                     guided warm-up routine
  pitch_match {notes: [midi], rounds}       hear a note, sing it back
  tuner       {note: midi, seconds, tolerance, mode}  hold a note on the live pitch meter
  breath      {seconds}                     timed "sss" breath trainer
  range       {}                            re-measure your range
  exercise    {}                            free-form exercise text (from the coaching tips)
  record      {}                            record a new session to measure progress
"""
import librosa

from .db import dumps, loads

AREAS = {  # area → (session_metrics column, friendly name, tips category keywords)
    'Pitch': ('intonation_score', 'pitch accuracy', ('pitch', 'intonation')),
    'Stability': ('stability_score', 'pitch stability', ('stability',)),
    'Breath': ('breath_score', 'breath support', ('breath', 'phrase')),
    'Vibrato': ('vibrato_score', 'vibrato', ('vibrato',)),
    'Resonance': ('resonance_score', 'resonance and tone', ('resonance', 'vowel', 'nasal')),
    'Dynamics': ('dynamics_score', 'dynamic control', ('dynamic',)),
    'Passaggio': ('passaggio_score', 'smooth register changes', ('passaggio', 'register', 'belt')),
}

WARMUP_FOR_AREA = {
    'Pitch': 'five_note_scale', 'Stability': 'five_note_scale', 'Breath': 'lip_trill',
    'Vibrato': 'lip_trill', 'Resonance': 'nay_resonance', 'Dynamics': 'messa_di_voce',
    'Passaggio': 'siren',
}


def note_to_midi(name):
    try:
        return int(round(librosa.note_to_midi(name.replace('♯', '#'))))
    except Exception:
        return None


def comfort_note(series):
    """Median sung note of a session (MIDI), or None if it has no notes."""
    notes = series.get('notes') or []
    return int(round(sorted(n['midi'] for n in notes)[len(notes) // 2])) if notes else None


def _weakest_areas(metrics):
    scored = [(metrics[col], area) for area, (col, _, _) in AREAS.items() if metrics.get(col) is not None]
    scored.sort()
    return [area for _, area in scored] or ['Pitch', 'Breath']


def _tip_exercise(tips, area):
    keys = AREAS[area][2]
    for t in tips:
        if t['severity'] in ('critical', 'warning') and any(k in t['category'].lower() for k in keys):
            return t['exercise'].split('\n\n')[0]
    return None


def _focus_items(area, day, comfort, trouble, tips):
    """Drills for one focus area on a given day (1–7), with gently rising targets."""
    ex = _tip_exercise(tips, area)
    if area == 'Pitch':
        return [
            ('pitch_match', 'Pitch matching', 'Hear each note, then sing it back. Aim to land within the green zone.',
             {'notes': trouble, 'rounds': 8 + day}),
            ('tuner', 'Long tone on the tuner', 'Hold one steady note and keep the needle centered.',
             {'note': comfort, 'seconds': 6 + day, 'tolerance': 25}),
        ]
    if area == 'Stability':
        return [
            ('tuner', 'Steady long tones', 'Hold the note without wobbling. Relax your jaw and keep the air steady.',
             {'note': comfort, 'seconds': 8 + day, 'tolerance': 20}),
            ('tuner', 'Steady tone, one step higher', 'Same exercise two semitones up.',
             {'note': comfort + 2, 'seconds': 6 + day, 'tolerance': 20}),
        ]
    if area == 'Breath':
        return [
            ('breath', 'Breath trainer: steady "sss"', 'Breathe low and wide, then hiss as evenly as you can.',
             {'seconds': 12 + 3 * day}),
            ('tuner', 'Sustain on one breath', 'Hold a comfortable note for as long as the tone stays supported.',
             {'note': comfort, 'seconds': 6 + day, 'tolerance': 35}),
        ]
    if area == 'Vibrato':
        return [
            ('exercise', 'Vibrato pulses', ex or "Sing a comfortable 'ah' and gently pulse the pitch up and down "
             "four times per second, then five, then six. Let it become a free, even shimmer.", {}),
            ('tuner', 'Straight tone, then release', 'Hold a straight tone for four seconds, then let vibrato bloom.',
             {'note': comfort, 'seconds': 8, 'tolerance': 45, 'mode': 'vibrato'}),
        ]
    if area == 'Resonance':
        return [
            ('warmup', 'Bright "nay" scales', 'Feel the buzz forward in your face as you sing.', {'routine': 'nay_resonance'}),
            ('exercise', 'Resonance exercise', ex or "Hum on 'mm' until your lips tingle, then open to 'mah' "
             "keeping that forward buzz.", {}),
        ]
    if area == 'Dynamics':
        return [
            ('tuner', 'Messa di voce', 'Start soft, swell to loud, return to soft, all on one steady pitch.',
             {'note': comfort, 'seconds': 8 + day // 2, 'tolerance': 30, 'mode': 'messa'}),
            ('exercise', 'Shape a phrase', ex or 'Sing one line of your song three times: soft, medium, strong. '
             'Then sing it once with a swell toward the most important word.', {}),
        ]
    # Passaggio
    return [
        ('warmup', 'Sirens through the break', 'Glide smoothly from low to high and back on a lip trill or "ng".',
         {'routine': 'siren'}),
        ('exercise', 'Register bridging', ex or "Sing 'nay' on a 1-3-5-3-1 pattern, moving up by half steps "
         "through your passaggio. Keep it light as you go up.", {}),
    ]


def create_plan(conn, user_id, session_id):
    """Deactivate any current plan and build a new 7-day plan from `session_id`."""
    met = conn.execute("SELECT * FROM session_metrics WHERE session_id = ?", (session_id,)).fetchone()
    if not met:
        return None
    met = dict(met)
    tips = [dict(t) for t in conn.execute(
        "SELECT category, severity, exercise FROM session_tips WHERE session_id = ?", (session_id,))]
    series = loads((conn.execute("SELECT data FROM session_series WHERE session_id = ?", (session_id,)).fetchone()
                    or {'data': None})['data'], {}) or {}

    comfort = comfort_note(series) or \
        (int(round(librosa.hz_to_midi(met['f0_mean_hz']))) if met.get('f0_mean_hz') else 60)
    trouble = [m for m in (note_to_midi(p['name']) for p in series.get('problem_notes', [])) if m]
    trouble = list(dict.fromkeys(trouble))[:5] or [comfort - 2, comfort, comfort + 2, comfort + 4]

    weakest = _weakest_areas(met)
    focus, second = weakest[0], weakest[1] if len(weakest) > 1 else weakest[0]

    conn.execute("UPDATE practice_plans SET active = 0 WHERE user_id = ?", (user_id,))
    summary = (f"This week's focus is {AREAS[focus][1]}, with some work on {AREAS[second][1]}. "
               "About 15 minutes a day is plenty. Consistency beats long sessions.")
    plan_id = conn.execute(
        "INSERT INTO practice_plans (user_id, source_session_id, focus, summary) VALUES (?, ?, ?, ?)",
        (user_id, session_id, focus, summary)).lastrowid

    rows = []
    for day in range(1, 8):
        items = [('warmup', 'Warm up', 'Five minutes to wake up the voice gently.',
                  {'routine': WARMUP_FOR_AREA[focus] if day % 2 else 'lip_trill'})]
        items += _focus_items(focus, day, comfort, trouble, tips)
        if day in (2, 4, 6):
            items.append(_focus_items(second, day, comfort, trouble, tips)[0])
        if day == 5 or (day == 4 and focus == 'Passaggio'):
            items.append(('range', 'Check your range', 'Measure your lowest and highest notes to track growth.', {}))
        if day in (3, 7):
            items.append(('record', 'Record a new session' if day == 7 else 'Quick check-in recording',
                          'Sing the same song as last time and compare the results.', {}))
        for pos, (kind, title, detail, target) in enumerate(items):
            rows.append((plan_id, day, pos, kind, title, detail, dumps(target)))
    conn.executemany("""
        INSERT INTO plan_items (plan_id, day, position, kind, title, detail, target) VALUES (?, ?, ?, ?, ?, ?, ?)
    """, rows)
    return plan_id


def plan_payload(conn, plan_row):
    items = conn.execute("SELECT * FROM plan_items WHERE plan_id = ? ORDER BY day, position",
                         (plan_row['id'],)).fetchall()
    return {
        'id': plan_row['id'], 'created_at': plan_row['created_at'], 'focus': plan_row['focus'],
        'focus_label': AREAS.get(plan_row['focus'], ('', plan_row['focus']))[1],
        'summary': plan_row['summary'], 'source_session_id': plan_row['source_session_id'],
        'items': [{'id': i['id'], 'day': i['day'], 'kind': i['kind'], 'title': i['title'], 'detail': i['detail'],
                   'target': loads(i['target'], {}), 'done': i['done_at'] is not None} for i in items],
    }
