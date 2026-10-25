"""
Usage and improvement report for a Vocalize user trial.

    python scripts/usage_report.py                      # whole database
    python scripts/usage_report.py --since 2026-10-09   # only activity from the trial start
    python scripts/usage_report.py --db path/to.db --out report.md

Counts singers, sessions and practice-tool uses, and for every singer with 2+ sessions
compares their first and last session scores (the "before and after" for the trial).
Only aggregate numbers are printed: no emails or names.
"""
import argparse
import os
import sqlite3
import statistics
import sys

AREAS = [('intonation_score', 'Pitch accuracy'), ('stability_score', 'Pitch stability'),
         ('breath_score', 'Breath support'), ('vibrato_score', 'Vibrato'),
         ('resonance_score', 'Resonance & tone'), ('dynamics_score', 'Dynamic control')]


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', default=os.environ.get('VOCALIZE_DB') or os.path.join(here, 'vocalize_vault.db'))
    ap.add_argument('--since', default='0000-00-00', help='only count activity on/after this date (YYYY-MM-DD, UTC)')
    ap.add_argument('--out', help='also write the report to this Markdown file')
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    since = args.since

    sessions = conn.execute(f"""
        SELECT s.user_id, s.timestamp, s.overall_score, {', '.join('m.' + c for c, _ in AREAS)}
        FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id
        WHERE s.timestamp >= ? ORDER BY s.user_id, s.timestamp, s.id
    """, (since,)).fetchall()
    practice = conn.execute("SELECT user_id, kind FROM practice_results WHERE created_at >= ?", (since,)).fetchall()

    active = {r['user_id'] for r in sessions} | {r['user_id'] for r in practice}
    by_user = {}
    for r in sessions:
        by_user.setdefault(r['user_id'], []).append(r)
    kinds = {}
    for r in practice:
        kinds[r['kind']] = kinds.get(r['kind'], 0) + 1

    lines = [f"# Vocalize usage report (activity since {since if since != '0000-00-00' else 'the start'})", '',
             f"- Active singers: **{len(active)}**",
             f"- Sessions recorded: **{len(sessions)}**",
             f"- Practice-tool uses: **{len(practice)}**"
             + (f" ({', '.join(f'{k}: {v}' for k, v in sorted(kinds.items()))})" if kinds else ''),
             f"- Singers with 2+ sessions (can show improvement): **{sum(len(v) >= 2 for v in by_user.values())}**", '']

    def change(col):
        deltas = [v[-1][col] - v[0][col] for v in by_user.values()
                  if len(v) >= 2 and v[0][col] is not None and v[-1][col] is not None]
        return deltas

    lines += ['## First vs last session (singers with 2+ sessions)', '',
              '| Area | Singers | Mean change | Median change | Improved |', '|---|---|---|---|---|']
    for col, label in [('overall_score', 'Overall')] + AREAS:
        d = change(col)
        if d:
            lines.append(f"| {label} | {len(d)} | {statistics.mean(d):+.1f} | {statistics.median(d):+.1f} | "
                         f"{sum(x > 0 for x in d)} of {len(d)} |")
        else:
            lines.append(f"| {label} | 0 | n/a | n/a | n/a |")
    lines += ['', 'Scores are 0–100. Small samples vary a lot; report the number of singers alongside any average.']

    report = '\n'.join(lines)
    print(report)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(report + '\n')


if __name__ == '__main__':
    sys.exit(main())
