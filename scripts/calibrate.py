"""
Calibrate Vocalize's scores on the VocalSet dataset of professional singers.

    python scripts/calibrate.py extract     # measure raw features (cached to data/results/calibration_features.csv)
    python scripts/calibrate.py report      # distributions, chosen thresholds, held-out check

Thresholds are fitted on VocalSet's *train* singers only and checked on its *test* singers.
Dataset: Wilkins et al., ISMIR 2018, doi:10.5281/zenodo.1442513 (CC BY 4.0).
"""
import csv
import os
import statistics as st
import sys
import warnings
from concurrent.futures import ProcessPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from batch_analyze import DATASET, describe  # noqa: E402

OUT = os.path.join(ROOT, 'data', 'results', 'calibration_features.csv')
SPLIT = os.path.join(ROOT, 'data', 'datasets', 'vocalset')
SR = 44100
FIELDS = ['file', 'singer', 'category', 'technique', 'split', 'voiced_fraction', 'notes',
          'old_intonation', 'old_stability', 'old_breath',
          'rel_intonation_dev', 'abs_intonation_dev', 'drift_cents', 'phrase_std_db']


def features(path):
    warnings.filterwarnings('ignore')
    sys.path.insert(0, ROOT)
    import librosa
    import numpy as np
    import vocal_analyzer as va
    from rich.console import Console
    va.console = Console(quiet=True)

    row = describe(path)
    y, sr = librosa.load(path, sr=SR, mono=True)
    y, _ = va.AudioPreprocessor().process(y, sr, target_sr=SR)
    pa = va.PitchAnalyzer(sr=SR, fmin=65, fmax=1400)
    f0, voiced, times = pa.extract(y)
    notes = pa.extract_notes(f0, times, y)
    breath = va.BreathAnalyzer().analyze(y, SR, f0)
    fps = SR / pa.hop_length
    abs_notes = [n for n in notes if n['dur_s'] >= 0.1]
    row.update({
        'voiced_fraction': round(float(np.mean(voiced)), 3),
        'notes': len(notes),
        'old_intonation': round(pa.intonation_score(f0, notes), 1),
        'old_stability': round(pa.pitch_stability_score(f0, notes), 1),
        'old_breath': round(breath['support_score'], 1),
        'rel_intonation_dev': va.relative_intonation_dev(notes),
        'abs_intonation_dev': float(np.average([abs(n['cents_off']) for n in abs_notes],
                                               weights=[n['dur_s'] for n in abs_notes])) if abs_notes else None,
        'drift_cents': va.note_drift_cents(f0, notes, fps),
        'phrase_std_db': va.phrase_level_std_db(y, SR, breath['phrases']),
    })
    return row


def split_of(singer):
    with open(os.path.join(SPLIT, 'test_singers_technique.txt')) as f:
        return 'test' if singer in f.read().split() else 'train'


def extract():
    files = []
    for dirpath, _, names in os.walk(DATASET):
        rel = os.path.relpath(dirpath, DATASET).split(os.sep)
        if len(rel) >= 2 and rel[1] in ('excerpts', 'long_tones'):
            files += [os.path.join(dirpath, n) for n in names if n.endswith('.wav')]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    print(f'{len(files)} recordings')
    with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) - 2)) as pool, open(OUT, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction='ignore')
        w.writeheader()
        for i, row in enumerate(pool.map(features, sorted(files), chunksize=4), 1):
            row['split'] = split_of(row['singer'])
            w.writerow({k: (round(v, 2) if isinstance(v, float) else v) for k, v in row.items()})
            if i % 50 == 0:
                print(f'  {i}/{len(files)}', flush=True)
    print('saved', OUT)


def load():
    with open(OUT, newline='') as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for k in FIELDS[5:]:
            r[k] = float(r[k]) if r[k] not in ('', 'None') else None
    return rows


def pct(vals, q):
    vals = sorted(v for v in vals if v is not None)
    return vals[min(len(vals) - 1, int(q * len(vals)))] if vals else None


def describe_dist(label, vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return f'{label:34} (none)'
    return (f'{label:34} n={len(vals):3}  p10={pct(vals, .1):6.1f}  median={st.median(vals):6.1f}  '
            f'p90={pct(vals, .9):6.1f}')


def report():
    rows = load()
    groups = {
        'excerpts sung (vibrato/straight)': lambda r: r['category'] == 'excerpts' and r['technique'] != 'spoken',
        'excerpts SPOKEN': lambda r: r['category'] == 'excerpts' and r['technique'] == 'spoken',
        'long tones straight': lambda r: r['category'] == 'long_tones' and r['technique'] == 'straight',
        'long tones vibrato': lambda r: r['category'] == 'long_tones' and r['technique'] == 'vibrato',
        'long tones forte/piano': lambda r: r['category'] == 'long_tones' and 'forte' in r['technique'] + 'piano' and r['technique'] in ('forte', 'pp', 'messa_di_voce', 'crescendo', 'decrescendo'),
        'long tones breathy': lambda r: r['category'] == 'long_tones' and r['technique'] == 'breathy',
        'long tones vocal fry': lambda r: r['category'] == 'long_tones' and r['technique'] == 'vocal_fry',
    }
    print('techniques in long_tones:', sorted({r['technique'] for r in rows if r['category'] == 'long_tones'}))
    for metric in ('old_intonation', 'old_stability', 'old_breath', 'abs_intonation_dev', 'rel_intonation_dev',
                   'drift_cents', 'phrase_std_db'):
        print(f'\n== {metric}')
        for name, sel in groups.items():
            print('  ' + describe_dist(name, [r[metric] for r in rows if sel(r)]))


# Zero-score anchors: levels any listener would call clearly off (not fitted to data).
WORST = {'rel_intonation_dev': 40.0, 'drift_cents': 40.0, 'phrase_std_db': 15.0}


def fit():
    """'Full marks' = what the top quarter of TRAIN singers reach on sung song excerpts; checked on TEST singers."""
    sys.path.insert(0, ROOT)
    import vocal_analyzer as va
    rows = load()
    sung = lambda r: r['category'] == 'excerpts' and r['technique'] != 'spoken'
    train = [r for r in rows if sung(r) and r['split'] == 'train']
    best = {k: round(pct([r[k] for r in train], 0.25), 1) for k in WORST}
    print('Fitted on', len(train), 'train recordings. best =', best, 'worst =', WORST)
    for name, sel in [('TEST singers, sung songs', lambda r: sung(r) and r['split'] == 'test'),
                      ('TEST singers, long tones', lambda r: r['category'] == 'long_tones' and r['split'] == 'test'),
                      ('ALL singers, SPOKEN', lambda r: r['category'] == 'excerpts' and r['technique'] == 'spoken')]:
        g = [r for r in rows if sel(r)]
        parts = []
        for k in WORST:
            s = [va.score_between(r[k], best[k], WORST[k]) for r in g if r[k] is not None]
            parts.append(f"{k.split('_')[0]:>6}: median {st.median(s):5.1f}")
        print(f'  {name:28} n={len(g):3}  ' + '   '.join(parts))
    return best


if __name__ == '__main__':
    {'extract': extract, 'report': report, 'fit': fit}[sys.argv[1] if len(sys.argv) > 1 else 'report']()
