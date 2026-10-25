// Small shared UI helpers.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── Theme: 'system' follows the device; 'light'/'dark' pin it. Stored per device. ──
export function getTheme() {
  try { return localStorage.getItem('vocalize.theme') || 'system'; } catch { return 'system'; }
}
export function applyTheme(theme = getTheme()) {
  try { localStorage.setItem('vocalize.theme', theme); } catch { /* private mode */ }
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  window.dispatchEvent(new Event('vq:theme'));
}

let toastTimer;
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Score → status role + plain-language label (status color is never shown without its label). */
export function statusFor(score) {
  if (score == null) return { cls: '', label: '—', color: 'var(--muted)' };
  if (score >= 75) return { cls: 'good', label: 'Strong', color: 'var(--good)' };
  if (score >= 50) return { cls: 'warn', label: 'Developing', color: 'var(--warn)' };
  return { cls: 'bad', label: 'Focus area', color: 'var(--bad)' };
}

export function fmtDate(ts, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') || String(ts).includes('+') ? '' : 'Z'));
  return isNaN(d) ? ts : d.toLocaleString(undefined, opts);
}
export const fmtShortDate = (ts) => fmtDate(ts, { month: 'short', day: 'numeric' });

export function showMsg(el, text, kind = 'error') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

/** A promise-based confirm using a <dialog>. */
export function confirmDialog({ title, body, confirm = 'Confirm', danger = false, input = null }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    d.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2><p class="muted">${body}</p>
      ${input ? `<input type="text" id="confirmInput" placeholder="${esc(input)}" autocomplete="off">` : ''}
      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn btn-quiet" value="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" id="confirmOk">${esc(confirm)}</button>
      </div></form>`;
    document.body.append(d);
    const inp = d.querySelector('#confirmInput'), ok = d.querySelector('#confirmOk');
    if (inp) { ok.disabled = true; inp.addEventListener('input', () => { ok.disabled = inp.value.trim() !== input; }); }
    let settled = false;
    const settle = (answer) => { if (!settled) { settled = true; resolve(answer); } };
    // Answer on the button press itself (don't rely only on the async `close` event), and
    // treat Esc / backdrop close as "cancel".
    d.querySelector('form').addEventListener('submit', (e) => settle(e.submitter?.value === 'ok'));
    d.addEventListener('close', () => { settle(d.returnValue === 'ok'); d.remove(); });
    d.showModal();
  });
}

const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const icons = {
  today: svg('<path d="M4 7h16M4 12h10M4 17h7"/><circle cx="18.5" cy="16.5" r="3"/>'),
  record: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  sessions: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  practice: svg('<path d="M3 12h3l2-6 4 12 3-9 2 3h4"/>'),
  progress: svg('<path d="M4 19h16"/><path d="M5 15l4-4 4 3 6-7"/>'),
  profile: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/>'),
  play: svg('<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  tuner: svg('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-6"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/>'),
  warmup: svg('<path d="M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-8z"/>'),
  target: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  range: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v9M12 5v9M16 5v9"/>'),
  breath: svg('<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  check: svg('<path d="M5 12l5 5 9-10" stroke-width="3"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  plan: svg('<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
  song: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
};
