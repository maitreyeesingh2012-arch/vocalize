"""
Do Vocalize's scores agree with human ratings?

    python scripts/evaluate_ratings.py acapella     # ccmusic-database/acapella: expert ratings (1–10) on 9 aspects
    python scripts/evaluate_ratings.py singmos      # SingMOS-Pro: listener MOS on real (ground-truth) singing

Runs the CURRENT analyzer and the PREVIOUS one (data/results/va_old.py, from git) on every
clip and reports Spearman correlations with the human scores, plus an Excel file of all results.
"""
import csv
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

from scipy.stats import spearmanr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from batch_analyze import run_vocalize  # noqa: E402

DATA = os.path.join(ROOT, 'data', 'datasets')
RESULTS = os.path.join(ROOT, 'data', 'results')
SCORES = ['overall_score', 'pitch_accuracy', 'pitch_stability', 'vibrato_score', 'breath_support',
          'resonance_tone', 'dynamic_control', 'register_changes']

# Which Vocalize score should track which human rating
PAIRS = {
    'acapella': [('overall_score', 'overall_performance'), ('pitch_accuracy', 'pitch'),
                 ('pitch_stability', 'pitch'), ('vibrato_score', 'vibrato'),
                 ('breath_support', 'breath_control'), ('dynamic_control', 'dynamic'),
                 ('resonance_tone', 'timbre')],
    'singmos': [(s, 'mos') for s in SCORES],
}


def clips(name):
    if name == 'acapella':
        folder = os.path.join(DATA, 'acapella', 'wav')
        with open(os.path.join(folder, 'labels.csv'), encoding='utf-8') as f:
            for r in csv.DictReader(f):
                yield os.path.join(folder, r['file']), {k: (float(v) if k not in ('file', 'song') else v) for k, v in r.items()}
    else:
        base = os.path.join(DATA, 'singmos_pro')
        with open(os.path.join(base, 'info', 'sys_info.json'), encoding='utf-8') as f:
            sys_info = json.load(f)
        with open(os.path.join(base, 'info', 'score.json'), encoding='utf-8') as f:
            scores = json.load(f)
        real = {s for s, v in sys_info.items() if v.get('type') == 'gt'}   # real recorded singing, not synthesis
        for utt, v in scores['utterance'].items():
            if v['sys_id'] in real:
                path = os.path.join(base, v['wav'])
                if os.path.exists(path):
                    yield path, {'file': utt, 'system': v['sys_id'], 'corpus': sys_info[v['sys_id']]['dataset'],
                                 'mos': float(v['score']['mos'])}


def both(args):
    path, labels = args
    return {**labels,
            **{f'new_{k}': v for k, v in run_vocalize(path).items()},
            **{f'old_{k}': v for k, v in run_vocalize(path, module='va_old').items()}}


def main():
    name = sys.argv[1]
    items = list(clips(name))
    print(f'{name}: {len(items)} clips', flush=True)
    rows = []
    with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) - 2)) as pool:
        for i, r in enumerate(pool.map(both, items), 1):
            rows.append(r)
            if i % 10 == 0:
                print(f'  {i}/{len(items)}', flush=True)

    lines = [f'# Vocalize vs human ratings: {name} ({len(rows)} clips)', '',
             'Spearman correlation (−1…+1; 0 = no relationship, ~0.3 weak, ~0.5 moderate, ≥0.7 strong).', '',
             '| Vocalize score | Human rating | Before | After | n |', '|---|---|---|---|---|']
    for ours, theirs in PAIRS[name]:
        out = []
        for ver in ('old', 'new'):
            ok = [r for r in rows if not r.get(f'{ver}_error') and isinstance(r.get(f'{ver}_{ours}'), (int, float))]
            rho, p = spearmanr([r[f'{ver}_{ours}'] for r in ok], [r[theirs] for r in ok]) if len(ok) > 3 else (float('nan'), 1)
            out.append(f'{rho:+.2f}{"*" if p < 0.05 else ""}')
        lines.append(f'| {ours} | {theirs} | {out[0]} | {out[1]} | {len(ok)} |')
    lines += ['', '\\* statistically significant (p < 0.05).']
    report = '\n'.join(lines)
    print(report)
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, f'eval_{name}.md'), 'w', encoding='utf-8') as f:
        f.write(report + '\n')

    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = 'Results'
    cols = list(dict.fromkeys(k for r in rows for k in r))
    ws.append(cols)
    for r in rows:
        ws.append([r.get(c) if not isinstance(r.get(c), (list, dict)) else str(r.get(c)) for c in cols])
    wb.create_sheet('Correlations').append(['See eval_' + name + '.md'])
    for line in lines:
        wb['Correlations'].append([line])
    wb.save(os.path.join(RESULTS, f'eval_{name}.xlsx'))


if __name__ == '__main__':
    main()
