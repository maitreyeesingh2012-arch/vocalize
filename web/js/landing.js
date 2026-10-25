/* Landing hero: a melody traced over a staff, the way Vocalize's pitch tracker "hears" it. */
(() => {
  const canvas = document.getElementById('scoreCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const GOLD = '216,178,110', GOLD2 = '240,213,155', IVORY = '244,236,221', ROSE = '217,138,154', VIOLET = '143,122,214';
  let W = 0, H = 0, dpr = 1, layout = null, melody = null, cycleStart = 0, running = false, visible = true;
  const DRAW_MS = 7500, HOLD_MS = 2600, FADE_MS = 1400, CYCLE_MS = DRAW_MS + HOLD_MS + FADE_MS;

  const motes = Array.from({ length: 36 }, () => ({
    x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + .3,
    vx: (Math.random() - .5) * .00004, vy: -Math.random() * .00006 - .00001, a: Math.random() * .5 + .15,
  }));

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gap = Math.max(12, Math.min(22, H * 0.026));
    // Keep the melody clear of the headline copy: start it after the text column (plus room for the clef).
    const copy = document.querySelector('.l-hero-copy');
    const copyRight = copy ? copy.getBoundingClientRect().right - rect.left : W * 0.5;
    const copyBottom = copy ? copy.getBoundingClientRect().bottom - rect.top : H * 0.8;
    const sideX0 = copyRight + gap * 6;
    const wide = W - 70 - sideX0 >= 320;
    // Narrow screens: the staff runs underneath the copy, in the hero's bottom padding.
    canvas.parentElement.classList.toggle('narrow', !wide);
    layout = {
      wide, gap,
      bottom: wide ? H * 0.60 + gap * 2 : Math.min(H - gap * 1.5, copyBottom + gap * 6),
      x0: wide ? sideX0 : gap * 7,
      x1: W - (wide ? 70 : 24),
      alpha: wide ? 1 : 0.5,
    };
    if (!melody) melody = makeMelody();
    if (reduceMotion) drawFrame(DRAW_MS + 1);
  }

  const yOf = (step) => layout.bottom - step * layout.gap / 2;

  function makeMelody() {
    const notes = [];
    let step = 3 + Math.floor(Math.random() * 3);
    const n = 8;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const leap = [1, 1, 2, 2, 3, 4][Math.floor(Math.random() * 6)] * (Math.random() < .5 ? -1 : 1);
        step = Math.max(-1, Math.min(9, step + leap));
      }
      notes.push({ step, weight: Math.random() < .3 ? 2 : 1, seed: Math.random() * 1000 });
    }
    notes[n - 1].weight = 2.4; // let the final note ring
    const total = notes.reduce((s, x) => s + x.weight, 0);
    let acc = 0;
    for (const nt of notes) { nt.a = acc / total; acc += nt.weight; nt.b = acc / total; }
    return notes;
  }

  // Pitch (in staff steps) at normalised position u ∈ [0,1] along the phrase.
  function pitchAt(u) {
    const notes = melody;
    let i = notes.findIndex(nt => u <= nt.b);
    if (i < 0) i = notes.length - 1;
    const nt = notes[i], prev = notes[i - 1] || nt;
    const local = (u - nt.a) / (nt.b - nt.a);
    const glide = 0.2;
    let p;
    if (local < glide) {
      const t = local / glide, s = t * t * (3 - 2 * t);
      p = prev.step + (nt.step - prev.step) * s;
      // a singer's tiny overshoot at the end of a scoop
      p += Math.sin(t * Math.PI) * 0.12 * Math.sign(nt.step - prev.step);
    } else {
      const t = (local - glide) / (1 - glide);
      const vibAmp = 0.34 * Math.min(1, Math.max(0, (t - 0.25) / 0.35));
      const px = u * (layout.x1 - layout.x0);
      p = nt.step + Math.sin(px / 7.5 + nt.seed) * vibAmp + Math.sin(px / 41 + nt.seed) * 0.05;
    }
    return p;
  }

  function strokeCurve(uEnd, offsetY, width, color, blur) {
    const { x0, x1 } = layout;
    const xEnd = x0 + (x1 - x0) * uEnd;
    ctx.beginPath();
    for (let x = x0; x <= xEnd; x += 2) {
      const u = (x - x0) / (x1 - x0);
      const y = yOf(pitchAt(u)) + offsetY;
      x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowBlur = blur; ctx.shadowColor = `rgba(${GOLD},.8)`;
    ctx.stroke();
    ctx.shadowBlur = 0;
    return xEnd;
  }

  function drawStaff(fade) {
    const { gap, bottom } = layout;
    for (let k = 0; k < 5; k++) {
      const y = bottom - k * gap;
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, `rgba(${IVORY},0)`);
      g.addColorStop(layout.wide ? .42 : .05, `rgba(${IVORY},${.05 * fade})`);
      g.addColorStop(.62, `rgba(${IVORY},${.22 * fade})`);
      g.addColorStop(1, `rgba(${IVORY},${.08 * fade})`);
      ctx.strokeStyle = g; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke();
    }
    // treble clef
    ctx.save();
    ctx.fillStyle = `rgba(${IVORY},${.55 * fade})`;
    ctx.font = `${gap * 6.6}px "Segoe UI Symbol", "Noto Music", "Cormorant Garamond", serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('𝄞', layout.x0 - gap * 5, bottom + gap * 1.45);
    ctx.restore();
  }

  function drawNote(nt, age, fade) {
    const { gap, x0, x1 } = layout;
    const u = nt.a + (nt.b - nt.a) * 0.32;
    const x = x0 + (x1 - x0) * u, y = yOf(nt.step);
    const appear = Math.min(1, age / 500);
    // ripple
    if (age < 1600) {
      const t = age / 1600;
      ctx.beginPath(); ctx.arc(x, y, gap * (0.8 + t * 3.2), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${GOLD2},${(1 - t) * .5 * fade})`; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-0.35);
    ctx.beginPath(); ctx.ellipse(0, 0, gap * .62 * appear, gap * .44 * appear, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${IVORY},${.92 * fade})`;
    ctx.shadowBlur = 16; ctx.shadowColor = `rgba(${GOLD2},.6)`;
    ctx.fill();
    ctx.restore();
    // stem
    const up = nt.step < 4;
    const sx = x + (up ? gap * .56 : -gap * .56);
    ctx.beginPath(); ctx.moveTo(sx, y + (up ? -gap * .1 : gap * .1));
    ctx.lineTo(sx, y + (up ? -1 : 1) * gap * 3.3 * appear);
    ctx.strokeStyle = `rgba(${IVORY},${.8 * fade})`; ctx.lineWidth = 1.3; ctx.stroke();
  }

  function drawMotes(dt) {
    for (const m of motes) {
      if (!reduceMotion) {
        m.x += m.vx * dt; m.y += m.vy * dt;
        if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
        if (m.x < -0.02) m.x = 1.02; if (m.x > 1.02) m.x = -0.02;
      }
      ctx.beginPath(); ctx.arc(m.x * W, m.y * H, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${GOLD2},${m.a * .6})`; ctx.fill();
    }
  }

  let last = 0;
  function drawFrame(t, dt = 16) {
    ctx.clearRect(0, 0, W, H);
    drawMotes(dt);
    const fade = t < DRAW_MS + HOLD_MS ? 1 : Math.max(0, 1 - (t - DRAW_MS - HOLD_MS) / FADE_MS);
    ctx.globalAlpha = layout.alpha;
    drawStaff(1);
    ctx.globalAlpha = layout.alpha * fade;

    const prog = Math.min(1, t / DRAW_MS);
    const eased = 1 - Math.pow(1 - prog, 1.4);
    // overtones: faint echoes of the melody, like harmonics above the fundamental
    strokeCurve(eased, -layout.gap * 2.2, 1, `rgba(${VIOLET},.22)`, 0);
    strokeCurve(eased, -layout.gap * 3.9, .8, `rgba(${ROSE},.14)`, 0);
    // the melody itself
    const grad = ctx.createLinearGradient(layout.x0, 0, layout.x1, 0);
    grad.addColorStop(0, `rgba(${GOLD},.95)`); grad.addColorStop(.6, `rgba(${GOLD2},1)`); grad.addColorStop(1, `rgba(${ROSE},.95)`);
    const xEnd = strokeCurve(eased, 0, 2.4, grad, 18);

    // the pen: a glowing point at the leading edge
    if (prog < 1) {
      const y = yOf(pitchAt(eased));
      const halo = ctx.createRadialGradient(xEnd, y, 0, xEnd, y, 26);
      halo.addColorStop(0, `rgba(${GOLD2},.9)`); halo.addColorStop(1, `rgba(${GOLD2},0)`);
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(xEnd, y, 26, 0, Math.PI * 2); ctx.fill();
    }

    for (const nt of melody) {
      const at = nt.a + (nt.b - nt.a) * 0.32;
      if (eased >= at) {
        const reachedAt = DRAW_MS * (1 - Math.pow(1 - at, 1 / 1.4));
        drawNote(nt, reduceMotion ? 5000 : t - reachedAt, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    if (!running) return;
    if (!cycleStart) cycleStart = now;
    let t = now - cycleStart;
    if (t > CYCLE_MS) { cycleStart = now; t = 0; melody = makeMelody(); }
    drawFrame(t, last ? now - last : 16);
    last = now;
    requestAnimationFrame(loop);
  }

  function setRunning(on) {
    if (reduceMotion) return;
    if (on && !running) { running = true; last = 0; requestAnimationFrame(loop); }
    if (!on) running = false;
  }

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; setRunning(visible && !document.hidden); }).observe(canvas);
  document.addEventListener('visibilitychange', () => setRunning(visible && !document.hidden));
  resize();
  setRunning(true);

  // Reveal-on-scroll for landing sections
  const io = new IntersectionObserver((entries) => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
})();
