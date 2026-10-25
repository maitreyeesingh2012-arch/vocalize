// Audio toolkit: microphone capture, WAV encoding, real-time pitch (YIN) and a small piano synth.

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export function midiName(m, { octave = true } = {}) {
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (octave ? Math.floor(r / 12) - 1 : '');
}
export function noteParts(m) {
  const r = Math.round(m);
  return { name: NOTE_NAMES[((r % 12) + 12) % 12], octave: Math.floor(r / 12) - 1 };
}

// ── Microphone ────────────────────────────────────────────

export function micErrorMessage(err) {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser can’t use the microphone. Try Chrome, Safari or Edge.';
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')
    return 'Microphone access is blocked. Allow it in your browser or phone settings, then try again.';
  if (err?.name === 'NotFoundError') return 'No microphone found. Plug one in and try again.';
  return 'Could not start the microphone.';
}

export class Mic {
  constructor() { this.ctx = null; this.stream = null; this.chunks = []; this.running = false; }

  async start({ onFrame, record = false, bufferSize = 2048 } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(bufferSize, 1, 1);
    this.record = record;
    this.chunks = [];
    this.node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      if (this.record) this.chunks.push(new Float32Array(data));
      if (onFrame) onFrame(data, this.ctx.sampleRate);
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);   // output stays silent; needed to keep the node running
    this.running = true;
    return this.ctx.sampleRate;
  }

  stop() {
    if (!this.running) return null;
    this.running = false;
    this.node.onaudioprocess = null;
    try { this.node.disconnect(); this.source.disconnect(); } catch { /* already disconnected */ }
    this.stream.getTracks().forEach((t) => t.stop());
    const sampleRate = this.ctx.sampleRate;
    this.ctx.close();
    if (!this.record) return null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { samples.set(c, off); off += c.length; }
    this.chunks = [];
    return { samples, sampleRate };
  }
}

export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// ── YIN pitch detection (de Cheveigné & Kawahara, 2002) ────

export function detectPitch(buf, sampleRate, { fmin = 60, fmax = 1300, threshold = 0.12 } = {}) {
  const maxTau = Math.min(Math.floor(sampleRate / fmin), Math.floor(buf.length / 2));
  const minTau = Math.max(2, Math.floor(sampleRate / fmax));
  const W = buf.length - maxTau;
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; sum += x * x; }
    d[tau] = sum;
  }
  // cumulative mean normalised difference
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= maxTau; tau++) { running += d[tau]; d[tau] = d[tau] * tau / (running || 1); }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // parabolic interpolation around the minimum
  const x0 = tau > 1 ? d[tau - 1] : d[tau], x2 = tau < maxTau ? d[tau + 1] : d[tau];
  const denom = x0 + x2 - 2 * d[tau];
  const better = denom ? tau + (x0 - x2) / (2 * denom) : tau;
  return { freq: sampleRate / better, clarity: 1 - d[tau] };
}

/**
 * Live pitch from the microphone. onPitch receives
 * { t, freq, midi, cents, clarity, level } (freq/midi null when not singing).
 */
export class PitchStream {
  constructor({ onPitch, onLevel, fmin = 60, fmax = 1300, gate = 0.012 } = {}) {
    Object.assign(this, { onPitch, onLevel, fmin, fmax, gate });
    this.mic = new Mic();
    this.recent = [];
    this.t0 = 0;
  }

  async start({ record = false } = {}) {
    this.t0 = performance.now();
    this.recent = [];
    return this.mic.start({ record, bufferSize: 2048, onFrame: (buf, sr) => this._frame(buf, sr) });
  }

  stop() { return this.mic.stop(); }

  _frame(buf, sr) {
    const level = rms(buf);
    if (this.onLevel) this.onLevel(level);
    const t = (performance.now() - this.t0) / 1000;
    let out = { t, freq: null, midi: null, cents: null, clarity: 0, level };
    if (level > this.gate) {
      const p = detectPitch(buf, sr, { fmin: this.fmin, fmax: this.fmax });
      if (p && p.clarity > 0.8) {
        this.recent.push(p.freq);
        if (this.recent.length > 3) this.recent.shift();
        const freq = [...this.recent].sort((a, b) => a - b)[Math.floor(this.recent.length / 2)];
        const midi = freqToMidi(freq);
        out = { t, freq, midi, cents: (midi - Math.round(midi)) * 100, clarity: p.clarity, level };
      } else {
        this.recent = [];
      }
    } else {
      this.recent = [];
    }
    if (this.onPitch) this.onPitch(out);
  }
}

// ── Piano ──────────────────────────────────────────────────

let sharedCtx = null;
export function audioContext() {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sharedCtx.state === 'suspended') sharedCtx.resume();
  return sharedCtx;
}

export class Piano {
  constructor() {
    this.ctx = audioContext();
    this.out = this.ctx.createDynamicsCompressor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.out);
    this.out.connect(this.ctx.destination);
    this.voices = [];
  }

  /** Schedule one note; `when` is seconds from now. */
  note(midi, when = 0, dur = 0.8, vel = 0.8) {
    const ctx = this.ctx, t = ctx.currentTime + when, f = midiToFreq(midi);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(9000, f * 9), t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(400, f * 2.5), t + dur + 0.6);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.008);
    env.gain.exponentialRampToValueAtTime(vel * 0.22, t + 0.35);
    env.gain.setTargetAtTime(0.0001, t + dur, 0.18);
    filter.connect(env).connect(this.master);
    const partials = [[1, 1], [2, 0.42], [3, 0.2], [4, 0.1], [5, 0.05]];
    for (const [n, amp] of partials) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = n === 1 ? 'triangle' : 'sine';
      o.frequency.value = f * n * (1 + (n - 1) * 0.0007);   // a touch of piano-string inharmonicity
      g.gain.value = amp;
      o.connect(g).connect(filter);
      o.start(t);
      o.stop(t + dur + 1.2);
      this.voices.push(o);
    }
    return t + dur;
  }

  /** Play [{midi, dur}] in sequence (or chords with {midi: [..]}); returns total seconds. */
  sequence(notes, { start = 0.05, gap = 0.04 } = {}) {
    let at = start;
    for (const n of notes) {
      for (const m of [].concat(n.midi)) if (m != null) this.note(m, at, n.dur * 0.95);
      at += n.dur + gap;
    }
    return at;
  }

  stopAll() {
    const now = this.ctx.currentTime;
    for (const o of this.voices) { try { o.stop(now + 0.02); } catch { /* already stopped */ } }
    this.voices = [];
  }
}
