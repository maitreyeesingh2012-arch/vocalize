// Onboarding questionnaire (#/welcome) and the profile & account page (#/profile).
import { api, setToken } from '../api.js';
import { scheduleReminder, reminderSupport } from '../reminders.js';
import { $, $$, applyTheme, confirmDialog, esc, getTheme, showMsg, toast } from '../ui.js';

const QUESTIONS = [
  { key: 'genres', q: 'What do you love to sing?', hint: 'Pick as many as you like.', multi: true },
  { key: 'goals', q: 'What would you like to get better at?', hint: 'Choose up to three.', multi: true, max: 3 },
  { key: 'years_singing', q: 'How long have you been singing?' },
  { key: 'self_assessed_level', q: 'How would you describe yourself as a singer?' },
  { key: 'takes_lessons', q: 'Are you taking singing lessons right now?', yesno: true },
  { key: 'practice_days_pw', q: 'How often do you practice in a typical week?' },
  { key: 'known_issues', q: 'Anything you’ve noticed about your voice?', hint: 'Optional. It helps us tailor your tips.', multi: true },
];

export async function render(root, params, app, name) {
  const { profile, choices } = await api('/api/profile');
  return name === 'welcome' ? renderWelcome(root, app, profile, choices) : renderProfile(root, app, profile, choices);
}

function optionsFor(q, choices) {
  if (q.yesno) return [{ label: 'Yes', value: true }, { label: 'No', value: false }];
  return (choices[q.key] || []).map((c) => (typeof c === 'object' ? c : { label: c, value: c }));
}

function questionHtml(q, choices, value) {
  const opts = optionsFor(q, choices);
  const selected = (v) => (q.multi ? (value || []).includes(v) : value === v);
  return `<div class="chips" data-key="${q.key}" data-multi="${q.multi ? 1 : 0}" data-max="${q.max || 99}">
    ${opts.map((o) => `<button type="button" class="chip" aria-pressed="${selected(o.value)}" data-value='${esc(JSON.stringify(o.value))}'>${esc(o.label)}</button>`).join('')}
  </div>`;
}

function wireChips(scope, answers) {
  $$('.chips[data-key]', scope).forEach((group) => {
    const key = group.dataset.key, multi = group.dataset.multi === '1', max = Number(group.dataset.max);
    group.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const v = JSON.parse(b.dataset.value);
      if (multi) {
        let arr = answers[key] || [];
        if (arr.includes(v)) arr = arr.filter((x) => x !== v);
        else if (arr.length < max) arr = [...arr, v];
        else { toast(`Choose up to ${max}.`); return; }
        // "None that I know of" can't be combined with other answers
        const NONE = 'None that I know of';
        if (key === 'known_issues' && arr.includes(v)) arr = v === NONE ? [NONE] : arr.filter((x) => x !== NONE);
        answers[key] = arr;
      } else {
        answers[key] = v;
      }
      $$('.chip', group).forEach((c) => {
        const cv = JSON.parse(c.dataset.value);
        c.setAttribute('aria-pressed', String(multi ? answers[key].includes(cv) : answers[key] === cv));
      });
      group.dispatchEvent(new CustomEvent('answered', { bubbles: true }));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Welcome / onboarding
// ─────────────────────────────────────────────────────────────

function renderWelcome(root, app, profile, choices) {
  const answers = { ...profile };
  let step = 0;
  const paint = () => {
    const q = QUESTIONS[step];
    root.innerHTML = `
      <div style="max-width:640px;margin:4vh auto 0">
        <div class="kicker">Step ${step + 1} of ${QUESTIONS.length}</div>
        <div class="progress" style="margin:10px 0 26px"><div style="width:${((step + 1) / QUESTIONS.length) * 100}%;animation:none;margin:0"></div></div>
        <h1 class="display">${esc(q.q)}</h1>
        ${q.hint ? `<p class="muted">${esc(q.hint)}</p>` : '<div style="height:12px"></div>'}
        <div style="margin-top:14px">${questionHtml(q, choices, answers[q.key])}</div>
        <div class="row" style="margin-top:30px">
          ${step > 0 ? '<button class="btn btn-quiet" id="back">Back</button>' : '<button class="btn btn-quiet" id="skip">Skip for now</button>'}
          <span class="spacer"></span>
          <button class="btn btn-primary" id="next">${step === QUESTIONS.length - 1 ? 'Finish' : 'Next'}</button>
        </div>
        <div id="msg" class="msg hidden"></div>
      </div>`;
    wireChips(root, answers);
    $('#next', root).addEventListener('click', next);
    $('#back', root)?.addEventListener('click', () => { step--; paint(); });
    $('#skip', root)?.addEventListener('click', () => { sessionStorage.setItem('vq.skipWelcome', '1'); app.go('#/today'); });
    if (step === 0) root.insertAdjacentHTML('afterbegin', `<p class="serif" style="font-size:22px;text-align:center;margin:0 0 8px;color:var(--text-2)">Welcome${app.user.is_guest ? '' : `, ${esc(app.user.display_name)}`}. A few quick questions so every tip is written for you.</p>`);
  };
  const next = async () => {
    if (step < QUESTIONS.length - 1) { step++; paint(); return; }
    try {
      const { user } = await api('/api/profile', { method: 'PUT', json: { ...answers, onboarded: true } });
      app.setUser(user);
      toast('All set. Let’s sing!');
      app.go('#/today');
    } catch (err) {
      showMsg($('#msg', root), err.message);
    }
  };
  paint();
}

// ─────────────────────────────────────────────────────────────
// Profile & account
// ─────────────────────────────────────────────────────────────

function renderProfile(root, app, profile, choices) {
  const answers = { ...profile };
  const u = app.user;
  const support = reminderSupport();
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Profile</div><h1>${u.is_guest ? 'Guest <em>singer</em>' : esc(u.display_name)}</h1></div></div>
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <h2>About your singing</h2>
        <p class="small muted" style="margin-top:0">Your answers personalize your coaching tips and practice plans.</p>
        ${profile.voice_type ? `<p>Detected voice type: <b style="text-transform:capitalize">${esc(profile.voice_type)}</b></p>` : ''}
        ${QUESTIONS.map((q) => `<label class="field">${esc(q.q)}</label>${questionHtml(q, choices, answers[q.key])}`).join('')}
        <div class="actions"><button class="btn btn-primary" id="save">Save changes</button></div>
        <div id="saveMsg" class="msg hidden"></div>
      </div>
      <div class="stack">
        <div class="card">
          <h2>Account</h2>
          ${u.is_guest ? `<p class="small">You're using Vocalize as a guest. Your sessions are tied to this ${window.Capacitor ? 'app' : 'browser'}.</p>
            <button class="btn btn-primary" id="claim">Save my progress</button>`
          : `<p class="small muted" style="margin-top:0">Signed in as <b style="color:var(--text)">${esc(u.email)}</b></p>
            <label class="field" for="name">Display name</label><input id="name" type="text" maxlength="40" value="${esc(u.display_name)}">
            <div class="actions"><button class="btn btn-sm" id="saveName">Update name</button></div>`}
          <div class="actions"><button class="btn btn-ghost" id="logout">Log out</button></div>
        </div>
        <div class="card">
          <h2>Appearance</h2>
          <div class="seg" role="group" aria-label="Theme">
            ${['system', 'light', 'dark'].map((t) => `<button data-theme-opt="${t}" aria-pressed="${getTheme() === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
          </div>
        </div>
        <div class="card">
          <h2>Practice reminder</h2>
          <p class="small muted" style="margin-top:0">${esc(support.note)}</p>
          <div class="row"><input type="time" id="remTime" value="${esc(profile.reminder_time || '')}" style="width:auto">
            <button class="btn btn-sm" id="remSave">${profile.reminder_time ? 'Update' : 'Turn on'}</button>
            ${profile.reminder_time ? '<button class="btn btn-quiet btn-sm" id="remOff">Turn off</button>' : ''}</div>
        </div>
        <div class="card">
          <h2>Privacy</h2>
          <p class="small muted" style="margin-top:0">Your recordings are stored only to show you your reports and progress. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
          <button class="btn btn-danger" id="deleteAcct">Delete my account</button>
        </div>
      </div>
    </div>`;

  wireChips(root, answers);
  $('#save', root).addEventListener('click', async () => {
    try {
      await api('/api/profile', { method: 'PUT', json: { ...answers, onboarded: true } });
      showMsg($('#saveMsg', root), 'Saved. Your next session’s tips will use these answers.', 'ok');
    } catch (err) { showMsg($('#saveMsg', root), err.message); }
  });
  $('#claim', root)?.addEventListener('click', () => app.openClaim());
  $('#saveName', root)?.addEventListener('click', async () => {
    const { user } = await api('/api/profile', { method: 'PUT', json: { display_name: $('#name', root).value } });
    app.setUser(user); toast('Name updated.'); app.go('#/profile');
  });
  $('#logout', root).addEventListener('click', () => app.logout());
  $$('[data-theme-opt]', root).forEach((b) => b.addEventListener('click', () => {
    applyTheme(b.dataset.themeOpt);
    $$('[data-theme-opt]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#remSave', root).addEventListener('click', async () => {
    const t = $('#remTime', root).value;
    if (!t) { toast('Pick a time first.'); return; }
    const ok = await scheduleReminder(t);
    await api('/api/profile', { method: 'PUT', json: { reminder_time: t } });
    toast(ok ? `Reminder set for ${t} every day.` : 'Saved. Reminders will fire in the Vocalize app.');
    app.go('#/profile');
  });
  $('#remOff', root)?.addEventListener('click', async () => {
    await scheduleReminder(null);
    await api('/api/profile', { method: 'PUT', json: { reminder_time: null } });
    toast('Reminder turned off.'); app.go('#/profile');
  });
  $('#deleteAcct', root).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete your account?',
      body: 'This permanently deletes your account, recordings, reports, plans and practice history. It can’t be undone. Type <b>DELETE</b> to confirm.',
      confirm: 'Delete everything', danger: true, input: 'DELETE',
    });
    if (!ok) return;
    await api('/api/account', { method: 'DELETE', json: { confirm: 'DELETE' } });
    await scheduleReminder(null);
    setToken(null);
    toast('Your account has been deleted.');
    setTimeout(() => location.replace(location.pathname), 800);
  });
}
