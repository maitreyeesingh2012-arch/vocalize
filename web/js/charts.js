// Canvas charts for Vocalize. Theme colors come from CSS custom properties so light/dark
// modes each use their own validated steps. Every chart has hover tooltips and the
// views provide a table-view twin, so no value is readable by color or hover alone.

import { midiName } from './audio.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FONT = '12px Manrope, system-ui, sans-serif';
export const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function withAlpha(color, a) {
  const c = color.trim();
  if (c.startsWith('#')) {
    const n = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const [r, g, b] = m[1].split(',').map((x) => parseFloat(x)); return `rgba(${r},${g},${b},${a})`; }
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Base: owns a canvas in `container`, handles DPR, resize, theme changes and a tooltip. */
class CanvasChart {
  constructor(container, height) {
    this.container = container;
    container.classList.add('chart');
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip hidden';
    container.append(this.canvas, this.tip);
    this.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.mq = matchMedia('(prefers-color-scheme: dark)');
    this.onTheme = () => this.draw();
    this.mq.addEventListener('change', this.onTheme);
    window.addEventListener('vq:theme', this.onTheme);
    this.canvas.addEventListener('pointermove', (e) => this._hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.hideTip(); this.draw(); });
    this.canvas.addEventListener('click', (e) => this._click(e));
  }

  resize() {
    const w = this.container.clientWidth;
    if (!w) return;
    const h = typeof this.height === 'function' ? this.height(w) : this.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this.draw();
  }

  _pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  _hover(e) { const p = this._pos(e); this.hoverX = p.x; this.hoverY = p.y; this.draw(); this.onHover?.(p); }
  _click(e) { this.onClick?.(this._pos(e)); }

  showTip(x, y, html) {
    this.tip.innerHTML = html;
    this.tip.classList.remove('hidden');
    const half = this.tip.offsetWidth / 2;
    this.tip.style.left = Math.max(half, Math.min(this.w - half, x)) + 'px';
    this.tip.style.top = Math.max(this.tip.offsetHeight + 16, y) + 'px';
  }
  hideTip() { this.tip.classList.add('hidden'); }

  destroy() {
    this.ro.disconnect();
    this.mq.removeEventListener('change', this.onTheme);
    window.removeEventListener('vq:theme', this.onTheme);
    this.container.innerHTML = '';
  }
}

// ─────────────────────────────────────────────────────────────
// Pitch map: sung contour colored by register, target notes, reference melody,
// phrases strip underneath. Click anywhere to hear that phrase.
// ─────────────────────────────────────────────────────────────

export class PitchChart extends CanvasChart {
  constructor(container, series, { onSeek } = {}) {
    super(container, (w) => (w < 560 ? 260 : 320));
    this.s = series;
    this.onSeek = onSeek;
    this.playhead = null;
    const midi = series.pitch.midi.filter((v) => v != null);
    const ref = series.reference?.contour.reference.filter((v) => v != null) || [];
    const all = midi.concat(ref);
    this.lo = Math.floor(Math.min(...all, 60)) - 2;
    this.hi = Math.ceil(Math.max(...all, 60)) + 2;
    if (all.length) { this.lo = Math.floor(Math.min(...all)) - 2; this.hi = Math.ceil(Math.max(...all)) + 2; }
    this.duration = series.duration_s;
    this.resize();
  }

  get m() { return { l: 46, r: 10, t: 10, b: 58 }; }
  x(t) { const m = this.m; return m.l + (t / this.duration) * (this.w - m.l - m.r); }
  tAt(x) { const m = this.m; return Math.max(0, Math.min(this.duration, ((x - m.l) / (this.w - m.l - m.r)) * this.duration)); }
  y(midi) { const m = this.m; const ph = this.h - m.t - m.b; return m.t + (1 - (midi - this.lo) / (this.hi - this.lo)) * ph; }
  register(midi) { const [lo, hi] = this.s.passaggio; return midi < lo ? 0 : midi > hi ? 2 : 1; }

  setPlayhead(t) { this.playhead = t; this.draw(); }

  phraseAt(t) { return (this.s.phrases || []).find(([a, b]) => t >= a - 0.15 && t <= b + 0.15) || null; }

  draw() {
    if (!this.w) return;
    const { ctx, s } = this, m = this.m;
    const colors = [cssVar('--series-1'), cssVar('--series-2'), cssVar('--series-3')];
    const grid = cssVar('--grid'), muted = cssVar('--muted'), text = cssVar('--text');
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = FONT;

    // semitone grid, labelled on naturals when there's room
    const plotH = this.h - m.t - m.b;
    const every = plotH / (this.hi - this.lo) < 11 ? 12 : 1;
    for (let n = this.lo; n <= this.hi; n++) {
      const y = Math.round(this.y(n)) + 0.5;
      const isC = n % 12 === 0;
      ctx.strokeStyle = isC ? cssVar('--axis') : grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(this.w - m.r, y); ctx.stroke();
      const natural = [0, 2, 4, 5, 7, 9, 11].includes(((n % 12) + 12) % 12);
      if ((every === 1 && natural) || isC) {
        ctx.fillStyle = isC ? text : muted;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(midiName(n), m.l - 8, y);
      }
    }

    // worst moments vs the reference
    for (const w of s.reference?.worst || []) {
      ctx.fillStyle = withAlpha(cssVar('--bad'), 0.12);
      ctx.fillRect(this.x(w.s), m.t, Math.max(2, this.x(w.e) - this.x(w.s)), plotH);
    }

    // target note lanes (where each sung note was aiming)
    for (const n of s.notes) {
      const y0 = this.y(n.target + 0.5), y1 = this.y(n.target - 0.5);
      ctx.fillStyle = withAlpha(text, 0.07);
      roundRect(ctx, this.x(n.s), y0, Math.max(2, this.x(n.e) - this.x(n.s)), y1 - y0, 4);
      ctx.fill();
    }
    for (const n of s.problem_notes || []) {
      const target = Math.round(s.notes.find((x) => Math.abs(x.s - n.s) < 0.01)?.target ?? 0);
      if (!target) continue;
      const y0 = this.y(target + 0.5), y1 = this.y(target - 0.5);
      ctx.strokeStyle = cssVar('--bad'); ctx.lineWidth = 1.5;
      roundRect(ctx, this.x(n.s), y0, Math.max(3, this.x(n.e) - this.x(n.s)), y1 - y0, 4);
      ctx.stroke();
    }

    // reference melody (under the singer's line)
    if (s.reference) {
      const c = s.reference.contour;
      ctx.strokeStyle = withAlpha(text, 0.38); ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      c.t.forEach((t, i) => {
        const v = c.reference[i];
        if (v == null) { pen = false; return; }
        const x = this.x(t), y = this.y(v);
        pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        pen = true;
      });
      ctx.stroke();
    }

    // sung contour colored by register
    const dt = s.pitch.dt;
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let prev = null;
    s.pitch.midi.forEach((v, i) => {
      if (v == null) { prev = null; return; }
      const pt = { x: this.x(i * dt), y: this.y(v), reg: this.register(v) };
      if (prev) {
        ctx.strokeStyle = colors[pt.reg];
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
      }
      prev = pt;
    });

    // time axis
    const axisY = this.h - m.b + 0.5;
    ctx.strokeStyle = cssVar('--axis'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m.l, axisY); ctx.lineTo(this.w - m.r, axisY); ctx.stroke();
    ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = this.duration > 60 ? 10 : this.duration > 20 ? 5 : 2;
    for (let t = 0; t <= this.duration; t += step) ctx.fillText(fmtTime(t), this.x(t), axisY + 5);

    // phrases strip
    const py = this.h - 24;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Phrases', 2, py + 6);
    for (const [a, b] of s.phrases || []) {
      const len = b - a;
      ctx.fillStyle = cssVar(len >= 4 ? '--good' : len >= 2 ? '--warn' : '--bad');
      roundRect(ctx, this.x(a) + 1, py, Math.max(3, this.x(b) - this.x(a) - 2), 12, 4);
      ctx.fill();
    }

    // playhead
    if (this.playhead != null) {
      const x = Math.round(this.x(this.playhead)) + 0.5;
      ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, this.h - 10); ctx.stroke();
    }

    // hover crosshair + tooltip
    if (this.hoverX != null && this.hoverX >= m.l) {
      const t = this.tAt(this.hoverX);
      const x = this.x(t);
      ctx.strokeStyle = withAlpha(text, 0.4); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, m.t); ctx.lineTo(x + 0.5, this.h - m.b); ctx.stroke();
      const v = s.pitch.midi[Math.round(t / dt)];
      const note = s.notes.find((n) => t >= n.s && t <= n.e);
      const phrase = this.phraseAt(t);
      let html = `<b>${fmtTime(t)}</b>`;
      if (v != null) {
        const reg = ['Chest voice', 'Mix / passaggio', 'Head voice'][this.register(v)];
        html += `${midiName(v)} · ${reg}`;
        ctx.fillStyle = colors[this.register(v)];
        ctx.strokeStyle = cssVar('--surface'); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, this.y(v), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        html += 'Not singing';
      }
      if (note) html += `<br>Aiming for ${note.name}: ${Math.abs(note.cents) < 5 ? 'right on' : `${Math.abs(Math.round(note.cents))}¢ ${note.cents > 0 ? 'sharp' : 'flat'}`}`;
      if (s.reference) {
        const c = s.reference.contour, k = Math.min(c.t.length - 1, Math.round(t / (c.t[1] - c.t[0] || 0.05)));
        if (c.reference[k] != null) html += `<br>Original: ${midiName(c.reference[k])}`;
      }
      if (phrase) html += `<br><span style="color:var(--muted)">Click to replay this phrase</span>`;
      this.showTip(x, m.t + 30, html);
    }
  }

  onClick(p) {
    if (p.x < this.m.l || !this.onSeek) return;
    const t = this.tAt(p.x);
    const phrase = this.phraseAt(t);
    this.onSeek(phrase ? phrase[0] : t, phrase ? phrase[1] : null);
  }
}

// ─────────────────────────────────────────────────────────────
// Loudness over time (single series)
// ─────────────────────────────────────────────────────────────

export class LoudnessChart extends CanvasChart {
  constructor(container, series, { onSeek } = {}) {
    super(container, 150);
    this.s = series; this.onSeek = onSeek; this.playhead = null;
    this.resize();
  }
  get m() { return { l: 46, r: 10, t: 8, b: 24 }; }
  x(t) { return this.m.l + (t / this.s.duration_s) * (this.w - this.m.l - this.m.r); }
  y(db) { const m = this.m; return m.t + (-db / 60) * (this.h - m.t - m.b); }
  setPlayhead(t) { this.playhead = t; this.draw(); }

  draw() {
    if (!this.w) return;
    const { ctx } = this, m = this.m, { db, dt } = this.s.loudness;
    const c1 = cssVar('--series-1'), muted = cssVar('--muted');
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = FONT;
    for (const level of [0, -20, -40, -60]) {
      const y = Math.round(this.y(level)) + 0.5;
      ctx.strokeStyle = level === -60 ? cssVar('--axis') : cssVar('--grid');
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(this.w - m.r, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(`${level} dB`, m.l - 6, y);
    }
    const base = this.y(-60);
    ctx.beginPath(); ctx.moveTo(this.x(0), base);
    db.forEach((v, i) => ctx.lineTo(this.x(i * dt), this.y(v)));
    ctx.lineTo(this.x((db.length - 1) * dt), base); ctx.closePath();
    ctx.fillStyle = withAlpha(c1, 0.18); ctx.fill();
    ctx.beginPath();
    db.forEach((v, i) => (i ? ctx.lineTo(this.x(i * dt), this.y(v)) : ctx.moveTo(this.x(0), this.y(v))));
    ctx.strokeStyle = c1; ctx.lineWidth = 2; ctx.stroke();

    ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = this.s.duration_s > 60 ? 10 : this.s.duration_s > 20 ? 5 : 2;
    for (let t = 0; t <= this.s.duration_s; t += step) ctx.fillText(fmtTime(t), this.x(t), this.h - m.b + 6);

    if (this.playhead != null) {
      const x = Math.round(this.x(this.playhead)) + 0.5;
      ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, this.h - m.b); ctx.stroke();
    }
    if (this.hoverX != null && this.hoverX >= m.l) {
      const t = Math.max(0, Math.min(this.s.duration_s, ((this.hoverX - m.l) / (this.w - m.l - m.r)) * this.s.duration_s));
      const v = db[Math.min(db.length - 1, Math.round(t / dt))];
      const x = this.x(t);
      ctx.strokeStyle = withAlpha(cssVar('--text'), 0.4); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, m.t); ctx.lineTo(x + 0.5, this.h - m.b); ctx.stroke();
      ctx.fillStyle = c1; ctx.strokeStyle = cssVar('--surface'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, this.y(v), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      this.showTip(x, this.y(v), `<b>${fmtTime(t)}</b>${v.toFixed(0)} dB from your loudest`);
    }
  }
  onClick(p) {
    if (p.x < this.m.l || !this.onSeek) return;
    this.onSeek(((p.x - this.m.l) / (this.w - this.m.l - this.m.r)) * this.s.duration_s, null);
  }
}

// ─────────────────────────────────────────────────────────────
// Progress line: one series over sessions (overall score or one area)
// ─────────────────────────────────────────────────────────────

export class LineChart extends CanvasChart {
  /** points: [{label, value, sub}] in time order. */
  constructor(container, points, { height = 220, min = 0, max = 100, unit = '', compact = false, color = '--series-1' } = {}) {
    super(container, height);
    Object.assign(this, { points, min, max, unit, compact, color });
    this.resize();
  }
  get m() { return this.compact ? { l: 4, r: 8, t: 6, b: 6 } : { l: 36, r: 14, t: 12, b: 26 }; }
  x(i) { const m = this.m; const n = this.points.length; return m.l + (n <= 1 ? 0.5 : i / (n - 1)) * (this.w - m.l - m.r); }
  y(v) { const m = this.m; return m.t + (1 - (v - this.min) / (this.max - this.min)) * (this.h - m.t - m.b); }
  nearest(x) {
    let best = 0, bd = Infinity;
    this.points.forEach((p, i) => { const d = Math.abs(this.x(i) - x); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  draw() {
    if (!this.w) return;
    const { ctx, points } = this, m = this.m, col = cssVar(this.color);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = FONT;
    if (!this.compact) {
      for (const v of [0, 25, 50, 75, 100]) {
        const y = Math.round(this.y(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? cssVar('--axis') : cssVar('--grid'); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(this.w - m.r, y); ctx.stroke();
        ctx.fillStyle = cssVar('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(String(v), m.l - 8, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const every = Math.ceil(points.length / Math.max(1, Math.floor((this.w - 60) / 70)));
      points.forEach((p, i) => { if (i % every === 0 || i === points.length - 1) ctx.fillText(p.label, this.x(i), this.h - m.b + 7); });
    }
    const valid = points.map((p, i) => [p, i]).filter(([p]) => p.value != null);
    if (!valid.length) return;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    valid.forEach(([p, i], k) => (k ? ctx.lineTo(this.x(i), this.y(p.value)) : ctx.moveTo(this.x(i), this.y(p.value))));
    ctx.stroke();
    const r = this.compact ? 2.5 : 4;
    const surface = cssVar('--surface');
    for (const [p, i] of valid) {
      if (this.compact && i !== points.length - 1) continue;
      ctx.fillStyle = col; ctx.strokeStyle = surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.x(i), this.y(p.value), r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (this.hoverX != null) {
      const i = this.nearest(this.hoverX), p = points[i];
      if (p.value == null) return;
      ctx.fillStyle = col; ctx.strokeStyle = surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.x(i), this.y(p.value), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      this.showTip(this.x(i), this.y(p.value), `<b>${Math.round(p.value)}${this.unit}</b>${p.sub || p.label}`);
    }
  }
  onClick(p) { if (this.onPick) this.onPick(this.points[this.nearest(p.x)], this.nearest(p.x)); }
}

// ─────────────────────────────────────────────────────────────
// SVG widgets
// ─────────────────────────────────────────────────────────────

/** Semicircle gauge with an ideal band; value outside [min,max] is clamped. */
export function gauge({ value, min, max, ideal, label, unit, decimals = 1 }) {
  const W = 200, H = 120, cx = 100, cy = 100, r = 80;
  const ang = (v) => Math.PI * (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min));
  const pt = (a, rr = r) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  const arc = (a0, a1) => { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`; };
  const inIdeal = value >= ideal[0] && value <= ideal[1];
  const [nx, ny] = pt(ang(value), r - 18);
  return `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}: ${value.toFixed(decimals)} ${unit}, ideal ${ideal[0]}–${ideal[1]} ${unit}" style="width:100%;max-width:220px;display:block;margin:auto">
    <path d="${arc(Math.PI, 0)}" fill="none" stroke="var(--surface-3)" stroke-width="14" stroke-linecap="round"/>
    <path d="${arc(ang(ideal[0]), ang(ideal[1]))}" fill="none" stroke="var(--good)" stroke-opacity=".45" stroke-width="14"/>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="var(--text)"/>
    <text x="${cx}" y="${cy - 26}" text-anchor="middle" font-size="20" font-weight="800" fill="var(--text)" font-family="Manrope, system-ui">${value.toFixed(decimals)}${unit}</text>
  </svg>
  <div style="text-align:center;font-size:13px;margin-top:4px"><b>${label}</b><br>
    <span class="status ${inIdeal ? 'good' : 'warn'}">${inIdeal ? 'In the ideal range' : 'Outside the ideal range'}</span>
    <div class="muted small">Ideal ${ideal[0]}–${ideal[1]}${unit}</div></div>`;
}

/** Piano keyboard (SVG) with a highlighted range, passaggio band and optional previous range. */
export function keyboard({ from = 36, to = 84, low = null, high = null, passaggio = null, previous = null, live = null }) {
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const whites = [];
  for (let m = from; m <= to; m++) if (!isBlack(m)) whites.push(m);
  const kw = 22, kh = 110, W = whites.length * kw, H = kh + 34;
  const xOf = {};
  whites.forEach((m, i) => { xOf[m] = i * kw; });
  for (let m = from; m <= to; m++) if (isBlack(m)) xOf[m] = xOf[m - 1] + kw * 0.68;
  const inRange = (m) => low != null && high != null && m >= low && m <= high;
  let svg = `<svg class="keyboard" viewBox="0 0 ${W} ${H}" role="img" aria-label="Piano keyboard${low != null ? ` showing your range ${midiName(low)} to ${midiName(high)}` : ''}">`;
  if (passaggio) {
    const x0 = xOf[passaggio[0]] ?? 0, x1 = (xOf[passaggio[1]] ?? W) + kw;
    svg += `<rect x="${x0}" y="${kh + 6}" width="${Math.max(0, x1 - x0)}" height="6" rx="3" fill="var(--series-2)"/>`;
    svg += `<text x="${(x0 + x1) / 2}" y="${kh + 26}" text-anchor="middle" font-size="11" fill="var(--muted)" font-family="Manrope, system-ui">passaggio</text>`;
  }
  for (const m of whites) {
    const fill = m === live ? 'var(--accent-2)' : inRange(m) ? 'var(--accent)' : 'var(--surface)';
    svg += `<rect x="${xOf[m] + 0.5}" y="0.5" width="${kw - 1}" height="${kh}" rx="3" fill="${fill}" stroke="var(--line-strong)"/>`;
    if (m % 12 === 0) svg += `<text x="${xOf[m] + kw / 2}" y="${kh - 8}" text-anchor="middle" font-size="9" fill="${inRange(m) ? 'var(--accent-ink)' : 'var(--muted)'}" font-family="Manrope, system-ui">${midiName(m)}</text>`;
  }
  for (let m = from; m <= to; m++) {
    if (!isBlack(m)) continue;
    const fill = m === live ? 'var(--accent-2)' : inRange(m) ? 'color-mix(in srgb, var(--accent) 70%, #000)' : 'var(--text)';
    svg += `<rect x="${xOf[m]}" y="0" width="${kw * 0.64}" height="${kh * 0.62}" rx="2" fill="${fill}"/>`;
  }
  if (previous && previous.low != null) {
    const x0 = xOf[previous.low] ?? 0, x1 = (xOf[previous.high] ?? W - kw) + kw;
    svg += `<rect x="${x0}" y="1" width="${x1 - x0}" height="${kh - 2}" fill="none" stroke="var(--text)" stroke-dasharray="4 3" stroke-width="1.5" rx="4"/>`;
  }
  return svg + '</svg>';
}
