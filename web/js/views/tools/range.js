// Range finder: hold your lowest, then highest comfortable note; see it on a keyboard.
import { PitchStream, micErrorMessage, midiName } from '../../audio.js';
import { keyboard } from '../../charts.js';
import { $, esc, showMsg } from '../../ui.js';
import { practiceContext, saveResult, toolHeader } from './common.js';

const HOLD_S = 0.5;       // a note must be held this long to count
const VOICE_HINTS = [      // [lowest typical, highest typical, name]
  [41, 64, 'bass'], [45, 67, 'baritone'], [48, 72, 'tenor'], [53, 77, 'alto'], [57, 81, 'mezzo-soprano'], [60, 84, 'soprano'],
];

export async function render(root, params, app) {
  const ctx = await practiceContext();
  const prev = ctx.range;
  let phase = 'idle', low = null, high = null, live = null, stream = null;
  let holdStart = null, holdRef = null;

  root.innerHTML = `
    ${toolHeader('Range finder', 'Map your <em>range</em>', 'Sing comfortably. There’s no need to strain for extreme notes.')}
    <div class="card">
      <div style="text-align:center">
        <div class="kicker" id="phase">Step 1 of 2</div>
        <h2 class="serif" id="instr" style="font-size:28px;margin:8px 0">Slide down to your lowest comfortable note and hold it</h2>
        <div class="big-number" id="live" style="font-size:54px">–</div>
        <div class="small muted" id="found" style="min-height:22px"></div>
      </div>
      <div id="kbd" style="margin-top:14px"></div>
      <div class="row" style="justify-content:center;margin-top:18px">
        <button class="btn btn-primary btn-lg" id="go">Start</button>
        <button class="btn hidden" id="next">That’s my lowest</button>
      </div>
      <div id="msg" class="msg hidden"></div>
      <div id="result"></div>
    </div>`;

  const paintKbd = () => {
    const lo = Math.min(36, low ?? 99, prev?.low ?? 99) - 1, hi = Math.max(84, high ?? 0, prev?.high ?? 0) + 1;
    $('#kbd', root).innerHTML = keyboard({ from: lo, to: hi, low, high: high ?? low, passaggio: ctx.passaggio, previous: prev, live });
  };
  paintKbd();

  const onPitch = (p) => {
    if (p.midi == null) { live = null; holdStart = null; $('#live', root).textContent = '–'; paintKbd(); return; }
    live = Math.round(p.midi);
    $('#live', root).textContent = midiName(p.midi);
    // A note counts once it's held steadily (within ~60 cents) for HOLD_S seconds
    if (holdRef == null || Math.abs(p.midi - holdRef) > 0.6) { holdRef = p.midi; holdStart = p.t; }
    if (p.t - holdStart >= HOLD_S) {
      const n = Math.round(holdRef);
      if (phase === 'low' && (low == null || n < low)) { low = n; $('#found', root).textContent = `Lowest so far: ${midiName(n)}`; }
      if (phase === 'high' && (high == null || n > high)) { high = n; $('#found', root).textContent = `Highest so far: ${midiName(n)}`; }
    }
    paintKbd();
  };

  $('#go', root).addEventListener('click', async () => {
    if (phase === 'done') { low = high = null; }
    try {
      stream = new PitchStream({ onPitch, fmin: 50, fmax: 1500 });
      await stream.start();
    } catch (err) { showMsg($('#msg', root), micErrorMessage(err)); return; }
    phase = 'low';
    $('#go', root).classList.add('hidden');
    $('#next', root).classList.remove('hidden');
    $('#next', root).textContent = 'That’s my lowest';
    $('#phase', root).textContent = 'Step 1 of 2';
    $('#instr', root).textContent = 'Slide down to your lowest comfortable note and hold it';
    $('#result', root).innerHTML = '';
  });

  $('#next', root).addEventListener('click', async () => {
    if (phase === 'low') {
      if (low == null) { $('#found', root).textContent = 'Hold a low note for a moment so we can catch it.'; return; }
      phase = 'high';
      $('#phase', root).textContent = 'Step 2 of 2';
      $('#instr', root).textContent = 'Now glide up to your highest comfortable note and hold it';
      $('#next', root).textContent = 'That’s my highest';
      $('#found', root).textContent = '';
      return;
    }
    if (high == null || high <= low) { $('#found', root).textContent = 'Hold a high note for a moment so we can catch it.'; return; }
    stream.stop();
    phase = 'done'; live = null;
    $('#next', root).classList.add('hidden');
    $('#go', root).classList.remove('hidden'); $('#go', root).textContent = 'Measure again';
    $('#phase', root).textContent = 'Your range';
    $('#instr', root).textContent = `${midiName(low)} to ${midiName(high)}`;
    $('#live', root).textContent = `${high - low} semitones`;
    const mid = (low + high) / 2;
    const hint = VOICE_HINTS.reduce((best, v) => (Math.abs((v[0] + v[1]) / 2 - mid) < Math.abs((best[0] + best[1]) / 2 - mid) ? v : best));
    const growth = prev ? (high - low) - (prev.high - prev.low) : null;
    $('#found', root).innerHTML = `That range is typical of ${/^[aeiou]/i.test(hint[2]) ? 'an' : 'a'} <b>${esc(hint[2])}</b>. ${growth ? `${growth > 0 ? '+' : ''}${growth} semitones since last time.` : ''}`;
    paintKbd();
    await saveResult(app, 'range', high - low, { low, high });
  });

  return () => stream?.stop();
}
