"""
Pitch-detection accuracy test for Vocalize's analysis pipeline.

1) Synthetic test (no setup):
       python scripts/pitch_accuracy.py
   Generates sung-like tones with known pitch (C3–C6, with and without vibrato, with
   background noise and deliberately detuned notes), runs Vocalize's pitch analyzer on
   each, and reports the error in cents.

2) Your own recordings of known notes (e.g. a keyboard, or a singer matching a tuner):
       python scripts/pitch_accuracy.py --csv my_notes.csv
   my_notes.csv has a header row "file,note" and one line per recording, e.g.
       recordings/a4.wav,A4
       recordings/c4_sung.wav,C4
   Each file should hold one sustained note.

Add --out results.md to save a Markdown table.
"""
import argparse
import csv
import os
import statistics
import sys

import librosa
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vocal_analyzer as va  # noqa: E402
from rich.console import Console  # noqa: E402

va.console = Console(quiet=True)
SR = 44100


def tone(midi, seconds=2.0, vibrato_cents=0.0, noise=0.0, seed=0):
    t = np.arange(int(SR * seconds)) / SR
    f = 440 * 2 ** ((midi - 69) / 12) * 2 ** (vibrato_cents / 1200 * np.sin(2 * np.pi * 5.5 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = sum((0.6 / k) * np.sin(k * ph) for k in range(1, 8)) * np.minimum(1, t / 0.05)
    y = 0.3 * y / np.abs(y).max()
    if noise:
        y += noise * np.random.default_rng(seed).standard_normal(len(y))
    return y.astype(np.float32)


def measured_midi(y, sr=SR):
    """Median pitch (MIDI, fractional) of the sustained note, using Vocalize's own analyzer."""
    pa = va.PitchAnalyzer(sr=sr, fmin=65, fmax=1400)
    f0, _, times = pa.extract(y)
    notes = pa.extract_notes(f0, times, y)
    if notes:
        longest = max(notes, key=lambda n: n['dur_s'])
        return longest['median_midi']
    valid = f0[~np.isnan(f0)]
    return float(np.median(librosa.hz_to_midi(valid))) if len(valid) else None


def synthetic_cases():
    for midi in range(48, 85, 3):                        # C3 … C6 in minor-third steps
        yield f'{librosa.midi_to_note(midi)} steady', midi, tone(midi)
        yield f'{librosa.midi_to_note(midi)} vibrato ±40¢', midi, tone(midi, vibrato_cents=40)
        yield f'{librosa.midi_to_note(midi)} noisy', midi, tone(midi, noise=0.02, seed=midi)
    for detune in (-35, -15, 15, 35):                    # off-pitch singing must be measured, not snapped
        yield f'A4 {detune:+d}¢', 69 + detune / 100, tone(69 + detune / 100)


def csv_cases(path):
    base = os.path.dirname(os.path.abspath(path))
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            file = row['file'] if os.path.isabs(row['file']) else os.path.join(base, row['file'])
            y, _ = librosa.load(file, sr=SR, mono=True)
            yield os.path.basename(file), float(librosa.note_to_midi(row['note'])), y


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--csv', help='CSV of your own recordings (columns: file,note)')
    ap.add_argument('--out', help='write a Markdown report here')
    args = ap.parse_args()

    rows, errors = [], []
    for name, truth, y in (csv_cases(args.csv) if args.csv else synthetic_cases()):
        got = measured_midi(y)
        if got is None:
            rows.append((name, truth, None, None))
            continue
        err = (got - truth) * 100
        errors.append(abs(err))
        rows.append((name, truth, got, err))

    detected = len(errors)
    lines = [f"# Vocalize pitch accuracy ({'recordings from ' + args.csv if args.csv else 'synthetic tones'})", '',
             f"- Notes tested: **{len(rows)}**, detected: **{detected}**",
             f"- Mean absolute error: **{statistics.mean(errors):.1f} cents**" if errors else '- No notes detected',
             f"- Median absolute error: **{statistics.median(errors):.1f} cents**" if errors else '',
             f"- Worst error: **{max(errors):.1f} cents**" if errors else '',
             f"- Within 10 cents: **{sum(e <= 10 for e in errors)} of {detected}**" if errors else '',
             '', '(100 cents = one semitone. Most listeners notice errors above about 10–20 cents.)', '',
             '| Test | Expected | Measured | Error (cents) |', '|---|---|---|---|']
    for name, truth, got, err in rows:
        lines.append(f"| {name} | {truth:.2f} | {'—' if got is None else f'{got:.2f}'} | "
                     f"{'not detected' if err is None else f'{err:+.1f}'} |")
    report = '\n'.join(l for l in lines if l is not None)
    print(report)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(report + '\n')


if __name__ == '__main__':
    main()
