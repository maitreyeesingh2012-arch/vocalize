"""Unpack ccmusic-database/acapella (Arrow) into WAV files + labels.csv (expert ratings, 1–10)."""
import csv
import os

from datasets import Audio, load_from_disk

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'datasets', 'acapella', 'default')
OUT = os.path.join(ROOT, 'data', 'datasets', 'acapella', 'wav')
RATINGS = ['pitch', 'rhythm', 'vocal_range', 'timbre', 'pronunciation', 'vibrato', 'dynamic',
           'breath_control', 'overall_performance']

os.makedirs(OUT, exist_ok=True)
rows = []
for song, ds in load_from_disk(SRC).items():
    ds = ds.cast_column('audio', Audio(decode=False)).remove_columns(['mel'])
    for i, r in enumerate(ds):
        name = f'{song}_singer{r["singer_id"]:02d}.wav' if isinstance(r['singer_id'], int) else f'{song}_{i:02d}.wav'
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(r['audio']['bytes'])
        rows.append({'file': name, 'song': song, 'singer_id': r['singer_id'], **{k: r[k] for k in RATINGS}})

with open(os.path.join(OUT, 'labels.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
print(len(rows), 'clips ->', OUT)
