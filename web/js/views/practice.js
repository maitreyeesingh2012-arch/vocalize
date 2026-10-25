// Practice hub and router for the individual tools.
import { icons } from '../ui.js';

const TOOLS = {
  tuner: () => import('./tools/tuner.js'),
  warmup: () => import('./tools/warmup.js'),
  match: () => import('./tools/match.js'),
  range: () => import('./tools/range.js'),
  breath: () => import('./tools/breath.js'),
};

export async function render(root, params, app) {
  const tool = params[0];
  if (TOOLS[tool]) {
    const mod = await TOOLS[tool]();
    // Each tool gets its own container: if the singer navigates away mid-exercise, async
    // steps still in flight update this (now detached) element instead of the next page.
    const el = document.createElement('div');
    root.append(el);
    return mod.render(el, params.slice(1), app);
  }
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Practice room</div><h1>Tools for <em>every day</em></h1></div></div>
    <div class="tool-grid">
      ${card('tuner', 'tuner', 'Live pitch meter', 'See the note you’re singing and how many cents sharp or flat, in real time. Great for long tones.')}
      ${card('warmup', 'warmup', 'Guided warm-ups', 'Lip trills, scales and sirens on piano, set to your voice. Listen, then sing it back and get scored.')}
      ${card('match', 'target', 'Pitch matching', 'Hear a note, sing it back. Drills focus on the notes you miss most.')}
      ${card('range', 'range', 'Range finder', 'Find your lowest and highest notes, see them on a keyboard, and watch your range grow.')}
      ${card('breath', 'breath', 'Breath trainer', 'Timed “sss” hiss with a steadiness meter to build breath support.')}
    </div>
    <p class="small muted" style="margin-top:18px">Tip: headphones help the practice tools hear only you.</p>`;
}

function card(route, icon, title, text) {
  return `<a class="tool" href="#/practice/${route}"><span class="ico">${icons[icon]}</span><h3>${title}</h3><p>${text}</p></a>`;
}
