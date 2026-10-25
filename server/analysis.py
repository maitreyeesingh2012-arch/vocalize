"""
Runs Vocalize analyses in background threads and stores the results.

Analysis takes 10–90 s (longer with a reference song), which is too long to hold a
mobile HTTP request open, so /api/analyze returns a job id and clients poll
/api/jobs/<id> for progress. Jobs live in memory: run the server as a single
process (waitress / threaded Flask). Swap in a real queue (RQ, Celery) to scale out.
"""
import functools
import logging
import os
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import librosa
import numpy as np
import soundfile as sf
from rich.console import Console

import vocal_analyzer as va
from .db import dumps, get_db, loads
from . import plans
from .learned import learned_score

log = logging.getLogger(__name__)

ANALYSIS_SR = 44100
AUDIO_SR = 22050
MIN_DURATION_S = 3.0
OPTIMAL_THRESHOLD = 75.0

# The analyzer prints rich panels and spinners meant for the CLI. Silence them in the server.
_quiet_console = Console(quiet=True)
va.console = _quiet_console
va.Progress = functools.partial(va.Progress, console=_quiet_console)

AREA_COLUMNS = {   # analyzer area name → session_metrics column
    'Pitch': 'intonation_score', 'Breath': 'breath_score', 'Vibrato': 'vibrato_score',
    'Resonance': 'resonance_score', 'Dynamics': 'dynamics_score', 'Stability': 'stability_score',
    'Passaggio': 'passaggio_score',
}

_executor = None
_jobs = {}
_jobs_lock = threading.Lock()


def init_executor(workers):
    global _executor
    _executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='vocalize-analysis')


# ─────────────────────────────────────────────────────────────
# Time zones: the server stores UTC; streaks and "today" use the singer's local day.
# Clients send X-Timezone-Offset = JS Date#getTimezoneOffset() (minutes, UTC − local).
# ─────────────────────────────────────────────────────────────

def parse_tz_offset(value):
    try:
        minutes = int(value)
        return minutes if -900 <= minutes <= 900 else 0
    except (TypeError, ValueError):
        return 0


def to_local(ts_utc, tz_offset_min):
    dt = datetime.strptime(str(ts_utc)[:19], "%Y-%m-%d %H:%M:%S")
    return dt - timedelta(minutes=tz_offset_min)


def local_today(tz_offset_min):
    return (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=tz_offset_min)).date()


# ─────────────────────────────────────────────────────────────
# Personalisation: rebuild the analyzer's UserAccount from the database
# ─────────────────────────────────────────────────────────────

def build_account(conn, user_id, tz_offset_min=0, exclude_session_id=None):
    u = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    acc = va.UserAccount()
    acc.username = '' if u['is_guest'] else u['email']   # guests are greeted "Hi!", not by their internal ID
    acc.display_name = '' if u['is_guest'] else u['display_name']
    acc.years_singing = u['years_singing'] or acc.years_singing
    acc.takes_lessons = bool(u['takes_lessons'])
    acc.self_assessed_level = u['self_assessed_level'] or acc.self_assessed_level
    acc.practice_days_pw = u['practice_days_pw'] if u['practice_days_pw'] is not None else acc.practice_days_pw
    acc.genres = loads(u['genres'], [])
    acc.goals = loads(u['goals'], [])
    acc.known_issues = loads(u['known_issues'], [])

    # Replay stored sessions so streaks, per-area progress and recurring issues are right.
    rows = conn.execute(f"""
        SELECT s.timestamp, s.issues, {', '.join('m.' + c for c in AREA_COLUMNS.values())}
        FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id
        WHERE s.user_id = ? AND s.id IS NOT ? ORDER BY s.timestamp, s.id
    """, (user_id, exclude_session_id)).fetchall()
    for r in rows:
        scores = {area: r[col] for area, col in AREA_COLUMNS.items() if r[col] is not None}
        when = to_local(r['timestamp'], tz_offset_min).strftime("%Y-%m-%d %H:%M")
        va.apply_session_to_account(acc, scores, loads(r['issues'], []), when=when)
    return acc


# ─────────────────────────────────────────────────────────────
# Jobs
# ─────────────────────────────────────────────────────────────

def submit(app, user_id, audio_path, ref_path, label, ref_name, tz_offset_min, session_id=None):
    """Analyse a take in the background. With session_id, re-score that saved session in place."""
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _purge_old_jobs()
        _jobs[job_id] = {'id': job_id, 'user_id': user_id, 'status': 'queued', 'stage': 'Waiting to start…',
                         'session_id': None, 'error': None, 'created': time.time()}
    _executor.submit(_run_job, app, job_id, user_id, audio_path, ref_path, label, ref_name, tz_offset_min, session_id)
    return job_id


def get_job(job_id, user_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job['user_id'] != user_id:
            return None
        return {k: v for k, v in job.items() if k != 'user_id'}


def _update(job_id, **fields):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(fields)


def _purge_old_jobs():
    cutoff = time.time() - 3600
    for jid in [j for j, v in _jobs.items() if v['created'] < cutoff]:
        del _jobs[jid]


class UserFacingError(Exception):
    """An analysis failure whose message is safe and useful to show the singer."""


def readable_audio(path, what):
    """
    Return a path libsndfile can read. M4A/MP4 (AAC, "mp4a") and other formats it doesn't
    know are converted to WAV with ffmpeg; the caller deletes the returned file.
    """
    try:
        sf.info(path)
        return path
    except Exception:
        pass
    out = os.path.splitext(path)[0] + '.converted.wav'
    try:
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-ac', '1', out],
                       check=True, capture_output=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        raise UserFacingError(f'Could not read {what}. Try MP3, M4A, WAV, FLAC or OGG.')
    return out


def _run_job(app, job_id, user_id, audio_path, ref_path, label, ref_name, tz_offset_min, rescore_id=None):
    temp = [audio_path, ref_path]
    with app.app_context():
        try:
            _update(job_id, status='running', stage='Loading your recording…')
            audio_path = readable_audio(audio_path, 'that audio file')
            ref_path = ref_path and readable_audio(ref_path, 'the reference song file')
            temp += [audio_path, ref_path]
            session_id = analyze_and_store(app, user_id, audio_path, ref_path, label, ref_name, tz_offset_min,
                                           on_stage=lambda s: _update(job_id, stage=s), rescore_id=rescore_id)
            _update(job_id, status='done', stage='Done', session_id=session_id)
        except UserFacingError as e:
            _update(job_id, status='error', error=str(e))
        except Exception as e:  # noqa: BLE001 - report, don't crash the worker
            log.exception("Analysis failed")
            _update(job_id, status='error', error=f'Analysis failed: {e}')
        finally:
            for p in set(temp):
                if p and os.path.exists(p):
                    os.remove(p)


def level_for(score):
    return "Optimal" if score >= OPTIMAL_THRESHOLD else "Developing"


def analyze_and_store(app, user_id, audio_path, ref_path, label, ref_name, tz_offset_min, on_stage=None,
                      rescore_id=None):
    """Analyse a take and save it as a new session, or with rescore_id overwrite that session's scores."""
    try:
        y, sr = librosa.load(audio_path, sr=ANALYSIS_SR, mono=True)
    except Exception:
        raise UserFacingError('Could not read that audio file. Try MP3, M4A, WAV, FLAC or OGG.')
    if len(y) / sr < MIN_DURATION_S:
        raise UserFacingError(f'Recording too short. Please sing for at least {MIN_DURATION_S:.0f} seconds.')
    if ref_path:
        try:
            librosa.get_duration(path=ref_path)
        except Exception:
            raise UserFacingError('Could not read the reference song file. Try MP3, M4A, WAV or FLAC.')

    # Check it's usable singing first (a few seconds), so instrumental, spoken or noise-buried
    # uploads are turned away at once instead of after the full analysis.
    if on_stage:
        on_stage('Checking it sounds like singing…')
    learned = learned_score(y, sr) or {}
    if learned.get('stage_failed') == 'detection':
        raise UserFacingError('No singing detected. This sounds like instrumental music, speech or noise. '
                              'Please upload a recording of your singing.')
    if learned.get('stage_failed') == 'usability':
        raise UserFacingError('The singing is too hard to hear over the background noise to score fairly. '
                              'Try again somewhere quieter.')

    with get_db() as conn:
        account = build_account(conn, user_id, tz_offset_min, exclude_session_id=rescore_id)

    engine = va.Vocalize(sr=ANALYSIS_SR, ref_cache_dir=app.config['REF_CACHE_DIR'])
    try:
        m, tips, extra = engine.analyze(y, sr_in=sr, reference_path=ref_path, account=account, on_stage=on_stage)
    except ValueError as e:     # silent input
        raise UserFacingError(str(e))

    if on_stage:
        on_stage('Saving your report…')
    series = va.export_session_series(m, extra, sr=ANALYSIS_SR)
    audio_name = None if rescore_id else _save_audio(app, extra['y'], ANALYSIS_SR)
    issues = va.root_cause_issues(extra)
    has_ref = m.ref_melody_accuracy >= 0
    # The learned quality head has not generalized to unseen singers. Keep it
    # diagnostic; the technique score also retains any reference comparison.
    overall = float(m.overall_score)
    source = 'technique-v1'

    with get_db() as conn:
        if rescore_id:
            return _rescore_session(conn, rescore_id, m, tips, extra, series, issues, has_ref, overall, learned, source)
        cur = conn.execute("""
            INSERT INTO sessions (user_id, label, voice_type, reference_song, duration_s, overall_score,
                                  audio_filename, issues, has_reference, learned_score, singing_probability,
                                  rule_overall_score, score_source, usable_probability)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, label, extra['voice_type'], ref_name, float(len(extra['y']) / ANALYSIS_SR),
              overall, audio_name, dumps(issues), int(has_ref),
              learned.get('learned_score'), learned.get('singing_probability'), float(m.overall_score), source,
              learned.get('usable_probability')))
        session_id = cur.lastrowid

        _insert_details(conn, session_id, m, tips, extra, series, has_ref)
        conn.execute("UPDATE users SET voice_type = ? WHERE id = ?", (extra['voice_type'], user_id))

        # Keep a practice plan going: start one from this session if the singer has none.
        if not conn.execute("SELECT 1 FROM practice_plans WHERE user_id = ? AND active = 1", (user_id,)).fetchone():
            plans.create_plan(conn, user_id, session_id)
    return session_id


def _insert_details(conn, session_id, m, tips, extra, series, has_ref):
    conn.execute("""
        INSERT INTO session_metrics (session_id, f0_mean_hz, f0_range_semitones, vibrato_present,
            vibrato_rate_hz, vibrato_extent_st, avg_phrase_s, register_breaks, dynamic_range_db,
            intonation_level, breath_level, resonance_level, intonation_score, stability_score,
            vibrato_score, breath_score, resonance_score, dynamics_score, passaggio_score, pitch_bias,
            ref_melody_accuracy, ref_rhythm_accuracy, ref_pitch_dev_cents, ref_missed_pct, ref_early_late_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id, float(m.f0_mean), float(m.f0_range_semitones), bool(m.vibrato_present),
        float(m.vibrato_rate_hz), float(m.vibrato_extent_semitones), float(m.avg_phrase_length_s),
        int(m.register_breaks), float(m.dynamic_range_db),
        level_for(m.intonation_score), level_for(m.breath_support_score), level_for(m.resonance_score),
        float(m.intonation_score), float(m.pitch_stability_score), float(m.vibrato_score),
        float(m.breath_support_score), float(m.resonance_score), float(m.dynamic_control_score),
        float(m.smoothness_through_break), extra['deep'].get('flat_sharp_bias'),
        *( (float(m.ref_melody_accuracy), float(m.ref_rhythm_accuracy), float(m.ref_pitch_deviation_cents),
            float(m.ref_missed_notes_pct), float(m.ref_early_late_ms)) if has_ref else (None,) * 5 ),
    ))
    conn.executemany("""
        INSERT INTO session_tips (session_id, category, severity, headline, detail, exercise)
        VALUES (?, ?, ?, ?, ?, ?)
    """, [(session_id, t.category, t.severity, t.headline, t.detail, t.exercise) for t in tips])
    conn.execute("INSERT INTO session_series (session_id, data) VALUES (?, ?)", (session_id, dumps(series)))


def _rescore_session(conn, session_id, m, tips, extra, series, issues, has_ref, overall, learned, source):
    """Overwrite a saved session's scores, keeping its label, date, audio and reference results."""
    old = conn.execute("SELECT has_reference FROM sessions WHERE id = ?", (session_id,)).fetchone()
    old_ref = conn.execute("""SELECT ref_melody_accuracy, ref_rhythm_accuracy, ref_pitch_dev_cents, ref_missed_pct,
                                     ref_early_late_ms FROM session_metrics WHERE session_id = ?""", (session_id,)).fetchone()
    conn.execute("""
        UPDATE sessions SET voice_type = ?, overall_score = ?, issues = ?, learned_score = ?,
                            singing_probability = ?, rule_overall_score = ?, score_source = ?,
                            usable_probability = ?
        WHERE id = ?
    """, (extra['voice_type'], overall, dumps(issues), learned.get('learned_score'),
          learned.get('singing_probability'), float(m.overall_score), source, learned.get('usable_probability'),
          session_id))
    for table in ('session_metrics', 'session_tips', 'session_series'):
        conn.execute(f"DELETE FROM {table} WHERE session_id = ?", (session_id,))
    _insert_details(conn, session_id, m, tips, extra, series, has_ref)
    # The reference song isn't kept, so a re-score can't redo the comparison: keep the old results.
    if old['has_reference'] and old_ref and not has_ref:
        conn.execute("""UPDATE session_metrics SET ref_melody_accuracy = ?, ref_rhythm_accuracy = ?,
                        ref_pitch_dev_cents = ?, ref_missed_pct = ?, ref_early_late_ms = ? WHERE session_id = ?""",
                     (*tuple(old_ref), session_id))
    return session_id


def _save_audio(app, y, sr):
    """Store the cleaned take (the timeline all charts use) as a compact mono MP3."""
    os.makedirs(app.config['AUDIO_DIR'], exist_ok=True)
    y_small = librosa.resample(y, orig_sr=sr, target_sr=AUDIO_SR) if sr != AUDIO_SR else y
    peak = float(np.max(np.abs(y_small))) or 1.0
    y_small = (y_small / peak * 0.9).astype(np.float32)
    name = f"{uuid.uuid4().hex}.mp3"
    try:
        sf.write(os.path.join(app.config['AUDIO_DIR'], name), y_small, AUDIO_SR, format='MP3')
    except Exception:
        name = name.replace('.mp3', '.wav')
        sf.write(os.path.join(app.config['AUDIO_DIR'], name), y_small, AUDIO_SR, subtype='PCM_16')
    return name
