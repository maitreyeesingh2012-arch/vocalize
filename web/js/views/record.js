// Record (or upload) a take, optionally with the original song to compare against.
import { api } from '../api.js';
import { Mic, encodeWav, micErrorMessage, rms } from '../audio.js';
import { $, esc, icons, showMsg } from '../ui.js';

export async function render(root, params, app) {
  root.innerHTML = `
    <div class="page-head">
      <div><div class="kicker">New session</div><h1>Sing, and we'll <em>listen</em></h1></div>
    </div>
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <h2>1 · Your take</h2>
        <div class="rec-stage">
          <button class="rec-btn" id="recBtn" aria-label="Start recording">${icons.mic}</button>
          <div class="timer" id="timer">0:00</div>
          <div class="meter" aria-hidden="true"><div id="meter"></div></div>
          <div class="small muted" id="recStatus">Tap to record. A verse or chorus (10–60 seconds) works best.</div>
        </div>
        <div class="row small muted" style="justify-content:center;margin:6px 0 14px">or</div>
        <input type="file" id="takeFile" accept="audio/*,.wav,.mp3,.m4a,.mp4,.aac,.flac,.ogg" class="hidden">
        <div class="dropzone" id="takeDrop" tabindex="0" role="button">${icons.upload}<div>Upload a recording of yourself</div></div>
        <audio id="preview" controls class="hidden" style="width:100%;margin-top:14px"></audio>
      </div>

      <div class="stack">
        <div class="card">
          <h2>2 · Sing along with a song <span class="muted small" style="font-weight:500">(optional)</span></h2>
          <p class="small muted" style="margin-top:0">Add the original recording and Vocalize will find the part you sang, then compare your melody and timing with it, note by note. Singing in a different octave is fine.</p>
          <input type="file" id="refFile" accept="audio/*,.wav,.mp3,.m4a,.mp4,.aac,.flac,.ogg" class="hidden">
          <div class="dropzone" id="refDrop" tabindex="0" role="button">${icons.song}<div>Add the original song (MP3, WAV…)</div></div>
          <label class="field" for="refName">Song name</label>
          <input id="refName" type="text" maxlength="120" placeholder="e.g. Hello · Adele">
        </div>
        <div class="card">
          <h2>3 · Analyze</h2>
          <label class="field" for="label" style="margin-top:0">Session name</label>
          <input id="label" type="text" maxlength="80" placeholder="Practice session">
          <div class="actions">
            <button class="btn btn-primary btn-lg" id="analyzeBtn" disabled>Analyze my singing</button>
            <button class="btn btn-quiet" id="discardBtn" disabled>Start over</button>
          </div>
          <div id="job" class="hidden" aria-live="polite">
            <div class="stage-line" style="margin-top:16px"><span class="spinner"></span><b id="jobStage">Starting…</b></div>
            <div class="progress" style="margin-top:10px"><div></div></div>
            <div class="stages small muted" id="doneStages"></div>
          </div>
          <div id="msg" class="msg hidden"></div>
        </div>
      </div>
    </div>`;

  const state = { take: null, takeName: null, ref: null, recording: false, poll: null, alive: true };
  const mic = new Mic();
  let tick = null;

  // ── recording ──
  $('#recBtn', root).addEventListener('click', async () => {
    if (state.recording) return stopRecording();
    $('#msg', root).classList.add('hidden');
    try {
      await mic.start({
        record: true,
        onFrame: (buf) => {
          const level = rms(buf);
          const m = $('#meter', root);
          if (m) { m.style.width = Math.min(100, level * 400) + '%'; m.style.background = level > 0.3 ? 'var(--bad)' : 'var(--good)'; }
        },
      });
    } catch (err) {
      showMsg($('#msg', root), micErrorMessage(err));
      return;
    }
    state.recording = true;
    const t0 = Date.now();
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('#timer', root).textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
    const btn = $('#recBtn', root);
    btn.classList.add('recording'); btn.innerHTML = '<span class="stop-sq"></span>'; btn.setAttribute('aria-label', 'Stop recording');
    $('#recStatus', root).textContent = 'Recording… tap to stop.';
  });

  function stopRecording() {
    clearInterval(tick);
    const out = mic.stop();
    state.recording = false;
    const btn = $('#recBtn', root);
    btn.classList.remove('recording'); btn.innerHTML = icons.mic; btn.setAttribute('aria-label', 'Start recording');
    $('#meter', root).style.width = '0';
    if (!out) return;
    const secs = out.samples.length / out.sampleRate;
    if (secs < 3) {
      $('#recStatus', root).textContent = 'Tap to record.';
      showMsg($('#msg', root), 'That was a little short. Please sing for at least 3 seconds.');
      return;
    }
    setTake(encodeWav(out.samples, out.sampleRate), 'recording.wav', `Recorded ${secs.toFixed(1)}s. Listen back, then analyze.`);
  }

  function setTake(blob, name, status) {
    state.take = blob; state.takeName = name;
    const a = $('#preview', root);
    if (a.src) URL.revokeObjectURL(a.src);
    a.src = URL.createObjectURL(blob);
    a.classList.remove('hidden');
    $('#recStatus', root).textContent = status;
    const drop = $('#takeDrop', root);
    drop.classList.toggle('filled', name !== 'recording.wav');
    drop.querySelector('div').textContent = name !== 'recording.wav' ? name : 'Upload a recording of yourself';
    $('#analyzeBtn', root).disabled = false;
    $('#discardBtn', root).disabled = false;
  }

  // ── file pickers ──
  function wireDrop(dropSel, inputSel, onFile) {
    const drop = $(dropSel, root), input = $(inputSel, root);
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  }
  wireDrop('#takeDrop', '#takeFile', (f) => setTake(f, f.name, `Loaded ${f.name}.`));
  if (app.pendingTake) {   // a piece uploaded from the practice plan
    const f = app.pendingTake;
    app.pendingTake = null;
    setTake(f, f.name, `Loaded ${f.name} from your plan. Add the original song if you like, then analyze.`);
  }
  wireDrop('#refDrop', '#refFile', (f) => {
    state.ref = f;
    const drop = $('#refDrop', root);
    drop.classList.add('filled');
    drop.querySelector('div').innerHTML = `${esc(f.name)} <button class="btn btn-quiet btn-sm" id="refClear" type="button">Remove</button>`;
    if (!$('#refName', root).value) $('#refName', root).value = f.name.replace(/\.[^.]+$/, '');
    $('#refClear', root).addEventListener('click', (e) => {
      e.stopPropagation();
      state.ref = null; drop.classList.remove('filled');
      drop.querySelector('div').textContent = 'Add the original song (MP3, WAV…)';
      $('#refFile', root).value = '';
    });
  });

  $('#discardBtn', root).addEventListener('click', () => app.go('#/record'));   // re-renders a fresh recorder

  // ── analysis job ──
  $('#analyzeBtn', root).addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('audio', state.take, state.takeName || 'recording.wav');
    if (state.ref) fd.append('reference', state.ref, state.ref.name);
    fd.append('reference_query', $('#refName', root).value.trim());
    fd.append('label', $('#label', root).value.trim());
    $('#analyzeBtn', root).disabled = true; $('#discardBtn', root).disabled = true;
    $('#msg', root).classList.add('hidden');
    $('#job', root).classList.remove('hidden');
    $('#jobStage', root).textContent = 'Uploading…';
    try {
      const { job_id } = await api('/api/analyze', { method: 'POST', form: fd });
      pollJob(job_id);
    } catch (err) {
      fail(err.message);
    }
  });

  function fail(message) {
    $('#job', root).classList.add('hidden');
    showMsg($('#msg', root), message);
    $('#analyzeBtn', root).disabled = false; $('#discardBtn', root).disabled = false;
  }

  function pollJob(jobId) {
    let lastStage = null;
    const doneList = $('#doneStages', root);
    const step = async () => {
      if (!state.alive) return;
      try {
        const body = await api(`/api/jobs/${jobId}`);
        const job = body.job;
        if (job.stage !== lastStage) {
          if (lastStage && lastStage !== 'Waiting to start…') doneList.insertAdjacentHTML('beforeend', `<div>✓ ${esc(lastStage.replace(/…|\.\.\.$/, ''))}</div>`);
          lastStage = job.stage;
          $('#jobStage', root).textContent = job.stage.replace(/\.\.\.$/, '…');
        }
        if (job.status === 'done') return app.go(`#/sessions/${job.session_id}`);
        if (job.status === 'error') return fail(job.error);
      } catch (err) {
        if (err.status === 404) return fail('The analysis was interrupted. Please try again.');
      }
      state.poll = setTimeout(step, 900);
    };
    step();
  }

  return () => {
    state.alive = false;
    clearTimeout(state.poll);
    clearInterval(tick);
    if (state.recording) mic.stop();
    const a = $('#preview', root);
    if (a && a.src) URL.revokeObjectURL(a.src);
  };
}
