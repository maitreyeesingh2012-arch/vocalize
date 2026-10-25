import io
import os
import sys
import time

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SR = 44100
MELODY = [(60, 1.2), (62, 0.8), (64, 1.2), (65, 0.6), (67, 1.6), (65, 0.8), (64, 1.0), (62, 1.2), (60, 1.8)]


def sing(notes=MELODY, sr=SR, tempo=1.0, transpose=0):
    """A synthetic 'voice': harmonic tones with vibrato, short breaths between notes."""
    out = []
    for midi, dur in notes:
        dur *= tempo
        t = np.arange(int(sr * dur)) / sr
        f = 440 * 2 ** ((midi + transpose - 69) / 12) * 2 ** (0.35 * np.sin(2 * np.pi * 5.6 * t) / 12)
        ph = 2 * np.pi * np.cumsum(f) / sr
        env = np.minimum(1, t / 0.05) * np.minimum(1, (dur - t) / 0.08)
        out.append(sum((0.6 / k) * np.sin(k * ph) for k in range(1, 7)) * env)
        out.append(np.zeros(int(sr * 0.12)))
    y = np.concatenate(out)
    y = 0.3 * y / np.abs(y).max() + 0.002 * np.random.default_rng(0).standard_normal(len(y))
    return y.astype(np.float32)


def wav_bytes(y, sr=SR):
    buf = io.BytesIO()
    sf.write(buf, y, sr, format='WAV')
    buf.seek(0)
    return buf


@pytest.fixture()
def app(tmp_path):
    from server import create_app
    return create_app({
        'DB_PATH': str(tmp_path / 'test.db'),
        'DATA_DIR': str(tmp_path),
        'AUDIO_DIR': str(tmp_path / 'audio'),
        'REF_CACHE_DIR': str(tmp_path / 'ref_cache'),
        'TESTING': True,
    })


@pytest.fixture()
def client(app):
    return app.test_client()


def wait_for_job(client, job_id, timeout=240, headers=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f'/api/jobs/{job_id}', headers=headers or {}).get_json()
        if body['job']['status'] in ('done', 'error'):
            return body
        time.sleep(0.5)
    raise AssertionError('analysis job timed out')
