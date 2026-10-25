// Breath trainer: inhale for four, then hiss "sss" as long and evenly as you can.
// A hiss is detected as loud, noisy (high zero-crossing) sound with no pitch.
import { Mic, micErrorMessage, rms } from '../../audio.js';
import { $, showMsg } from '../../ui.js';
import { practiceContext, saveResult, sleep, toolHeader } from './common.js';

const GAP_S = 0.6;   // a hiss can pause this long before we call it finished

function zeroCrossRate(buf) {
  let z = 0;
  for (let i = 1; i < buf.length; i++) if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) z++;
  return z / buf.length;
}

export async function render(root, params, app) {
  const ctx = await practiceContext();
  const goal = Number(app.query.get('seconds') || Math.max(15, Math.round((ctx.best_breath_s || 12) + 2)));

  root.innerHTML = `
    ${toolHeader('Breath trainer', 'Steady <em>air</em>', 'Stand tall, breathe low and wide, then hiss “sss” as evenly as you can.')}
    <div class="card" style="text-align:center">
      <div class="kicker" id="phase">Goal: ${goal} seconds${ctx.best_breath_s ? ` · Your best: ${ctx.best_breath_s.toFixed(1)}s` : ''}</div>
      <div id="bubble" style="width:120px;height:120px;border-radius:50%;margin:22px auto;background:radial-gradient(circle at 35% 30%, var(--accent-2), var(--accent));transform:scale(.55);transition:transform 4s ease-in-out"></div>
      <div class="big-number" id="secs">0.0</div>
      <div class="small muted">seconds</div>
      <div class="hold-bar" aria-hidden="true"><div id="goalBar"></div></div>
      <canvas id="trace" style="width:100%;height:110px;margin-top:18px;display:block" aria-label="Hiss loudness over time"></canvas>
      <div class="chart-legend" style="justify-content:center"><span><i style="background:var(--series-1)"></i>Hiss strength (flatter is steadier)</span></div>
      <div class="row" style="justify-content:center;margin-top:10px">
        <button class="btn btn-primary btn-lg" id="go">Start</button>
      </div>
      <div id="msg" class="msg hidden"></div>
      <div id="result"></div>
    </div>`;

  const mic = new Mic();
  let running = false, raf = null;
  const levels = [];
  const canvas = $('#trace', root), g = canvas.getContext('2d');

  const draw = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    g.strokeStyle = css('--axis'); g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
    const max = Math.max(0.05, ...levels);
    g.strokeStyle = css('--series-1'); g.lineWidth = 2; g.beginPath();
    levels.forEach((v, i) => { const x = (i / Math.max(60, levels.length)) * w, y = h - (v / max) * (h - 8); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  };

  $('#go', root).addEventListener('click', async () => {
    if (running) return;
    levels.length = 0;
    $('#result', root).innerHTML = '';
    $('#secs', root).textContent = '0.0';
    $('#goalBar', root).style.width = '0';
    running = true;
    $('#go', root).disabled = true;
    // Inhale guide
    const bubble = $('#bubble', root);
    $('#phase', root).textContent = 'Breathe in… 4';
    bubble.style.transform = 'scale(1)';
    for (let n = 3; n >= 1; n--) { await sleep(1000); if (!running) return; $('#phase', root).textContent = `Breathe in… ${n}`; }
    await sleep(1000);
    $('#phase', root).textContent = 'Now hiss “sss”';

    let started = null, lastHiss = null, held = 0;
    try {
      await mic.start({
        onFrame: (buf) => {
          const now = performance.now() / 1000;
          const level = rms(buf), hissing = level > 0.01 && zeroCrossRate(buf) > 0.18;
          if (hissing) {
            if (started == null) started = now;
            lastHiss = now;
            levels.push(level);
          }
          if (started != null) {
            held = (lastHiss ?? now) - started;
            $('#secs', root).textContent = held.toFixed(1);
            $('#goalBar', root).style.width = `${Math.min(100, (held / goal) * 100)}%`;
            bubble.style.transition = 'transform .2s linear';
            bubble.style.transform = `scale(${Math.max(0.45, 1 - (held / goal) * 0.55)})`;
            if (now - lastHiss > GAP_S) stop(held);
          }
        },
      });
    } catch (err) {
      running = false; $('#go', root).disabled = false;
      showMsg($('#msg', root), micErrorMessage(err));
      return;
    }
    const loop = () => { draw(); if (running) raf = requestAnimationFrame(loop); };
    loop();
  });

  async function stop(held) {
    if (!running) return;
    running = false;
    mic.stop();
    cancelAnimationFrame(raf);
    draw();
    const bubble = $('#bubble', root);
    bubble.style.transition = 'transform 1s ease'; bubble.style.transform = 'scale(.55)';
    $('#go', root).disabled = false; $('#go', root).textContent = 'Try again';
    const mean = levels.reduce((a, b) => a + b, 0) / (levels.length || 1);
    const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / (levels.length || 1));
    const steadiness = Math.max(0, Math.min(100, Math.round(100 - (sd / (mean || 1)) * 120)));
    const reached = held >= goal;
    $('#phase', root).textContent = reached ? 'Goal reached!' : 'Well done';
    $('#result', root).innerHTML = `<div class="tiles" style="margin-top:14px;text-align:left">
      <div class="tile"><div class="label">Held for</div><div class="value">${held.toFixed(1)}s</div><div class="sub">${reached ? 'Goal reached' : `${(goal - held).toFixed(1)}s to your goal`}</div></div>
      <div class="tile"><div class="label">Steadiness</div><div class="value">${steadiness}</div><div class="sub">${steadiness >= 75 ? 'Very even airflow' : steadiness >= 50 ? 'Fairly even. Aim for a flatter line.' : 'Try keeping the hiss at one volume'}</div></div></div>`;
    await saveResult(app, 'breath', Math.round(held * 10) / 10, { steadiness, goal });
  }

  return () => { running = false; mic.stop(); cancelAnimationFrame(raf); };
}
