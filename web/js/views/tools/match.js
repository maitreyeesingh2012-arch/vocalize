// Pitch matching: hear a note, sing it back. Misses come back for another try.
import { Piano, PitchStream, micErrorMessage, midiName } from '../../audio.js';
import { $, esc, showMsg } from '../../ui.js';
import { centsFromTarget, median, practiceContext, saveResult, sleep, toolHeader } from './common.js';

const LISTEN_S = 2.4;
const HIT_CENTS = 50;

export async function render(root, params, app) {
  const ctx = await practiceContext();
  const q = app.query;
  let pool = q.get('notes') ? q.get('notes').split(',').map(Number).filter(Number.isFinite) : [];
  if (!pool.length) pool = ctx.trouble_notes?.length ? ctx.trouble_notes : [];
  if (pool.length < 3) {
    const c = ctx.comfortNote;
    for (const o of [-5, -3, 0, 2, 4, 5, 7]) if (!pool.includes(c + o)) pool.push(c + o);
  }
  const rounds = Number(q.get('rounds') || 10);

  root.innerHTML = `
    ${toolHeader('Pitch matching', 'Hear it, <em>sing it</em>', 'Listen to each note, then sing it back on “ah”. Any octave counts.')}
    <div class="card">
      <div style="text-align:center;padding:10px 0">
        <div class="kicker" id="phase">Ready</div>
        <div class="big-number" id="noteBig" style="margin:10px 0">?</div>
        <div class="cents" id="feedback" style="min-height:26px;font-size:16px">${rounds} notes, focusing on ${esc(pool.slice(0, 4).map((m) => midiName(m)).join(', '))}${pool.length > 4 ? '…' : ''}</div>
        <div class="row" style="justify-content:center;margin:18px 0">
          <button class="btn btn-primary btn-lg" id="go">Start</button>
          <button class="btn hidden" id="stop">Stop</button>
        </div>
        <div class="target-list" id="history" aria-live="polite"></div>
      </div>
      <div id="msg" class="msg hidden"></div>
      <div id="result"></div>
    </div>
    ${ctx.note_stats?.length ? `<div class="card" style="margin-top:16px"><h2>Your note accuracy so far</h2>
      <table class="data"><thead><tr><th>Note</th><th>Tries</th><th>Hit rate</th><th>Average miss</th></tr></thead><tbody>
      ${ctx.note_stats.map((n) => `<tr><td>${esc(n.name)}</td><td>${n.tries}</td><td>${n.accuracy}%</td><td>${n.avg_cents}¢</td></tr>`).join('')}
      </tbody></table></div>` : ''}`;

  let stopped = false, finished = false, left = false, stream = null, piano = null;
  const attempts = [];

  $('#go', root).addEventListener('click', async () => {
    stopped = false;
    finished = false;
    attempts.length = 0;
    $('#history', root).innerHTML = '';
    $('#result', root).innerHTML = '';
    $('#go', root).classList.add('hidden'); $('#stop', root).classList.remove('hidden');
    piano = new Piano();
    const queue = Array.from({ length: rounds }, (_, i) => pool[i % pool.length]).sort(() => Math.random() - 0.5);
    try {
      for (let i = 0; i < queue.length && !stopped; i++) {
        const target = queue[i];
        $('#phase', root).textContent = `Note ${i + 1} of ${queue.length} · Listen`;
        $('#noteBig', root).textContent = '♪';
        $('#feedback', root).textContent = '';
        piano.note(target, 0.05, 1.1);
        await sleep(1400);
        if (stopped) break;
        $('#phase', root).textContent = `Note ${i + 1} of ${queue.length} · Sing`;
        $('#noteBig', root).textContent = '…';
        const sung = await listen();
        if (sung === undefined) break;
        const cents = sung == null ? null : Math.round(centsFromTarget(sung, target));
        const hit = cents != null && Math.abs(cents) <= HIT_CENTS;
        attempts.push({ target, sung, cents, hit });
        $('#noteBig', root).textContent = midiName(target);
        $('#feedback', root).innerHTML = sung == null ? 'Didn’t catch that. Try singing a little louder.'
          : hit ? `<b style="color:var(--good-text)">On target</b>, ${Math.abs(cents) < 5 ? 'dead center' : `${Math.abs(cents)}¢ ${cents > 0 ? 'sharp' : 'flat'}`}`
          : `<b style="color:var(--bad-text)">${Math.abs(cents)}¢ ${cents > 0 ? 'sharp' : 'flat'}</b>. You sang ${midiName(sung)}`;
        $('#history', root).insertAdjacentHTML('beforeend', `<span class="${hit ? 'hit' : 'miss'}">${midiName(target)}</span>`);
        // A missed note comes back once more near the end
        if (!hit && queue.filter((n) => n === target).length < 3 && queue.length < rounds + 4) queue.push(target);
        await sleep(1100);
      }
    } catch (err) {
      showMsg($('#msg', root), micErrorMessage(err));
    }
    finish();
  });

  $('#stop', root).addEventListener('click', () => { stopped = true; piano?.stopAll(); stream?.stop(); finish(); });

  /** Median stable pitch sung during the listening window (null if nothing clear; undefined if stopped). */
  async function listen() {
    const frames = [];
    stream = new PitchStream({ onPitch: (p) => { if (p.midi != null && p.t > 0.45) frames.push(p.midi); } });
    await stream.start();
    await sleep(LISTEN_S * 1000);
    stream.stop();
    if (stopped) return undefined;
    return frames.length >= 5 ? median(frames) : null;
  }

  async function finish() {
    if (finished || left) return;
    finished = true;
    $('#stop', root).classList.add('hidden'); $('#go', root).classList.remove('hidden');
    $('#go', root).textContent = 'Go again';
    $('#phase', root).textContent = attempts.length ? 'Finished' : 'Ready';
    if (!attempts.length) return;
    const hits = attempts.filter((a) => a.hit).length;
    const score = Math.round((hits / attempts.length) * 100);
    const misses = [...new Set(attempts.filter((a) => !a.hit).map((a) => midiName(a.target)))];
    $('#result', root).innerHTML = `<div class="tiles" style="margin-top:14px">
      <div class="tile"><div class="label">Hit rate</div><div class="value">${score}%</div><div class="sub">${hits} of ${attempts.length} notes</div></div>
      <div class="tile"><div class="label">To practice</div><div class="value" style="font-size:19px">${misses.length ? esc(misses.join(', ')) : 'None. Lovely!'}</div></div></div>`;
    await saveResult(app, 'pitch_match', score, { attempts });
  }

  return () => { left = true; stopped = true; piano?.stopAll(); stream?.stop(); };
}
