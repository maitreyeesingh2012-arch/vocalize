// Session list and the full session report.
import { api, audioObjectUrl } from '../api.js';
import { LoudnessChart, PitchChart, fmtTime, gauge } from '../charts.js';
import { $, $$, confirmDialog, esc, fmtDate, fmtShortDate, icons, statusFor, toast } from '../ui.js';

export async function render(root, params, app) {
  return params[0] ? renderReport(root, Number(params[0]), app, { shared: false }) : renderList(root, app);
}

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

async function renderList(root, app) {
  const { sessions } = await api('/api/history');
  root.innerHTML = `
    <div class="page-head">
      <div><div class="kicker">Your sessions</div><h1>Every take, <em>remembered</em></h1></div>
      <a class="btn btn-primary" href="#/record">${icons.mic} New session</a>
    </div>
    <div class="card">
      ${sessions.length ? `<ul class="list">${sessions.map((s) => {
        const st = statusFor(s.overall_score);
        return `<li><a class="list-row" href="#/sessions/${s.id}">
          <div style="flex:1;min-width:0">
            <div class="title">${esc(s.label || 'Session')}</div>
            <div class="sub">${esc(fmtDate(s.timestamp))}${s.voice_type ? ` · ${esc(s.voice_type)}` : ''}${s.reference_song ? ` · ♪ ${esc(s.reference_song)}` : ''}${s.has_audio ? '' : ' · no recording'}</div>
          </div>
          <span class="status ${st.cls}">${st.label}</span>
          <span class="score-num">${s.overall_score != null ? Math.round(s.overall_score) : '–'}</span>
        </a></li>`;
      }).join('')}</ul>` : `<div class="empty"><span class="serif">No sessions yet</span>Record your first take to see your report here.<br><br><a class="btn btn-primary" href="#/record">Record now</a></div>`}
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Report (also used by the public share page)
// ─────────────────────────────────────────────────────────────

const AREAS = [
  ['intonation', 'Pitch accuracy'], ['stability', 'Pitch stability'], ['vibrato', 'Vibrato'],
  ['breath', 'Breath support'], ['resonance', 'Resonance & tone'], ['dynamics', 'Dynamic control'],
  ['passaggio', 'Register changes'],
];
const SEV_ORDER = ['critical', 'warning', 'info', 'praise'];
const SEV_LABEL = { critical: 'Focus', warning: 'Improve', info: 'Note', praise: 'Strength' };

export async function renderReport(root, id, app, { shared = false, payload = null, audioPath = null } = {}) {
  if (!payload) payload = (await api(`/api/session/${id}`)).payload;
  const s = payload.session, series = payload.series, ref = payload.reference;
  const overall = s.overall_score != null ? Math.round(s.overall_score) : null;
  const st = statusFor(overall);
  const cleanups = [];

  root.innerHTML = `
    ${shared ? '' : `<a class="btn btn-quiet btn-sm no-print" href="#/sessions" style="margin-bottom:10px">${icons.back} All sessions</a>`}
    <div class="card">
      <div class="report-head">
        <div class="ring" aria-label="Overall score ${overall ?? 'not available'} out of 100">
          <svg width="132" height="132" viewBox="0 0 132 132">
            <circle cx="66" cy="66" r="56" fill="none" stroke="var(--surface-3)" stroke-width="10"/>
            <circle cx="66" cy="66" r="56" fill="none" stroke="${st.color}" stroke-width="10" stroke-linecap="round"
              stroke-dasharray="351.9" stroke-dashoffset="${351.9 * (1 - (overall || 0) / 100)}"/>
          </svg>
          <div class="val"><div><div class="num">${overall ?? '–'}</div><div class="of">overall</div></div></div>
        </div>
        <div style="flex:1;min-width:220px">
          ${payload.singer ? `<div class="kicker">${esc(payload.singer)}</div>` : ''}
          <h1 class="display" id="title">${esc(s.label || 'Session')}</h1>
          <div class="muted small" style="margin-top:4px">${esc(fmtDate(s.timestamp))}</div>
          ${(s.score_source || '').startsWith('rejected:') ? `<p class="small" style="margin:10px 0 0;color:var(--warn-text)">${s.score_source === 'rejected:detection'
            ? 'No singing detected (this sounds like instrumental music, speech or noise), so it has not been scored.'
            : 'The singing is too hard to hear over the background noise to score fairly. Try again somewhere quieter.'}</p>` : ''}
          <div class="row" style="margin-top:10px">
            <span class="status ${st.cls}">${st.label}</span>
            ${s.voice_type ? `<span class="chip" style="cursor:default">Voice type: ${esc(s.voice_type)}</span>` : ''}
            ${s.duration_s ? `<span class="chip" style="cursor:default">${s.duration_s.toFixed(1)}s</span>` : ''}
            ${s.reference_song ? `<span class="chip" style="cursor:default">♪ ${esc(s.reference_song)}</span>` : ''}
          </div>
        </div>
        ${shared ? '' : `<div class="row no-print">
          <button class="btn btn-sm" id="shareBtn">${icons.share} Share</button>
          <button class="btn btn-sm" id="planBtn">${icons.plan} Plan from this</button>
          ${s.has_audio ? `<button class="btn btn-sm" id="rescoreBtn" title="Score this recording again with the latest scoring">↻ Re-score</button>` : ''}
          <button class="icon-btn" id="renameBtn" aria-label="Rename session">✎</button>
          <button class="icon-btn" id="deleteBtn" aria-label="Delete session">${icons.trash}</button>
        </div>`}
      </div>
      ${s.has_audio ? `
      <div class="player no-print" style="margin-top:20px" id="player">
        <button class="play-btn" id="playBtn" aria-label="Play recording">${icons.play}</button>
        <input type="range" id="scrub" min="0" max="${s.duration_s || 1}" step="0.01" value="0" aria-label="Position">
        <span class="time" id="time">0:00 / ${fmtTime(s.duration_s || 0)}</span>
      </div>
      <div class="small muted no-print" id="phraseNote" style="margin-top:8px">Tip: click the pitch map to hear any phrase on its own.</div>
      ${shared ? '' : `<div class="row no-print" style="margin-top:10px"><label class="small muted" for="compareSel">Compare with another take</label>
        <select id="compareSel" style="width:auto;min-width:200px;padding:6px 10px"><option value="">Choose a session…</option></select>
        <button class="btn btn-sm hidden" id="playB">${icons.play} Play other take</button></div>`}` : ''}
    </div>

    <div class="tiles" style="margin-top:16px" id="tiles"></div>

    ${ref ? `
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Compared with the original</h2><span class="muted small">${esc(s.reference_song || '')}</span></div>
      <div class="tiles">
        ${tile('Melody accuracy', `${Math.round(ref.melody_accuracy)}%`, 'of sung moments within a quarter-tone', ref.melody_accuracy)}
        ${tile('Timing', `${Math.round(ref.rhythm_accuracy)}`, Math.abs(ref.early_late_ms) < 20 ? 'right with the beat' : `${Math.abs(Math.round(ref.early_late_ms))} ms ${ref.early_late_ms > 0 ? 'late' : 'early'} on average`, ref.rhythm_accuracy)}
        ${tile('Average distance', `${Math.round(ref.pitch_dev_cents)}¢`, 'from the original melody', null)}
        ${tile('Missed notes', `${Math.round(ref.missed_pct)}%`, 'where the song sings and you rest', null)}
      </div>
      ${series?.reference?.worst?.length ? `<h3 style="margin:16px 0 8px">Moments to practice</h3>
        <div class="chips">${series.reference.worst.map((w) => `<button class="chip" data-seek="${w.s}" data-end="${w.e}">${esc(w.text)}</button>`).join('')}</div>` : ''}
    </div>` : ''}

    ${series ? `
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Pitch map</h2>
        <button class="btn btn-quiet btn-sm table-toggle" id="pitchTableBtn" aria-expanded="false">View as table</button></div>
      <div class="chart-legend">
        <span><i style="background:var(--series-1)"></i>Chest voice</span>
        <span><i style="background:var(--series-2)"></i>Mix / passaggio</span>
        <span><i style="background:var(--series-3)"></i>Head voice</span>
        ${series.reference ? '<span><i style="background:var(--text);opacity:.4;height:5px"></i>Original melody</span>' : ''}
        <span><i class="band" style="background:var(--text);opacity:.15"></i>Target note</span>
        ${series.problem_notes?.length ? '<span><i class="band" style="border:1.5px solid var(--bad);background:none"></i>Off by 35¢+</span>' : ''}
        <span><i class="dot" style="background:var(--good)"></i>Phrase 4s+</span>
        <span><i class="dot" style="background:var(--warn)"></i>2–4s</span>
        <span><i class="dot" style="background:var(--bad)"></i>Under 2s</span>
      </div>
      <div id="pitchChart"></div>
      <div id="pitchTable" class="table-scroll hidden" style="margin-top:12px"></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h2>Loudness</h2><div id="loudChart"></div></div>
      <div class="card"><h2>Vibrato</h2>
        ${series.vibrato.present ? `<div class="grid grid-2">
          <div>${gauge({ value: series.vibrato.rate_hz, min: 3, max: 9, ideal: series.vibrato.ideal_rate, label: 'Speed', unit: ' Hz' })}</div>
          <div>${gauge({ value: series.vibrato.extent_st, min: 0, max: 2, ideal: series.vibrato.ideal_extent, label: 'Width', unit: ' st', decimals: 2 })}</div>
        </div>` : '<div class="empty" style="padding:24px 8px"><span class="serif">No vibrato yet</span>No steady vibrato was detected in this take. That’s common and fine for many styles.</div>'}
      </div>
    </div>` : `<div class="card" style="margin-top:16px"><div class="empty">Charts are available for sessions recorded after the latest update.</div></div>`}

    <div class="card" style="margin-top:16px">
      <h2>Measurements</h2>
      <div class="metric-list" id="metrics"></div>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>Coaching</h2>
      <div class="filters" id="tipFilters"></div>
      <div class="stack" id="tips" style="gap:10px"></div>
    </div>`;

  // Score tiles
  $('#tiles', root).innerHTML = AREAS.map(([key, label]) => {
    const v = payload.scores[key];
    const level = payload.levels?.[key];
    if (v == null && !level) return '';
    return v != null ? tile(label, Math.round(v), null, v) :
      `<div class="tile"><div class="label">${label}</div><div class="value" style="font-size:18px">${esc(level)}</div></div>`;
  }).join('');

  // Measurements
  const m = payload.metrics;
  const rows = [
    ['Average pitch', m.f0_mean_hz ? `${Math.round(m.f0_mean_hz)} Hz${m.centre_note ? ` (${m.centre_note})` : ''}` : '—'],
    ['Range', m.f0_range_semitones != null ? `${m.f0_range_semitones.toFixed(1)} semitones` : '—'],
    ['Pitch tendency', m.pitch_bias || '—'],
    ['Vibrato', m.vibrato_present ? `${m.vibrato_rate_hz.toFixed(1)} Hz, ${m.vibrato_extent_st.toFixed(2)} st` : 'Not detected'],
    ['Average phrase', m.avg_phrase_s != null ? `${m.avg_phrase_s.toFixed(1)} s` : '—'],
    ['Register breaks', m.register_breaks ?? '—'],
    ['Dynamic range', m.dynamic_range_db != null ? `${m.dynamic_range_db.toFixed(1)} dB` : '—'],
  ];
  $('#metrics', root).innerHTML = rows.map(([k, v]) => `<div class="metric"><span class="muted">${k}</span><span>${esc(v)}</span></div>`).join('');

  // Tips
  let filter = 'all';
  const paintTips = () => {
    const counts = {};
    payload.tips.forEach((t) => { counts[t.severity] = (counts[t.severity] || 0) + 1; });
    const opts = [['all', `All (${payload.tips.length})`], ...SEV_ORDER.filter((x) => counts[x]).map((x) => [x, `${SEV_LABEL[x]} (${counts[x]})`])];
    $('#tipFilters', root).innerHTML = opts.map(([k, l]) => `<button class="chip" aria-pressed="${k === filter}" data-f="${k}">${l}</button>`).join('');
    $$('#tipFilters .chip', root).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; paintTips(); }));
    const list = payload.tips.filter((t) => filter === 'all' || t.severity === filter)
      .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
    $('#tips', root).innerHTML = list.map((t) => `
      <div class="tip ${esc(t.severity)}">
        <div class="tip-top"><h3>${esc(t.headline)}</h3><span class="sev ${esc(t.severity)}">${esc(SEV_LABEL[t.severity] || t.severity)} · ${esc(t.category)}</span></div>
        <p>${esc(t.detail)}</p>
        ${t.exercise ? `<div class="exercise"><b>Try this</b>${esc(t.exercise)}</div>` : ''}
      </div>`).join('') || '<div class="empty">No tips for this session.</div>';
  };
  paintTips();

  // Charts + audio
  let pitchChart = null, loudChart = null;
  const player = setupPlayer(root, s, audioPath || `/api/session/${s.id}/audio`, (t) => {
    pitchChart?.setPlayhead(t); loudChart?.setPlayhead(t);
  });
  cleanups.push(player.destroy);
  if (series) {
    const seek = (t, end) => player.play(t, end);
    pitchChart = new PitchChart($('#pitchChart', root), series, { onSeek: s.has_audio ? seek : null });
    loudChart = new LoudnessChart($('#loudChart', root), series, { onSeek: s.has_audio ? seek : null });
    cleanups.push(() => pitchChart.destroy(), () => loudChart.destroy());
    $('#pitchTableBtn', root).addEventListener('click', (e) => {
      const tbl = $('#pitchTable', root), open = tbl.classList.toggle('hidden');
      e.target.setAttribute('aria-expanded', String(!open));
      e.target.textContent = open ? 'View as table' : 'Hide table';
      if (!open && !tbl.innerHTML) {
        tbl.innerHTML = `<table class="data"><thead><tr><th>Time</th><th>Note</th><th>Length</th><th>Tuning</th></tr></thead><tbody>
          ${series.notes.map((n) => `<tr><td>${fmtTime(n.s)}</td><td>${esc(n.name)}</td><td>${(n.e - n.s).toFixed(2)} s</td>
            <td>${Math.abs(n.cents) < 5 ? 'in tune' : `${Math.abs(Math.round(n.cents))}¢ ${n.cents > 0 ? 'sharp' : 'flat'}`}</td></tr>`).join('')}
        </tbody></table>`;
      }
    });
  }
  $$('[data-seek]', root).forEach((b) => b.addEventListener('click', () => player.play(Number(b.dataset.seek) - 0.3, Number(b.dataset.end) + 0.3)));

  if (!shared) wireOwnerActions(root, s, app, player, cleanups);
  return () => cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

function tile(label, value, sub, score) {
  const st = statusFor(score);
  return `<div class="tile"><div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${score != null ? `<span class="status ${st.cls}" style="margin-top:4px">${st.label}</span>
      <div class="bar"><div style="width:${Math.max(0, Math.min(100, score))}%;background:${st.color}"></div></div>` : ''}
    ${sub ? `<div class="sub" style="margin-top:4px">${esc(sub)}</div>` : ''}</div>`;
}

// ─────────────────────────────────────────────────────────────
// Audio player with phrase replay
// ─────────────────────────────────────────────────────────────

function setupPlayer(root, s, path, onTime) {
  const noop = { play() {}, destroy() {} };
  if (!s.has_audio) return noop;
  const audio = new Audio();
  audio.preload = 'auto';
  let url = null, stopAt = null, raf = null, loading = null;
  const btn = $('#playBtn', root), scrub = $('#scrub', root), time = $('#time', root), note = $('#phraseNote', root);

  const ensure = () => loading || (loading = audioObjectUrl(path).then((u) => { url = u; audio.src = u; })
    .catch(() => { btn.disabled = true; time.textContent = 'Recording unavailable'; }));
  const update = () => {
    const t = audio.currentTime;
    scrub.value = t;
    time.textContent = `${fmtTime(t)} / ${fmtTime(s.duration_s || audio.duration || 0)}`;
    onTime(t);
    if (stopAt != null && t >= stopAt) { audio.pause(); stopAt = null; note.textContent = 'Phrase finished. Click another part of the pitch map to hear it.'; }
  };
  // Smooth playhead while visible; `timeupdate` keeps phrase stops working when frames are throttled.
  const loop = () => { update(); if (!audio.paused) raf = requestAnimationFrame(loop); };
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('play', () => { btn.innerHTML = icons.pause; btn.setAttribute('aria-label', 'Pause'); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
  audio.addEventListener('pause', () => { btn.innerHTML = icons.play; btn.setAttribute('aria-label', 'Play recording'); cancelAnimationFrame(raf); update(); });
  btn.addEventListener('click', async () => {
    await ensure();
    stopAt = null;
    audio.paused ? audio.play() : audio.pause();
  });
  scrub.addEventListener('input', async () => { await ensure(); audio.currentTime = Number(scrub.value); update(); });

  return {
    async play(t, end = null) {
      await ensure();
      audio.currentTime = Math.max(0, t);
      stopAt = end;
      if (end != null) note.textContent = `Playing ${fmtTime(Math.max(0, t))}–${fmtTime(end)}`;
      audio.play();
    },
    pause() { audio.pause(); },
    destroy() { audio.pause(); cancelAnimationFrame(raf); if (url) URL.revokeObjectURL(url); },
  };
}

// ─────────────────────────────────────────────────────────────
// Owner-only actions: rename, delete, plan, share, compare
// ─────────────────────────────────────────────────────────────

function wireOwnerActions(root, s, app, player, cleanups) {
  $('#deleteBtn', root).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Delete this session?', body: 'The recording, charts and tips will be removed permanently.', confirm: 'Delete', danger: true }))) return;
    await api(`/api/session/${s.id}`, { method: 'DELETE' });
    toast('Session deleted.');
    app.go('#/sessions');
  });

  $('#renameBtn', root).addEventListener('click', async () => {
    const label = prompt('Name this session', s.label || '');
    if (!label || !label.trim()) return;
    await api(`/api/session/${s.id}`, { method: 'PATCH', json: { label } });
    $('#title', root).textContent = label.trim();
    s.label = label.trim();
  });

  $('#planBtn', root).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'New 7-day plan?', body: 'This replaces your current plan with one built around this session’s results.', confirm: 'Make my plan' }))) return;
    await api('/api/plan', { method: 'POST', json: { session_id: s.id } });
    toast('Your new plan is ready.');
    app.go('#/today');
  });

  $('#rescoreBtn', root)?.addEventListener('click', async (e) => {
    if (!(await confirmDialog({ title: 'Re-score this recording?', body: 'Vocalize analyses the saved recording again with the latest scoring. The scores, charts and tips for this session are replaced; its name and date stay the same.', confirm: 'Re-score' }))) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { job_id } = await api(`/api/session/${s.id}/rescore`, { method: 'POST' });
      for (;;) {
        const { job } = await api(`/api/jobs/${job_id}`);
        if (job.status === 'error') throw new Error(job.error || 'Re-scoring failed.');
        if (job.status === 'done') break;
        btn.textContent = job.stage || 'Re-scoring…';
        await new Promise((r) => setTimeout(r, 1500));
      }
      toast('Scores updated.');
      location.reload();
    } catch (err) {
      toast(err.message || 'Re-scoring failed.');
      btn.disabled = false;
      btn.textContent = '↻ Re-score';
    }
  });

  $('#shareBtn', root).addEventListener('click', () => openShare(s));

  // A/B compare with another take
  const sel = $('#compareSel', root);
  if (!sel) return;
  const other = new Audio();
  let otherUrl = null;
  cleanups.push(() => { other.pause(); if (otherUrl) URL.revokeObjectURL(otherUrl); });
  api('/api/history').then(({ sessions }) => {
    sel.innerHTML += sessions.filter((x) => x.id !== s.id && x.has_audio)
      .map((x) => `<option value="${x.id}">${esc(x.label || 'Session')} · ${esc(fmtShortDate(x.timestamp))} · ${x.overall_score != null ? Math.round(x.overall_score) : '–'}</option>`).join('');
    if (sel.options.length === 1) sel.closest('.row').classList.add('hidden');
  });
  const playB = $('#playB', root);
  sel.addEventListener('change', async () => {
    other.pause();
    if (otherUrl) URL.revokeObjectURL(otherUrl);
    otherUrl = null;
    playB.classList.toggle('hidden', !sel.value);
    if (sel.value) { otherUrl = await audioObjectUrl(`/api/session/${sel.value}/audio`); other.src = otherUrl; }
  });
  playB.addEventListener('click', () => {
    player.pause();
    if (other.paused) { other.currentTime = 0; other.play(); playB.innerHTML = `${icons.pause} Stop other take`; }
    else { other.pause(); }
  });
  other.addEventListener('pause', () => { playB.innerHTML = `${icons.play} Play other take`; });
}

async function openShare(s) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `
    <h2>Share with your teacher</h2>
    <p class="muted small">Anyone with the link can view this report without signing in. You can turn a link off at any time.</p>
    <label class="row small" style="margin:14px 0"><input type="checkbox" id="incAudio" checked> Include the recording</label>
    <div class="row"><button class="btn btn-primary" id="mk">Create link</button>
      <button class="btn btn-quiet" id="print">Save as PDF</button><span class="spacer"></span>
      <button class="btn btn-quiet" id="close">Done</button></div>
    <div id="links" class="stack" style="gap:8px;margin-top:16px"></div>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  const paint = async () => {
    const { shares } = await api(`/api/session/${s.id}/shares`);
    $('#links', d).innerHTML = shares.map((l) => `
      <div class="tile" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="text" readonly value="${esc(l.url)}" style="flex:1;min-width:180px;font-size:13px">
        <button class="btn btn-sm" data-copy="${esc(l.url)}">Copy</button>
        <button class="btn btn-sm btn-danger" data-revoke="${esc(l.token)}">Turn off</button>
        <div class="small muted" style="width:100%">${l.include_audio ? 'With recording' : 'Report only'} · viewed ${l.views} time${l.views === 1 ? '' : 's'}</div>
      </div>`).join('');
    $$('[data-copy]', d).forEach((b) => b.addEventListener('click', async () => {
      if (navigator.share) { try { await navigator.share({ title: 'My Vocalize session', url: b.dataset.copy }); return; } catch { /* fall back to copy */ } }
      await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied.');
    }));
    $$('[data-revoke]', d).forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/share/${b.dataset.revoke}`, { method: 'DELETE' }); toast('Link turned off.'); paint();
    }));
  };
  $('#mk', d).addEventListener('click', async () => {
    await api(`/api/session/${s.id}/share`, { method: 'POST', json: { include_audio: $('#incAudio', d).checked } });
    paint();
  });
  $('#print', d).addEventListener('click', () => { d.close(); setTimeout(() => window.print(), 200); });
  $('#close', d).addEventListener('click', () => d.close());
  d.showModal();
  paint();
}

export { tile };
