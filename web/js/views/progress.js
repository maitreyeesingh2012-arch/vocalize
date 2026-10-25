// Progress over time: streaks, activity calendar, score trends and range growth.
import { api } from '../api.js';
import { midiName } from '../audio.js';
import { LineChart, keyboard } from '../charts.js';
import { $, $$, esc, fmtShortDate, statusFor } from '../ui.js';

export async function render(root) {
  const [p, practice] = await Promise.all([api('/api/progress'), api('/api/practice/summary')]);
  const charts = [];

  if (!p.sessions.length && !p.totals.practice) {
    root.innerHTML = `<div class="page-head"><div><div class="kicker">Progress</div><h1>Your <em>journey</em> starts here</h1></div></div>
      <div class="card"><div class="empty"><span class="serif">Nothing to chart yet</span>
      Record a session or try a practice tool and your progress will appear here.<br><br>
      <a class="btn btn-primary" href="#/record">Record a session</a></div></div>`;
    return;
  }

  const scored = p.sessions.filter((s) => s.overall != null);
  const first = scored[0], last = scored[scored.length - 1];
  const areas = Object.keys(p.area_labels);

  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Progress</div><h1>Hear yourself <em>grow</em></h1></div></div>
    <div class="tiles">
      <div class="tile"><div class="label">Current streak</div><div class="value">${p.streak.current} day${p.streak.current === 1 ? '' : 's'}</div>
        <div class="sub">${p.streak.current ? 'Keep it going today' : 'Practice today to start one'}</div></div>
      <div class="tile"><div class="label">Longest streak</div><div class="value">${p.streak.longest} day${p.streak.longest === 1 ? '' : 's'}</div></div>
      <div class="tile"><div class="label">Sessions</div><div class="value">${p.totals.sessions}</div><div class="sub">${p.totals.minutes_sung} min sung</div></div>
      <div class="tile"><div class="label">Practice drills</div><div class="value">${p.totals.practice}</div></div>
      <div class="tile"><div class="label">Most improved</div><div class="value" style="font-size:19px">${p.most_improved ? esc(p.most_improved.label) : '—'}</div>
        <div class="sub">${p.most_improved ? `+${p.most_improved.delta} points recently` : 'Needs a few more sessions'}</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Practice calendar</h2><span class="small muted">Last 12 weeks</span></div>
      <div class="heat" id="heat" role="img"></div>
      <div class="row small muted" style="margin-top:10px;gap:6px">Less
        <i style="width:12px;height:12px;border-radius:3px;background:var(--surface-3)"></i>
        <i style="width:12px;height:12px;border-radius:3px;background:color-mix(in srgb,var(--accent) 40%,var(--surface-3))"></i>
        <i style="width:12px;height:12px;border-radius:3px;background:color-mix(in srgb,var(--accent) 70%,var(--surface-3))"></i>
        <i style="width:12px;height:12px;border-radius:3px;background:var(--accent)"></i> More</div>
    </div>

    ${scored.length ? `
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2 id="trendTitle">Overall score</h2>
        <button class="btn btn-quiet btn-sm" id="tableBtn" aria-expanded="false">View as table</button></div>
      <div class="filters" id="trendFilter"></div>
      <div id="trend"></div>
      <div id="trendTable" class="table-scroll hidden" style="margin-top:12px"></div>
      ${scored.length === 1 ? '<p class="small muted">Record another session to see your trend line.</p>' : ''}
    </div>
    <h2 class="serif" style="margin:28px 0 12px">By area</h2>
    <div class="spark-grid" id="sparks"></div>` : ''}

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Your range</h2><a class="btn btn-sm" href="#/practice/range">Measure again</a></div>
      <div id="rangeBox"></div>
    </div>`;

  // Activity heatmap (columns = weeks)
  const days = Object.entries(p.activity);
  const pad = new Date(days[0][0] + 'T00:00').getDay();
  const today = days[days.length - 1][0];
  $('#heat', root).setAttribute('aria-label', `Practice on ${days.filter(([, n]) => n).length} of the last 84 days`);
  $('#heat', root).innerHTML = '<i style="visibility:hidden"></i>'.repeat(pad) + days.map(([d, n]) =>
    `<i data-l="${Math.min(3, n)}" class="${d === today ? 'today' : ''}" title="${new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${n ? `${n} session${n > 1 ? 's' : ''} or drill${n > 1 ? 's' : ''}` : 'no practice'}"></i>`).join('');

  // Trend chart with one area-filter row above it
  if (scored.length) {
    let current = 'overall', trend = null;
    const pointsFor = (key) => scored.map((s) => ({
      label: fmtShortDate(s.timestamp),
      value: key === 'overall' ? s.overall : s.scores[key],
      sub: `${esc(s.label || 'Session')} · ${fmtShortDate(s.timestamp)}`, id: s.id,
    }));
    const paint = () => {
      trend?.destroy();
      $('#trend', root).innerHTML = '';
      trend = new LineChart($('#trend', root), pointsFor(current), { height: 240 });
      trend.onPick = (pt) => { location.hash = `#/sessions/${pt.id}`; };
      charts.push(trend);
      $('#trendTitle', root).textContent = current === 'overall' ? 'Overall score' : p.area_labels[current];
      $$('#trendFilter .chip', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === current)));
      const tbl = $('#trendTable', root);
      tbl.innerHTML = `<table class="data"><thead><tr><th>Date</th><th>Session</th><th>${current === 'overall' ? 'Overall' : esc(p.area_labels[current])}</th></tr></thead><tbody>
        ${pointsFor(current).map((pt, i) => `<tr><td>${esc(pt.label)}</td><td>${esc(scored[i].label || 'Session')}</td><td>${pt.value != null ? Math.round(pt.value) : '—'}</td></tr>`).join('')}</tbody></table>`;
    };
    $('#trendFilter', root).innerHTML = [['overall', 'Overall'], ...areas.map((a) => [a, p.area_labels[a]])]
      .map(([k, l]) => `<button class="chip" data-k="${k}">${esc(l)}</button>`).join('');
    $$('#trendFilter .chip', root).forEach((b) => b.addEventListener('click', () => { current = b.dataset.k; paint(); }));
    $('#tableBtn', root).addEventListener('click', (e) => {
      const hidden = $('#trendTable', root).classList.toggle('hidden');
      e.target.textContent = hidden ? 'View as table' : 'Hide table';
      e.target.setAttribute('aria-expanded', String(!hidden));
    });
    paint();

    // Small multiples: one single-series sparkline per area
    $('#sparks', root).innerHTML = areas.map((a) => {
      const latest = last.scores[a], start = first.scores[a];
      const st = statusFor(latest);
      const delta = latest != null && start != null && scored.length > 1 ? Math.round(latest - start) : null;
      return `<button class="tile" data-area="${a}" style="border:0;text-align:left;cursor:pointer">
        <div class="label">${esc(p.area_labels[a])}</div>
        <div class="row" style="gap:8px"><span class="value">${latest != null ? Math.round(latest) : '—'}</span><span class="status ${st.cls}">${st.label}</span></div>
        <div class="sub">${delta == null ? 'First measurement' : `${delta >= 0 ? '+' : ''}${delta} since your first session`}</div>
        <div class="spark" style="margin-top:8px"></div></button>`;
    }).join('');
    $$('#sparks [data-area]', root).forEach((tileEl) => {
      const a = tileEl.dataset.area;
      const c = new LineChart(tileEl.querySelector('.spark'), scored.map((s) => ({ label: fmtShortDate(s.timestamp), value: s.scores[a] })), { height: 46, compact: true });
      charts.push(c);
      tileEl.addEventListener('click', () => { current = a; paint(); $('#trend', root).scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    });
  }

  // Range growth
  const r = practice.range, prev = practice.range_history?.[1];
  $('#rangeBox', root).innerHTML = r
    ? `<p style="margin-top:0"><b>${midiName(r.low)} – ${midiName(r.high)}</b> · ${r.high - r.low} semitones
        ${prev ? `<span class="muted"> (was ${midiName(prev.low)} – ${midiName(prev.high)})</span>` : ''}</p>
       ${keyboard({ from: Math.min(36, r.low - 2), to: Math.max(84, r.high + 2), low: r.low, high: r.high, passaggio: practice.passaggio, previous: prev })}
       ${prev ? '<p class="small muted">Dashed outline: your previous range.</p>' : ''}`
    : '<div class="empty" style="padding:18px">Measure your range to start tracking how it grows.</div>';

  return () => charts.forEach((c) => c.destroy());
}
