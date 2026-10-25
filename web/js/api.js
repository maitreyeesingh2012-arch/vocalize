// API client shared by the web app and the native (Capacitor) apps.
//
// Web: same-origin requests with the session cookie.
// Native: the bundle runs from capacitor://localhost, so requests go to the server
// named in js/config.js (window.VOCALIZE_CONFIG.apiBase) with a bearer token instead.

const cfg = window.VOCALIZE_CONFIG || {};
export const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const API_BASE = (cfg.apiBase || '').replace(/\/$/, '');
// Talking to a server on another domain (native apps, or the website on GitHub Pages with the
// server on Hugging Face): cookies don't cross domains, so use a bearer token instead.
const useToken = isNative || !!API_BASE;
const TOKEN_KEY = 'vocalize.token';

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function getToken() { return storageGet(TOKEN_KEY); }
export function setToken(token) { storageSet(TOKEN_KEY, token); }

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function headers(extra = {}) {
  const h = { 'X-Timezone-Offset': String(new Date().getTimezoneOffset()), ...extra };
  if (useToken) h['X-Client'] = 'app';
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function api(path, { method = 'GET', json, form, signal } = {}) {
  const opts = { method, headers: headers(), credentials: useToken ? 'omit' : 'same-origin', signal };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
  }
  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch {
    throw new ApiError("Can't reach Vocalize. Check your connection and try again.", 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (data.token) setToken(data.token);
  if (res.status === 401 && !['/api/login', '/api/me'].includes(path)) {
    window.dispatchEvent(new CustomEvent('vq:unauthorized'));
  }
  if (!res.ok || data.success === false) {
    throw new ApiError(data.error || `Something went wrong (${res.status}).`, res.status);
  }
  return data;
}

// <audio> can't send an Authorization header, so fetch recordings as blobs.
export async function audioObjectUrl(path) {
  const res = await fetch(API_BASE + path, { headers: headers(), credentials: useToken ? 'omit' : 'same-origin' });
  if (!res.ok) throw new ApiError('Recording unavailable.', res.status);
  return URL.createObjectURL(await res.blob());
}
