// Helpers shared by the practice tools.
import { api } from '../../api.js';
import { esc, icons, toast } from '../../ui.js';

/** Comfortable low starting note per voice type (MIDI), for warm-ups and drills. */
const START_NOTE = { soprano: 60, mezzo: 57, alto: 55, tenor: 48, baritone: 45, bass: 41 };
const COMFORT = { soprano: 67, mezzo: 64, alto: 60, tenor: 55, baritone: 52, bass: 48 };

let summaryCache = null;
export async function practiceContext(force = false) {
  if (!summaryCache || force) {
    try {
      summaryCache = await api('/api/practice/summary');
    } catch {
      // Offline (or server unreachable): the tools still work with sensible defaults.
      return { offline: true, trouble_notes: [], note_stats: [], range: null, range_history: [], passaggio: null,
               best_breath_s: null, voice_type: null, startNote: 53, comfortNote: 57 };
    }
  }
  const s = summaryCache;
  const vt = s.voice_type && START_NOTE[s.voice_type] ? s.voice_type : null;
  return {
    ...s,
    startNote: s.range ? Math.max(s.range.low + 3, 36) : vt ? START_NOTE[vt] : 53,
    comfortNote: s.comfort_note || (vt ? COMFORT[vt] : 57),
  };
}

/** Save a practice result; if the tool was opened from a plan item, that item is ticked off too. */
export async function saveResult(app, kind, score, data) {
  const item = app.query?.get('item');
  try {
    await api('/api/practice/results', { method: 'POST', json: { kind, score, data, plan_item_id: item ? Number(item) : undefined } });
    summaryCache = null;
    if (item) toast('Nice work. Marked done in today’s plan.');
  } catch (err) {
    toast(err.status === 0 ? 'Offline: this result wasn’t saved.' : err.message);
  }
}

export function toolHeader(kicker, title, sub = '') {
  return `<a class="btn btn-quiet btn-sm" href="#/practice" style="margin-bottom:10px">${icons.back} Practice room</a>
    <div class="page-head"><div><div class="kicker">${esc(kicker)}</div><h1>${title}</h1>${sub ? `<p class="muted" style="margin:6px 0 0">${sub}</p>` : ''}</div></div>`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fold a pitch into the octave nearest `target` so singing an octave away still counts. */
export function centsFromTarget(midi, target, { octaveFree = true } = {}) {
  let diff = (midi - target) * 100;
  if (octaveFree) diff = ((diff % 1200) + 1800) % 1200 - 600;
  return diff;
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
