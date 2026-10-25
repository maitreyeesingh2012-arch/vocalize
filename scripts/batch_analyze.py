"""
Run Vocalize's full session analysis on every recording in the VocalSet dataset and
save the same metrics the app's report shows to an Excel file.

    python scripts/batch_analyze.py                         # the 139 song excerpts
    python scripts/batch_analyze.py --category all          # all 3,615 recordings (hours)
    python scripts/batch_analyze.py --category long_tones --workers 4

Results are checkpointed to a CSV next to the Excel file, so an interrupted run resumes
where it stopped.

Dataset: Wilkins et al., "VocalSet: A Singing Voice Dataset", ISMIR 2018,
doi:10.5281/zenodo.1442513 (CC BY 4.0).
"""
import argparse
import csv
import os
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET = os.path.join(ROOT, 'data', 'datasets', 'vocalset', 'FULL')
CATEGORIES = ('excerpts', 'arpeggios', 'scales', 'long_tones')
SR = 44100

COLUMNS = [
    # what the recording is
    'file', 'singer', 'gender', 'category', 'technique', 'song',
    # report headline
    'duration_s', 'voice_type', 'overall_score',
    # the seven area scores (0–100)
    'pitch_accuracy', 'pitch_stability', 'vibrato_score', 'breath_support',
    'resonance_tone', 'dynamic_control', 'register_changes',
    # measurements
    'avg_pitch_hz', 'centre_note', 'range_semitones', 'pitch_tendency',
    'vibrato_present', 'vibrato_rate_hz', 'vibrato_extent_st', 'vibrato_regularity',
    'avg_phrase_s', 'register_breaks', 'dynamic_range_db',
    'notes_detected', 'problem_notes', 'tips_count', 'top_tip', 'error',
]


def describe(path):
    """Singer, category and technique from VocalSet's folder layout: FULL/<singer>/<category>/<technique>/<file>."""
    parts = os.path.relpath(path, DATASET).split(os.sep)
    singer, category = parts[0], parts[1]
    technique = parts[2] if len(parts) > 3 else ''
    stem = os.path.splitext(parts[-1])[0]
    song = ''
    if category == 'excerpts':      # usually <singer>_<song>_<technique>.wav, but a few files skip the prefix
        words = [w.strip() for w in stem.split('_')]
        technique = words[-1]
        song = next((w for w in words if w in ('row', 'caro', 'dona')), '')
    return {'file': os.path.relpath(path, DATASET), 'singer': singer,
            'gender': 'female' if singer.startswith('female') else 'male',
            'category': category, 'technique': technique, 'song': song}


def analyse(path):
    """One VocalSet recording through the same pipeline the app uses for a session report."""
    return {**describe(path), **run_vocalize(path)}


def run_vocalize(path, module='vocal_analyzer'):
    """Report metrics for any audio file; `module` lets evaluations compare analyzer versions."""
    warnings.filterwarnings('ignore')
    sys.path.insert(0, ROOT)
    sys.path.insert(0, os.path.join(ROOT, 'data', 'results'))   # where old analyzer snapshots are kept
    import functools
    import importlib
    import librosa
    from rich.console import Console
    va = importlib.import_module(module)
    quiet = Console(quiet=True)
    va.console = quiet
    if not isinstance(va.Progress, functools.partial):
        va.Progress = functools.partial(va.Progress, console=quiet)

    row = {}
    try:
        y, sr = librosa.load(path, sr=SR, mono=True)
        engine = va.Vocalize   # older snapshots use older class names
        m, tips, extra = engine(sr=SR).analyze(y, sr_in=sr)
        deep = extra['deep']
        severity = {'critical': 0, 'warning': 1, 'info': 2, 'praise': 3}
        top = min(tips, key=lambda t: severity.get(t.severity, 9)) if tips else None
        row.update({
            'duration_s': round(len(extra['y']) / SR, 2),
            'voice_type': extra['voice_type'],
            'overall_score': round(m.overall_score, 1),
            'pitch_accuracy': round(m.intonation_score, 1),
            'pitch_stability': round(m.pitch_stability_score, 1),
            'vibrato_score': round(m.vibrato_score, 1),
            'breath_support': round(m.breath_support_score, 1),
            'resonance_tone': round(m.resonance_score, 1),
            'dynamic_control': round(m.dynamic_control_score, 1),
            'register_changes': round(m.smoothness_through_break, 1),
            'avg_pitch_hz': round(m.f0_mean, 1),
            'centre_note': librosa.hz_to_note(m.f0_mean) if m.f0_mean > 0 else '',
            'range_semitones': round(m.f0_range_semitones, 1),
            'pitch_tendency': deep.get('flat_sharp_bias', ''),
            'vibrato_present': bool(m.vibrato_present),
            'vibrato_rate_hz': round(m.vibrato_rate_hz, 2),
            'vibrato_extent_st': round(m.vibrato_extent_semitones, 3),
            'vibrato_regularity': round(m.vibrato_regularity, 1),
            'avg_phrase_s': round(m.avg_phrase_length_s, 2),
            'register_breaks': int(m.register_breaks),
            'dynamic_range_db': round(m.dynamic_range_db, 1),
            'notes_detected': len(extra.get('notes', [])),
            'problem_notes': ', '.join(n['note_name'] for n in deep.get('problem_notes', [])),
            'tips_count': len(tips),
            'top_tip': f"{top.category}: {top.headline}" if top else '',
            'error': '',
        })
    except Exception as e:  # keep going; record what failed
        row['error'] = f'{type(e).__name__}: {e}'
    return row


def find_files(category):
    cats = CATEGORIES if category == 'all' else (category,)
    files = []
    for dirpath, _, names in os.walk(DATASET):
        rel = os.path.relpath(dirpath, DATASET).split(os.sep)
        if len(rel) >= 2 and rel[1] in cats:
            files += [os.path.join(dirpath, n) for n in names if n.lower().endswith('.wav')]
    return sorted(files)


def write_excel(rows, path, category):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = 'Results'
    ws.append(COLUMNS)
    for r in sorted(rows, key=lambda r: r['file']):
        ws.append([r.get(c, '') for c in COLUMNS])
    head = PatternFill('solid', fgColor='EFE6D2')
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = head
        cell.alignment = Alignment(wrap_text=True, vertical='top')
    for i, c in enumerate(COLUMNS, 1):
        ws.column_dimensions[get_column_letter(i)].width = 38 if c in ('top_tip', 'file', 'error') else \
            22 if c in ('pitch_tendency', 'problem_notes') else 13
    ws.freeze_panes = 'B2'
    ws.auto_filter.ref = ws.dimensions

    # Summary: averages per singer and per technique
    ok = [r for r in rows if not r.get('error')]
    scores = ['overall_score', 'pitch_accuracy', 'pitch_stability', 'vibrato_score', 'breath_support',
              'resonance_tone', 'dynamic_control', 'register_changes']
    s = wb.create_sheet('Summary')
    s.append([f'Vocalize analysis of VocalSet ({category}): {len(ok)} recordings analysed, '
              f'{len(rows) - len(ok)} failed. Scores are 0–100 averages.'])
    s['A1'].font = Font(bold=True)
    for title, key in (('By singer', 'singer'), ('By technique', 'technique'), ('By gender', 'gender')):
        s.append([])
        s.append([title, 'recordings'] + scores)
        for cell in s[s.max_row]:
            cell.font = Font(bold=True)
            cell.fill = head
        for group in sorted({r[key] for r in ok}):
            g = [r for r in ok if r[key] == group]
            s.append([group, len(g)] + [round(sum(r[c] for r in g) / len(g), 1) for c in scores])
    s.column_dimensions['A'].width = 16
    for i in range(2, len(scores) + 3):
        s.column_dimensions[get_column_letter(i)].width = 14

    about = wb.create_sheet('About')
    for line in [
        'How this was made',
        'Each recording was run through Vocalize\'s full session analysis (the same as "Analyse my singing" in the app).',
        'Scores are 0–100. Measurements: pitch in Hz, range in semitones, vibrato rate in Hz and extent in semitones.',
        'Note: VocalSet excerpts are short and some use deliberate techniques (breathy, vocal fry, spoken, straight tone),',
        'so low scores for those are expected and do not mean poor singing.',
        '',
        'Dataset credit (CC BY 4.0): Wilkins, J., Seetharaman, P., Wahl, A., Pardo, B. "VocalSet: A Singing Voice Dataset."',
        'ISMIR 2018. doi:10.5281/zenodo.1442513',
    ]:
        about.append([line])
    about['A1'].font = Font(bold=True)
    about.column_dimensions['A'].width = 120
    wb.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--category', default='excerpts', choices=CATEGORIES + ('all',))
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument('--out', help='Excel file to write (default: data/results/vocalset_<category>.xlsx)')
    args = ap.parse_args()

    out = args.out or os.path.join(ROOT, 'data', 'results', f'vocalset_{args.category}.xlsx')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    checkpoint = os.path.splitext(out)[0] + '.partial.csv'

    done = {}
    if os.path.exists(checkpoint):
        with open(checkpoint, newline='', encoding='utf-8') as f:
            done = {r['file']: r for r in csv.DictReader(f)}
    files = [p for p in find_files(args.category) if os.path.relpath(p, DATASET) not in done]
    total = len(files) + len(done)
    print(f'{total} recordings ({len(done)} already done), {args.workers} workers')

    t0 = time.time()
    new_file = not os.path.exists(checkpoint)
    with open(checkpoint, 'a', newline='', encoding='utf-8') as f, ProcessPoolExecutor(args.workers) as pool:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        if new_file:
            writer.writeheader()
        for i, fut in enumerate(as_completed([pool.submit(analyse, p) for p in files]), 1):
            row = fut.result()
            writer.writerow({c: row.get(c, '') for c in COLUMNS})
            f.flush()
            done[row['file']] = row
            if i % 10 == 0 or i == len(files):
                rate = (time.time() - t0) / i
                print(f'  {len(done)}/{total}  ~{rate * (len(files) - i) / 60:.0f} min left', flush=True)

    # CSV round-trips numbers as text; convert back for Excel
    rows = []
    for r in done.values():
        conv = {}
        for k, v in r.items():
            if isinstance(v, str) and k not in ('file', 'singer', 'gender', 'category', 'technique', 'song',
                                                 'voice_type', 'centre_note', 'pitch_tendency', 'problem_notes',
                                                 'top_tip', 'error'):
                conv[k] = {'True': True, 'False': False}.get(v, float(v) if v not in ('',) else '')
            else:
                conv[k] = v
        rows.append(conv)
    write_excel(rows, out, args.category)
    os.remove(checkpoint)
    print(f'Saved {out}')


if __name__ == '__main__':
    main()
