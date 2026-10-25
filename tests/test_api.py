import numpy as np

from conftest import sing, wait_for_job, wav_bytes


def register(http, email='singer@example.com', password='password123', **extra):
    return http.post('/api/register', json={'email': email, 'password': password, 'age_confirmed': True, **extra})


# ── Auth ──────────────────────────────────────────────────────

def test_register_login_logout(client):
    r = register(client)
    assert r.status_code == 200 and r.get_json()['display_name'] == 'Singer'
    assert client.get('/api/me').get_json()['authenticated']
    client.post('/api/logout')
    assert not client.get('/api/me').get_json()['authenticated']
    assert client.post('/api/login', json={'email': 'singer@example.com', 'password': 'wrong'}).status_code == 401
    assert client.post('/api/login', json={'email': 'singer@example.com', 'password': 'password123'}).status_code == 200


def test_validation(client):
    assert register(client, email='nope').status_code == 400
    assert register(client, password='short').status_code == 400
    register(client)
    client.post('/api/logout')
    assert register(client).status_code == 400          # duplicate


def test_new_accounts_must_confirm_age(client):
    assert client.post('/api/guest', json={}).status_code == 400
    assert client.post('/api/register', json={'email': 'a@b.co', 'password': 'password123'}).status_code == 400
    assert client.post('/api/guest', json={'age_confirmed': True}).status_code == 200


def test_guest_then_claim(client):
    g = client.post('/api/guest', json={'age_confirmed': True}).get_json()
    assert g['is_guest'] and g['email'] is None
    r = client.post('/api/claim', json={'email': 'g@example.com', 'password': 'password123'}).get_json()
    assert r['success'] and not r['is_guest']
    assert client.post('/api/claim', json={'email': 'x@example.com', 'password': 'password123'}).status_code == 400


def test_bearer_token_for_apps(client, app):
    r = register(client, client='app').get_json()
    token = r['token']
    anon = app.test_client()
    assert not anon.get('/api/me').get_json()['authenticated']
    me = anon.get('/api/me', headers={'Authorization': f'Bearer {token}'}).get_json()
    assert me['authenticated'] and me['email'] == 'singer@example.com'
    anon.post('/api/logout', headers={'Authorization': f'Bearer {token}'})
    assert not anon.get('/api/me', headers={'Authorization': f'Bearer {token}'}).get_json()['authenticated']


def test_cors_preflight_for_native_origin(client):
    r = client.options('/api/login', headers={'Origin': 'capacitor://localhost',
                                               'Access-Control-Request-Method': 'POST'})
    assert r.headers.get('Access-Control-Allow-Origin') == 'capacitor://localhost'
    r = client.options('/api/login', headers={'Origin': 'https://evil.example'})
    assert 'Access-Control-Allow-Origin' not in r.headers


def test_profile_roundtrip(client):
    register(client)
    body = client.get('/api/profile').get_json()
    assert 'Pop' in body['choices']['genres']
    r = client.put('/api/profile', json={'genres': ['Pop', 'Bogus'], 'goals': ['Develop vibrato'],
                                         'years_singing': '1 to 3 years', 'practice_days_pw': 3,
                                         'takes_lessons': True, 'onboarded': True}).get_json()
    assert r['profile']['genres'] == ['Pop'] and r['user']['onboarded']


# ── Analysis, sessions, sharing, plan, progress ───────────────

def test_full_session_flow(client, app):
    register(client)
    r = client.post('/api/analyze', data={'audio': (wav_bytes(sing()), 'take.wav'), 'label': 'Scale'},
                    content_type='multipart/form-data')
    assert r.status_code == 202
    body = wait_for_job(client, r.get_json()['job_id'])
    assert body['job']['status'] == 'done', body['job']
    p = body['payload']
    sid = p['session']['id']
    assert 0 < p['session']['overall_score'] <= 100
    assert p['session']['has_audio']
    s = p['series']
    assert s['notes'] and s['phrases'] and s['pitch']['midi'] and s['loudness']['db']
    assert len(p['tips']) > 3

    audio = client.get(f'/api/session/{sid}/audio')
    assert audio.status_code == 200 and audio.mimetype in ('audio/mpeg', 'audio/wav')
    ranged = client.get(f'/api/session/{sid}/audio', headers={'Range': 'bytes=0-99'})
    assert ranged.status_code == 206

    # A plan is created automatically from the first session
    plan = client.get('/api/plan').get_json()['plan']
    assert plan and len({i['day'] for i in plan['items']}) == 7
    item = plan['items'][0]
    plan = client.post(f"/api/plan/items/{item['id']}", json={'done': True}).get_json()['plan']
    assert plan['items'][0]['done']

    prog = client.get('/api/progress').get_json()
    assert prog['totals']['sessions'] == 1 and prog['streak']['current'] == 1

    # Share with a teacher, then revoke
    share = client.post(f'/api/session/{sid}/share', json={'include_audio': True}).get_json()
    anon = app.test_client()
    pub = anon.get(f"/api/public/share/{share['token']}").get_json()
    assert pub['success'] and pub['payload']['series'] and 'email' not in str(pub)
    assert anon.get(f"/api/public/share/{share['token']}/audio").status_code == 200
    assert anon.get(f"/r/{share['token']}").status_code == 200
    client.delete(f"/api/share/{share['token']}")
    assert anon.get(f"/api/public/share/{share['token']}").status_code == 404

    # Other users can't see it
    other = app.test_client()
    register(other, email='other@example.com')
    assert other.get(f'/api/session/{sid}').status_code == 404
    assert other.get(f'/api/session/{sid}/audio').status_code == 404


def test_reference_song_comparison(client, tmp_path):
    register(client)
    sr = 44100
    t = np.arange(int(sr * 6)) / sr
    pad = (0.15 * sum(np.sin(2 * np.pi * f * t) for f in (130.8, 164.8, 196.0))).astype(np.float32)
    song = np.concatenate([pad, sing(tempo=1.1, transpose=-12), pad])
    r = client.post('/api/analyze', data={'audio': (wav_bytes(sing()), 'take.wav'),
                                          'reference': (wav_bytes(song), 'My Song.wav')},
                    content_type='multipart/form-data')
    body = wait_for_job(client, r.get_json()['job_id'])
    assert body['job']['status'] == 'done', body['job']
    ref = body['payload']['reference']
    assert ref['melody_accuracy'] > 80
    assert body['payload']['session']['reference_song'] == 'My Song'
    s = body['payload']['series']['reference']
    assert abs(s['ref_start_s'] - 6.0) < 1.0 and s['octave_shift'] == 1


def test_reference_alignment_tolerates_a_consistently_sharp_singer(tmp_path):
    """Regression: a singer 30¢ sharp throughout must not make the alignment drift behind."""
    import soundfile as sf
    import vocal_analyzer as va
    from conftest import SR
    t = np.arange(int(SR * 6)) / SR
    pad = (0.12 * sum(np.sin(2 * np.pi * f * t) for f in (130.8, 164.8, 196.0))).astype(np.float32)
    song = np.concatenate([pad, sing(tempo=1.1, transpose=-12), pad])
    path = tmp_path / 'song.wav'
    sf.write(path, song, SR)
    sharp_take = sing(transpose=0.3)
    r = va.ReferenceSongAnalyzer(sr=SR).analyze(sharp_take, str(path), sr_vocal=SR)
    assert abs(r['ref_start_s'] - 6.0) < 0.5
    assert 20 < r['pitch_deviation_cents'] < 45          # ≈ the 30¢ the singer is off, nothing more
    assert not r['worst_moments']


def test_m4a_and_mp4_uploads_are_analysed(client, tmp_path):
    """Phone recordings (AAC in .m4a/.mp4, "mp4a") are converted with ffmpeg and analysed."""
    import shutil
    import subprocess
    import pytest
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg not installed')
    register(client)
    wav = tmp_path / 'take.wav'
    wav.write_bytes(wav_bytes(sing()).read())
    for ext in ('m4a', 'mp4'):
        out = tmp_path / f'take.{ext}'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(wav), '-c:a', 'aac', str(out)], check=True)
        r = client.post('/api/analyze', data={'audio': (open(out, 'rb'), out.name)}, content_type='multipart/form-data')
        body = wait_for_job(client, r.get_json()['job_id'])
        assert body['job']['status'] == 'done', (ext, body['job'])


def test_rejects_short_and_silent_audio(client):
    register(client)
    r = client.post('/api/analyze', data={'audio': (wav_bytes(np.zeros(44100, dtype=np.float32)), 'a.wav')},
                    content_type='multipart/form-data')
    body = wait_for_job(client, r.get_json()['job_id'])
    assert body['job']['status'] == 'error' and 'short' in body['job']['error']


def test_practice_results_and_summary(client):
    register(client)
    client.post('/api/practice/results', json={'kind': 'range', 'score': 24, 'data': {'low': 48, 'high': 72}})
    client.post('/api/practice/results', json={'kind': 'breath', 'score': 21.5, 'data': {'steadiness': 80}})
    client.post('/api/practice/results', json={'kind': 'pitch_match', 'score': 50, 'data': {'attempts': [
        {'target': 60, 'cents': 10, 'hit': True}, {'target': 64, 'cents': 70, 'hit': False},
        {'target': 64, 'cents': 60, 'hit': False}]}})
    assert client.post('/api/practice/results', json={'kind': 'bogus'}).status_code == 400
    s = client.get('/api/practice/summary').get_json()
    assert s['range']['low'] == 48 and s['best_breath_s'] == 21.5
    assert 64 in s['trouble_notes']
    assert client.get('/api/progress').get_json()['totals']['practice'] == 3


def test_delete_account_removes_everything(client, app):
    register(client)
    client.post('/api/practice/results', json={'kind': 'breath', 'score': 10})
    assert client.delete('/api/account', json={}).status_code == 400
    assert client.delete('/api/account', json={'confirm': 'DELETE'}).get_json()['success']
    assert not client.get('/api/me').get_json()['authenticated']
    assert client.post('/api/login', json={'email': 'singer@example.com', 'password': 'password123'}).status_code == 401
