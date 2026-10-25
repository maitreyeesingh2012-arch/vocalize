// Live pitch meter, with an optional "hold this note" target (used by the practice plan).
import { Piano, PitchStream, micErrorMessage, midiName, noteParts } from '../../audio.js';
import { $, esc, showMsg } from '../../ui.js';
import { centsFromTarget, saveResult, toolHeader } from './common.js';

const TRAIL_S = 8;

export async function render(root, params, app) {
  const q = app.query;
  const target = q.has('note') ? Number(q.get('note')) : null;
  const goal = Number(q.get('seconds') || 8);
  const tol = Number(q.get('tolerance') || 25);
  const mode = q.get('mode') || '';

  const instructions = {
    messa: `Start softly on ${target != null ? midiName(target) : 'the note'}, swell to full voice, then fade back, all on one steady pitch.`,
    vibrato: 'Begin with a straight tone, then let the vibrato bloom naturally, staying centered on the note.',
  }[mode] || (target != null ? `Hold ${midiName(target)} steadily inside the green zone for ${goal} seconds in total.` : 'Sing any note. The needle shows how far you are from the nearest note.');

  root.innerHTML = `
    ${toolHeader('Live pitch meter', target != null ? `Hold <em>${esc(midiName(target))}</em>` : 'Find your <em>center</em>', esc(instructions))}
    <div class="card">
      <div class="tuner" aria-live="polite">
        <div class="note" id="note">–</div>
        <div class="cents" id="cents">Press start and sing</div>
        <div class="needle-scale" aria-hidden="true">
          <div class="zone" style="left:${50 - tol}%;width:${tol * 2}%;background:var(--good-soft);border:1px solid color-mix(in srgb, var(--good) 50%, transparent)"></div>
          <div class="needle" id="needle"></div>
          <div class="ticks"><span>50¢ flat</span><span>in tune</span><span>50¢ sharp</span></div>
        </div>
        ${target != null ? `<div class="hold-bar" aria-hidden="true"><div id="hold"></div></div>
          <div class="small muted" id="holdText" style="margin-top:6px">0.0 / ${goal}s in the zone</div>` : ''}
        <div class="row" style="justify-content:center;margin-top:20px">
          <button class="btn btn-primary btn-lg" id="toggle">Start</button>
          ${target != null ? '<button class="btn" id="ref">Play the note</button>' : ''}
        </div>
      </div>
      <canvas id="trail" style="width:100%;height:200px;margin-top:18px;display:block" aria-label="Your pitch over the last ${TRAIL_S} seconds"></canvas>
      <div class="chart-legend" style="margin-top:8px"><span><i style="background:var(--series-1)"></i>Your pitch</span>${target != null ? '<span><i class="band" style="background:var(--good)"></i>Target zone</span>' : ''}</div>
      <div id="msg" class="msg hidden"></div>
    </div>`;

  const trail = [];
  let inZone = 0, lastT = null, done = false, samples = 0, good = 0;
  const canvas = $('#trail', root), ctx = canvas.getContext('2d');

  const stream = new PitchStream({
    onPitch: (p) => {
      trail.push(p);
      while (trail.length && p.t - trail[0].t > TRAIL_S) trail.shift();
      const dt = lastT == null ? 0 : p.t - lastT;
      lastT = p.t;
      if (p.midi == null) {
        $('#cents', root).textContent = 'Listening…';
        $('#needle', root).style.background = 'var(--muted)';
        return;
      }
      const cents = target != null ? centsFromTarget(p.midi, target) : p.cents;
      const shown = target != null ? noteParts(target + Math.round((p.midi - target) / 12) * 12) : noteParts(p.midi);
      $('#note', root).innerHTML = `${shown.name}<sub>${shown.octave}</sub>`;
      const c = Math.round(cents);
      const ok = Math.abs(cents) <= tol;
      $('#cents', root).textContent = Math.abs(c) < 3 ? 'Right on' : `${Math.abs(c)}¢ ${c > 0 ? 'sharp' : 'flat'}${target != null && Math.abs(c) > 100 ? ` (you're on ${midiName(p.midi)})` : ''}`;
      $('#needle', root).style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
      $('#needle', root).style.background = ok ? 'var(--good)' : 'var(--text)';
      if (target != null && !done) {
        samples++; if (ok) good++;
        if (ok && dt < 0.2) inZone += dt;
        $('#hold', root).style.width = `${Math.min(100, (inZone / goal) * 100)}%`;
        $('#holdText', root).textContent = `${inZone.toFixed(1)} / ${goal}s in the zone`;
        if (!done && inZone >= goal) finish();
      }
    },
  });

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const voiced = trail.filter((p) => p.midi != null);
    const center = target != null ? target : voiced.length ? Math.round(voiced[voiced.length - 1].midi) : 60;
    const lo = center - 6, hi = center + 6;
    const y = (m) => h - ((m - lo) / (hi - lo)) * h;
    ctx.font = '11px Manrope, system-ui';
    for (let n = lo; n <= hi; n++) {
      ctx.strokeStyle = n === center ? css('--axis') : css('--grid');
      ctx.beginPath(); ctx.moveTo(34, y(n) + 0.5); ctx.lineTo(w, y(n) + 0.5); ctx.stroke();
      if (n % 2 === center % 2) { ctx.fillStyle = css('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(midiName(n), 30, y(n)); }
    }
    if (target != null) {
      ctx.fillStyle = css('--good-soft');
      ctx.fillRect(34, y(target + tol / 100), w - 34, y(target - tol / 100) - y(target + tol / 100));
    }
    const now = trail.length ? trail[trail.length - 1].t : 0;
    const x = (t) => 34 + (1 - (now - t) / TRAIL_S) * (w - 34);
    ctx.strokeStyle = css('--series-1'); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    let pen = false;
    for (const p of trail) {
      if (p.midi == null) { pen = false; continue; }
      let m = p.midi;
      if (target != null) m = target + centsFromTarget(p.midi, target) / 100;   // fold octaves onto the target
      pen ? ctx.lineTo(x(p.t), y(m)) : ctx.moveTo(x(p.t), y(m));
      pen = true;
    }
    ctx.stroke();
    raf = requestAnimationFrame(draw);
  }
  let raf = requestAnimationFrame(draw);

  let running = false;
  $('#toggle', root).addEventListener('click', async () => {
    if (running) { stream.stop(); running = false; $('#toggle', root).textContent = 'Start'; return; }
    try {
      await stream.start();
      running = true;
      $('#toggle', root).textContent = 'Stop';
      $('#msg', root).classList.add('hidden');
    } catch (err) {
      showMsg($('#msg', root), micErrorMessage(err));
    }
  });
  $('#ref', root)?.addEventListener('click', () => new Piano().note(target, 0, 1.6));

  async function finish() {
    done = true;
    const pct = samples ? Math.round((good / samples) * 100) : 0;
    $('#holdText', root).innerHTML = `<b style="color:var(--good-text)">Done! ${goal}s held.</b> In tune ${pct}% of the time.`;
    await saveResult(app, 'tuner', pct, { note: target, seconds: goal, tolerance: tol, mode, in_tune_pct: pct });
  }

  return () => { cancelAnimationFrame(raf); if (running) stream.stop(); };
}
