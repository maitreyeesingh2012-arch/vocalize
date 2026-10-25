// Home: today's plan, streak and the latest session at a glance.
import { api } from '../api.js';
import { midiName } from '../audio.js';
import { $, $$, esc, fmtDate, icons, statusFor, toast } from '../ui.js';

/** Link that opens the in-app tool for a plan item (the tool marks it done on completion). */
export function itemLink(item) {
  const t = item.target || {}, q = new URLSearchParams({ item: item.id });
  switch (item.kind) {
    case 'warmup': return `#/practice/warmup/${t.routine || 'lip_trill'}?${q}`;
    case 'pitch_match': if (t.notes) q.set('notes', t.notes.join(',')); if (t.rounds) q.set('rounds', t.rounds); return `#/practice/match?${q}`;
    case 'tuner': for (const k of ['note', 'seconds', 'tolerance', 'mode']) if (t[k] != null) q.set(k, t[k]); return `#/practice/tuner?${q}`;
    case 'breath': if (t.seconds) q.set('seconds', t.seconds); return `#/practice/breath?${q}`;
    case 'range': return `#/practice/range?${q}`;
    case 'record': return '#/record';
    default: return null;
  }
}

function itemMeta(item) {
  const t = item.target || {};
  if (item.kind === 'tuner') return `${midiName(t.note)} · hold ${t.seconds}s`;
  if (item.kind === 'breath') return `Goal: ${t.seconds}s`;
  if (item.kind === 'pitch_match') return `${t.rounds} notes`;
  return '';
}

export async function render(root, params, app) {
  const [{ plan }, prog, hist] = await Promise.all([api('/api/plan'), api('/api/progress'), api('/api/history')]);
  const last = hist.sessions[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = app.user.is_guest ? '' : `, ${esc(app.user.display_name)}`;

  let dayIndex = 1;
  if (plan) {
    const created = new Date(plan.created_at.replace(' ', 'T') + 'Z');
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(created).setHours(0, 0, 0, 0)) / 864e5);
    dayIndex = Math.max(1, Math.min(7, days + 1));
  }
  let selected = dayIndex;

  root.innerHTML = `
    <div class="page-head">
      <div><div class="kicker">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <h1>${greet}${name}.</h1></div>
      <div class="row">
        <a class="btn btn-primary btn-lg" href="#/record">${icons.mic} Record a session</a>
        <label class="btn btn-lg">${icons.upload} Upload a piece<input type="file" accept="audio/*,.wav,.mp3,.m4a,.mp4,.aac,.flac,.ogg" class="hidden" data-upload></label>
      </div>
    </div>
    ${app.user.is_guest ? `<div class="share-banner" style="margin-bottom:16px">
      <span style="flex:1">You're singing as a guest. Save your progress so you never lose your sessions.</span>
      <button class="btn btn-sm btn-primary" id="claim">Save my progress</button></div>` : ''}
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:start" id="cols">
      <div class="card" id="planCard"></div>
      <div class="stack">
        <div class="tile"><div class="label">Practice streak</div>
          <div class="value">${prog.streak.current} day${prog.streak.current === 1 ? '' : 's'}</div>
          <div class="sub">${prog.streak.current ? 'Lovely consistency. Keep it up.' : 'Any session or drill today starts a streak.'}</div></div>
        ${last ? `<a class="card" href="#/sessions/${last.id}" style="text-decoration:none;color:inherit;display:block">
          <div class="kicker">Latest session</div>
          <div class="row" style="margin-top:6px"><b style="flex:1">${esc(last.label || 'Session')}</b>
            <span class="score-num">${last.overall_score != null ? Math.round(last.overall_score) : '–'}</span></div>
          <div class="small muted">${esc(fmtDate(last.timestamp))}</div>
          <span class="status ${statusFor(last.overall_score).cls}" style="margin-top:8px">${statusFor(last.overall_score).label}</span>
        </a>` : ''}
        <a class="card" href="#/practice/tuner" style="text-decoration:none;color:inherit;display:block">
          <div class="row">${icons.tuner}<b>Quick tuner</b></div>
          <div class="small muted" style="margin-top:4px">Check your pitch in real time.</div></a>
      </div>
    </div>`;
  if (matchMedia('(max-width: 860px)').matches) $('#cols', root).style.gridTemplateColumns = '1fr';
  $('#claim', root)?.addEventListener('click', () => app.openClaim());

  // "Upload a piece": hand the chosen file to the recorder, which loads it ready to analyze.
  const wireUploads = (scope) => $$('[data-upload]', scope).forEach((inp) => inp.addEventListener('change', () => {
    if (!inp.files[0]) return;
    app.pendingTake = inp.files[0];
    app.go('#/record');
  }));
  wireUploads($('.page-head', root));

  const card = $('#planCard', root);
  if (!plan) {
    card.innerHTML = `<div class="kicker">Your practice plan</div>
      <div class="empty"><span class="serif">Your first plan is one song away</span>
      Record a session and Vocalize will build a 7-day plan around what will help you most.<br><br>
      <a class="btn btn-primary" href="#/record">Record a session</a></div>`;
    return;
  }

  const paint = () => {
    const byDay = (d) => plan.items.filter((i) => i.day === d);
    const items = byDay(selected);
    const done = items.filter((i) => i.done).length;
    card.innerHTML = `
      <div class="card-head" style="margin-bottom:6px">
        <div><div class="kicker">Your 7-day plan · Day ${dayIndex}</div><h2 class="serif" style="margin:4px 0 0">Focus: ${esc(plan.focus_label)}</h2></div>
        <button class="btn btn-quiet btn-sm" id="newPlan">New plan</button>
      </div>
      <p class="small muted" style="margin-top:0">${esc(plan.summary)}</p>
      <div class="days" role="group" aria-label="Plan days">
        ${[1, 2, 3, 4, 5, 6, 7].map((d) => {
          const di = byDay(d), complete = di.length && di.every((i) => i.done);
          return `<button class="day-pill ${complete ? 'complete' : ''}" data-day="${d}" aria-pressed="${d === selected}">
            <span>${d === dayIndex ? 'Today' : 'Day'}</span><b>${d}</b></button>`;
        }).join('')}
      </div>
      <div class="small muted" style="margin:14px 0 2px">${done} of ${items.length} done</div>
      <div>${items.map((i) => {
        const link = itemLink(i);
        return `<div class="plan-item ${i.done ? 'done' : ''}">
          <button class="check" role="checkbox" aria-checked="${i.done}" aria-label="Mark “${esc(i.title)}” done" data-item="${i.id}">${icons.check}</button>
          <div class="body"><div class="title"><b>${esc(i.title)}</b>${itemMeta(i) ? ` <span class="muted small">· ${esc(itemMeta(i))}</span>` : ''}</div>
            <p>${esc(i.detail || '')}</p></div>
          ${i.kind === 'record' ? `<div class="row" style="gap:6px;flex-wrap:nowrap">
              <a class="btn btn-sm" href="${link}">Record</a>
              <label class="btn btn-sm">Upload a piece<input type="file" accept="audio/*,.wav,.mp3,.m4a,.mp4,.aac,.flac,.ogg" class="hidden" data-upload></label>
            </div>`
            : link ? `<a class="btn btn-sm" href="${link}">Start</a>` : ''}
        </div>`;
      }).join('')}</div>`;
    $$('.day-pill', card).forEach((b) => b.addEventListener('click', () => { selected = Number(b.dataset.day); paint(); }));
    wireUploads(card);
    $$('.check', card).forEach((b) => b.addEventListener('click', async () => {
      const item = plan.items.find((i) => i.id === Number(b.dataset.item));
      const res = await api(`/api/plan/items/${item.id}`, { method: 'POST', json: { done: !item.done } });
      plan.items = res.plan.items;
      if (!item.done && plan.items.filter((i) => i.day === selected).every((i) => i.done)) toast(`Day ${selected} complete. Brava!`);
      paint();
    }));
    $('#newPlan', card).addEventListener('click', async () => {
      const res = await api('/api/plan', { method: 'POST', json: {} });
      Object.assign(plan, res.plan);
      selected = dayIndex = 1;
      toast('Fresh plan built from your latest session.');
      paint();
    });
  };
  paint();
}
