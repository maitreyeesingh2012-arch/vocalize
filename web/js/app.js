// Vocalize single-page app: auth, routing and the app shell.
import { api, isNative, setToken } from './api.js';
import { $, $$, applyTheme, confirmDialog, esc, icons, showMsg, toast } from './ui.js';

applyTheme();

const NAV = [
  { route: 'today', label: 'Today', icon: 'today' },
  { route: 'record', label: 'Record', icon: 'record' },
  { route: 'sessions', label: 'Sessions', icon: 'sessions' },
  { route: 'practice', label: 'Practice', icon: 'practice' },
  { route: 'progress', label: 'Progress', icon: 'progress' },
];

// Lazy-loaded views: each module exports render(root, params, app) → optional cleanup().
const VIEWS = {
  today: () => import('./views/today.js'),
  record: () => import('./views/record.js'),
  sessions: () => import('./views/sessions.js'),
  practice: () => import('./views/practice.js'),
  progress: () => import('./views/progress.js'),
  profile: () => import('./views/profile.js'),
  welcome: () => import('./views/profile.js'),
};

export const app = {
  user: null,
  go(hash) { if (location.hash === hash) route(); else location.hash = hash; },
  setUser(user) { app.user = user; rememberUser(user); paintUser(); },
  openClaim() { $('#claimMsg').classList.add('hidden'); $('#claimDialog').showModal(); },
  async logout() {
    if (app.user?.is_guest && !(await confirmDialog({
      title: 'Leave guest mode?',
      body: "You're signed in as a guest, so your sessions can't be recovered after logging out. Save your progress first to keep them.",
      confirm: 'Log out anyway', danger: true,
    }))) return;
    try { await api('/api/logout', { method: 'POST' }); } catch { /* already logged out */ }
    setToken(null);
    showLanding();
  },
};

// ── Shell ───────────────────────────────────────────────────

function paintNav() {
  const item = (n) => `<a class="nav-item" href="#/${n.route}" data-route="${n.route}">${icons[n.icon]}<span>${n.label}</span></a>`;
  $('#railNav').innerHTML = NAV.map(item).join('');
  $('#tabNav').innerHTML = NAV.map(item).join('');
  $$('[data-icon]').forEach((el) => { el.outerHTML = icons[el.dataset.icon]; });
}

function paintUser() {
  const u = app.user;
  if (!u) return;
  const name = document.getElementById('railName');
  if (name) name.textContent = u.is_guest ? 'Guest · Profile' : u.display_name;
}

function showLanding() {
  cleanupView();
  app.user = null;
  rememberUser(null);
  document.body.classList.add('landing-mode');
  $('#appRoot').classList.add('hidden');
  $('#landingRoot').classList.remove('hidden');
  $('#authView').classList.remove('hidden');
  if (location.hash && location.hash !== '#') history.replaceState(null, '', location.pathname);
  window.scrollTo(0, 0);
}

const USER_KEY = 'vocalize.user';
function rememberUser(user) {
  try { user ? localStorage.setItem(USER_KEY, JSON.stringify(user)) : localStorage.removeItem(USER_KEY); } catch { /* private mode */ }
}
function rememberedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
}

function showApp(user) {
  rememberUser(user);
  app.setUser(user);
  document.body.classList.remove('landing-mode');
  $('#landingRoot').classList.add('hidden');
  $('#appRoot').classList.remove('hidden');
  if (!user.onboarded && !sessionStorage.getItem('vq.skipWelcome')) {
    app.go('#/welcome');
  } else if (!location.hash || location.hash === '#') {
    app.go('#/today');
  } else {
    route();
  }
}

// ── Router ──────────────────────────────────────────────────

let cleanup = null;
let routeToken = 0;

function cleanupView() {
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
}

async function route() {
  if (!app.user) return;
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  app.query = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const name = VIEWS[parts[0]] ? parts[0] : 'today';
  const token = ++routeToken;
  cleanupView();
  $$('.nav-item[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  const root = $('#view');
  root.innerHTML = '<div class="row muted" style="padding:40px 0"><span class="spinner"></span> Loading…</div>';
  try {
    const mod = await VIEWS[name]();
    if (token !== routeToken) return;
    root.innerHTML = '';
    cleanup = await mod.render(root, parts.slice(1), app, name);
    root.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    if (token === routeToken) root.innerHTML = `<div class="empty"><span class="serif">Something went wrong</span>${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('vq:unauthorized', () => { if (app.user) { toast('Please sign in again.'); showLanding(); } });

// ── Landing auth ────────────────────────────────────────────

/** Vocalize stores voice recordings, so new accounts (including guests) must be 13 or older. */
function confirmAge() {
  return confirmDialog({
    title: 'Before you start',
    body: 'Vocalize records and stores your singing so it can coach you. It is for singers aged <b>13 and over</b>. '
      + 'See our <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a>.',
    confirm: 'I am 13 or older',
  });
}

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#authTitle').textContent = mode === 'login' ? 'Welcome back' : 'Join the ensemble';
  $('#authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#pwHint').classList.toggle('hidden', mode === 'login');
  $('#nameField').classList.toggle('hidden', mode === 'login');
  $('#authMsg').classList.add('hidden');
}

/** "Sign in with Google" via Google Identity Services, shown only if the server has a client ID. */
async function setupGoogleSignIn() {
  let clientId;
  try { clientId = (await api('/api/config')).google_client_id; } catch { return; }
  if (!clientId) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve; s.onerror = reject;
    document.head.append(s);
  }).catch(() => null);
  if (!window.google?.accounts?.id) return;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: async ({ credential }) => {
      try {
        let user;
        try {
          user = await api('/api/auth/google', { method: 'POST', json: { credential } });
        } catch (err) {
          // A new account needs the 13+ confirmation first
          if (err.status !== 400 || !(await confirmAge())) throw err;
          user = await api('/api/auth/google', { method: 'POST', json: { credential, age_confirmed: true } });
        }
        showApp(user);
      } catch (err) {
        showMsg($('#authMsg'), err.message);
      }
    },
  });
  const box = $('#googleSignIn');
  google.accounts.id.renderButton(box, { theme: 'filled_black', size: 'large', shape: 'pill', width: 300, text: 'continue_with' });
  box.classList.remove('hidden');
}

function wireLanding() {
  setupGoogleSignIn();
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    setAuthMode(b.dataset.goto);
    $('#authCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => $('#email').focus({ preventScroll: true }), 400);
  }));
  $$('[data-scroll]').forEach((b) => b.addEventListener('click', () =>
    document.getElementById(b.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));
  $$('[data-guest]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmAge())) return;
    const all = $$('[data-guest]');
    all.forEach((x) => { x.disabled = true; });
    try {
      showApp(await api('/api/guest', { method: 'POST', json: { age_confirmed: true } }));
    } catch (err) {
      showMsg($('#authMsg'), err.message);
      $('#authCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      all.forEach((x) => { x.disabled = false; });
    }
  }));

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (authMode === 'register' && !(await confirmAge())) return;
    const btn = $('#authSubmit');
    btn.disabled = true;
    try {
      const body = { email: $('#email').value.trim(), password: $('#password').value, age_confirmed: true,
                     display_name: $('#displayName').value.trim() };
      const user = await api(authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', json: body });
      $('#password').value = '';
      showApp(user);
    } catch (err) {
      showMsg($('#authMsg'), err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Guest → account
  $('#claimCancel').addEventListener('click', () => $('#claimDialog').close());
  $('#claimForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#claimSubmit');
    btn.disabled = true;
    try {
      const user = await api('/api/claim', { method: 'POST', json: { email: $('#claimEmail').value.trim(), password: $('#claimPassword').value } });
      $('#claimPassword').value = '';
      $('#claimDialog').close();
      app.setUser(user);
      toast('Account saved. Your sessions are safe.');
      route();
    } catch (err) {
      showMsg($('#claimMsg'), err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Boot ────────────────────────────────────────────────────

paintNav();
wireLanding();
api('/api/me')
  .then((me) => (me.authenticated ? showApp(me) : showLanding()))
  .catch((err) => {
    // Offline: reopen as the last signed-in singer so the on-device practice tools still work.
    const last = err.status === 0 ? rememberedUser() : null;
    if (last) { showApp(last); toast('You’re offline. Practice tools still work.'); } else showLanding();
  });

if ('serviceWorker' in navigator && !isNative && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
