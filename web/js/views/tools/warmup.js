// Guided warm-ups: the piano plays a pattern, then you sing it back and each note is scored.
// Call-and-response (rather than singing over the piano) keeps the piano out of the mic.
import { Piano, PitchStream, micErrorMessage, midiName } from '../../audio.js';
import { $, esc, showMsg } from '../../ui.js';
import { centsFromTarget, median, practiceContext, saveResult, sleep, toolHeader } from './common.js';

export const ROUTINES = {
  lip_trill: { name: 'Lip trills', how: 'Blow through loose lips so they buzz (“brrr”) while you follow the notes. Keep the air steady.',
    pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0], beat: 0.42, steps: 6 },
  five_note_scale: { name: 'Five-note scale', how: 'Sing on a relaxed “ah”. Land each note cleanly without scooping.',
    pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0], beat: 0.55, steps: 6 },
  arpeggio: { name: 'Arpeggio 1-3-5-8', how: 'Sing “ah” or “oh”, keeping the same tone color from bottom to top.',
    pattern: [0, 4, 7, 12, 7, 4, 0], beat: 0.55, steps: 5 },
  siren: { name: 'Sirens', how: 'On “ng” or a lip trill, glide smoothly from low to high and back, like a siren. No bumps at the break.',
    pattern: [0, 7, 12, 7, 0], beat: 0.8, steps: 5 },
  nay_resonance: { name: 'Bright “nay”', how: 'Sing a bright, slightly nasal “nay”. Feel the buzz forward in your face.',
    pattern: [0, 4, 7, 4, 0], beat: 0.55, steps: 6 },
  messa_di_voce: { name: 'Messa di voce', how: 'Hold one note: start softly, swell to full voice, then fade away, all on the same pitch.',
    pattern: [0], beat: 5, steps: 4 },
};

export async function render(root, params, app) {
  const key = ROUTINES[params[0]] ? params[0] : null;
  if (!key) return renderList(root);
  const r = ROUTINES[key];
  const ctx = await practiceContext();
  let start = ctx.startNote;

  root.innerHTML = `
    ${toolHeader('Guided warm-up', esc(r.name), esc(r.how))}
    <div class="card">
      <div class="row">
        <label class="small muted" for="startNote">Starting note</label>
        <select id="startNote" style="width:auto;padding:6px 10px">
          ${Array.from({ length: 25 }, (_, i) => 38 + i).map((m) => `<option value="${m}" ${m === start ? 'selected' : ''}>${midiName(m)}</option>`).join('')}
        </select>
        <span class="small muted">Steps up by a semitone ${r.steps} times.</span>
      </div>
      <div style="text-align:center;padding:26px 0 8px">
        <div class="kicker" id="phase">Ready</div>
        <div class="big-number" id="stepLabel" style="font-size:44px;margin:8px 0">Round 1 of ${r.steps}</div>
        <div class="target-list" id="notes" aria-live="polite"></div>
        <div class="row" style="justify-content:center;margin-top:22px">
          <button class="btn btn-primary btn-lg" id="go">Start warm-up</button>
          <button class="btn hidden" id="stop">Stop</button>
        </div>
      </div>
      <div id="msg" class="msg hidden"></div>
      <div id="result"></div>
    </div>`;

  $('#startNote', root).addEventListener('change', (e) => { start = Number(e.target.value); });
  let stopped = false, finished = false, left = false, stream = null, piano = null;
  const results = [];

  $('#go', root).addEventListener('click', async () => {
    stopped = false;
    finished = false;
    results.length = 0;
    $('#result', root).innerHTML = '';
    $('#go', root).classList.add('hidden'); $('#stop', root).classList.remove('hidden');
    $('#startNote', root).disabled = true;
    piano = new Piano();
    try {
      for (let step = 0; step < r.steps && !stopped; step++) {
        const notes = r.pattern.map((o) => start + step + o);
        $('#stepLabel', root).textContent = `Round ${step + 1} of ${r.steps}`;
        paintNotes(notes, -1, []);
        // Listen
        $('#phase', root).textContent = 'Listen';
        piano.sequence([{ midi: [notes[0], notes[0] + 4, notes[0] + 7], dur: 0.7 }]);
        await sleep(900);
        const dur = piano.sequence(notes.map((m) => ({ midi: m, dur: r.beat })), { start: 0.05, gap: 0.02 });
        await sleep(dur * 1000 + 250);
        if (stopped) break;
        // Your turn
        $('#phase', root).textContent = 'Your turn';
        const scores = await singBack(notes, r.beat);
        if (scores === null) break;
        results.push(...scores);
        paintNotes(notes, -1, scores);
        await sleep(700);
      }
    } catch (err) {
      showMsg($('#msg', root), micErrorMessage(err));
    }
    finish();
  });

  $('#stop', root).addEventListener('click', () => { stopped = true; piano?.stopAll(); stream?.stop(); finish(); });

  function paintNotes(notes, now, scores) {
    $('#notes', root).innerHTML = notes.map((m, i) => {
      const s = scores[i];
      const cls = s == null ? (i === now ? 'now' : '') : s >= 60 ? 'hit' : 'miss';
      return `<span class="${cls}">${midiName(m)}${s != null ? ` · ${s}%` : ''}</span>`;
    }).join('');
  }

  /** Guide the singer through `notes` at `beat` seconds each; returns % of in-tune frames per note. */
  async function singBack(notes, beat) {
    const frames = notes.map(() => []);
    let idx = -1;
    stream = new PitchStream({ onPitch: (p) => { if (idx >= 0 && idx < notes.length && p.midi != null) frames[idx].push(p.midi); } });
    await stream.start();
    await sleep(350);                      // mic settles; singer takes a breath
    for (idx = 0; idx < notes.length; idx++) {
      if (stopped) break;
      paintNotes(notes, idx, []);
      await sleep(beat * 1000);
    }
    idx = -1;
    stream.stop();
    if (stopped) return null;
    return notes.map((target, i) => {
      // Ignore the first 30% of each note window (reaction time and the glide into it)
      const f = frames[i].slice(Math.floor(frames[i].length * 0.3));
      if (!f.length) return 0;
      const ok = f.filter((m) => Math.abs(centsFromTarget(m, target)) <= 50).length;
      return Math.round((ok / f.length) * 100);
    });
  }

  async function finish() {
    if (finished || left) return;
    finished = true;
    $('#stop', root).classList.add('hidden'); $('#go', root).classList.remove('hidden');
    $('#go', root).textContent = 'Go again';
    $('#startNote', root).disabled = false;
    $('#phase', root).textContent = results.length ? 'Finished' : 'Ready';
    if (!results.length) return;
    const score = Math.round(results.reduce((a, b) => a + b, 0) / results.length);
    const med = median(results);
    $('#result', root).innerHTML = `<div class="tiles" style="margin-top:14px">
      <div class="tile"><div class="label">Notes on target</div><div class="value">${score}%</div></div>
      <div class="tile"><div class="label">Typical note</div><div class="value">${med}%</div><div class="sub">in tune</div></div>
      <div class="tile"><div class="label">Notes sung</div><div class="value">${results.length}</div></div></div>`;
    await saveResult(app, 'warmup', score, { routine: key, start, notes: results.length });
  }

  return () => { left = true; stopped = true; piano?.stopAll(); stream?.stop(); };
}

function renderList(root) {
  root.innerHTML = `${toolHeader('Guided warm-ups', 'Wake up the <em>voice</em>', 'Five minutes before you sing makes everything easier.')}
    <div class="tool-grid">${Object.entries(ROUTINES).map(([k, r]) => `
      <a class="tool" href="#/practice/warmup/${k}"><h3>${esc(r.name)}</h3><p>${esc(r.how)}</p></a>`).join('')}</div>`;
}
