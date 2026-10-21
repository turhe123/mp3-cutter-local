// app.js — MP3 Cutter and Audio Trimmer. Everything runs on this device: decode with Web Audio,
// draw the waveform on a canvas, cut the selected frames and encode them in worker.js (lamejs or WAV).
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const editor = $('editor');
const results = $('results');
const wave = $('wave');
const canvas = $('wave-canvas');
const handles = { start: $('handle-start'), end: $('handle-end') };
const startInput = $('start');
const endInput = $('end');
const lengthOut = $('length');
const playBtn = $('play');
const stopBtn = $('stop');
const fadeInOn = $('fade-in-on');
const fadeOutOn = $('fade-out-on');
const fadeIn = $('fade-in');
const fadeOut = $('fade-out');
const modeSel = $('mode');
const formatSel = $('format');
const bitrateSel = $('bitrate');
const cutBtn = $('cut');
const progress = $('progress');
const estimate = $('out-estimate');

const AUDIO_EXT = /\.(mp3|wav|wave|m4a|mp4|aac|ogg|oga|opus|flac|webm|weba|aif|aiff|caf|amr|3gp)$/i;
const BIG_FILE = 200 * 1024 * 1024;
const MIN_LEN = 0.1; // seconds; start must stay smaller than end
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

const state = {
  file: null,
  buffer: null,
  start: 0,
  end: 0,
  active: 'start',
  peaks: null,
  outUrl: null,
  busy: false,
};
let player = null; // { ctx, sources, t0, segments }
let audioCtx = null;
let loadToken = 0;

/* ---------- time helpers ---------- */
export function formatTime(sec) {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const ss = s.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export function parseTime(text) {
  const t = String(text).trim().replace(',', '.');
  if (!/^\d+(?:\.\d*)?$|^\d+:\d{1,2}(?:\.\d*)?$|^\d+:\d{1,2}:\d{1,2}(?:\.\d*)?$/.test(t)) return NaN;
  return t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

/* ---------- messages ---------- */
function showAlert(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `alert alert--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  results.prepend(el);
  return el;
}
function clearAlerts() { results.querySelectorAll('.alert').forEach((a) => a.remove()); }

/* ---------- loading ---------- */
function isAudio(file) {
  return /^audio\//.test(file.type) || AUDIO_EXT.test(file.name) || (/^video\/(mp4|webm|ogg)/.test(file.type));
}

async function handleFiles(files) {
  clearAlerts();
  const audio = files.filter(isAudio);
  const rejected = files.filter((f) => !isAudio(f));
  if (rejected.length) {
    const names = rejected.map((f) => `"${f.name}"`).join(', ');
    showAlert(`${names} ${rejected.length > 1 ? 'are not audio files' : 'is not an audio file'}. Choose an MP3, WAV, M4A, OGG or FLAC file.`);
  }
  if (!audio.length) return;
  if (audio.length > 1) showAlert(`This tool cuts one file at a time, so only "${audio[0].name}" was opened.`, 'warn');
  await loadFile(audio[0]);
}

async function loadFile(file) {
  const token = ++loadToken;
  stopPlayback();
  if (file.size > BIG_FILE) {
    showAlert(`"${file.name}" is ${formatBytes(file.size)}. Decoded audio can need several times that in memory, so the page may slow down or run out of memory. A shorter file works best, especially on phones.`, 'warn');
  }
  zone.classList.add('is-loading');
  $('dropzone-title').textContent = `Reading ${file.name}…`;
  try {
    const bytes = await file.arrayBuffer();
    const rate = sniffSampleRate(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1 << 16)));
    const buffer = await decode(bytes, rate);
    if (token !== loadToken) return;
    if (!buffer.length || buffer.duration < 0.05) throw new Error('empty');
    state.file = file;
    state.buffer = buffer;
    state.start = 0;
    state.end = buffer.duration;
    state.active = 'start';
    results.querySelectorAll('.result').forEach((r) => r.remove());
    if (state.outUrl) { URL.revokeObjectURL(state.outUrl); state.outUrl = null; }
    showEditor();
    toast(`Opened ${file.name}. Nothing was uploaded.`);
  } catch (err) {
    if (token !== loadToken) return;
    console.warn('decode failed', err);
    const ext = (file.name.match(/\.([^.]+)$/) || [])[1];
    const hint = /^(m4a|mp4|aac|flac|opus|caf|amr|3gp)$/i.test(ext || '')
      ? ` Some browsers cannot decode every ${ext.toUpperCase()} file; try another browser, or convert it to MP3 or WAV first.`
      : ' The file may be damaged, or it is not really audio.';
    showAlert(`Could not read "${file.name}" as audio.${hint}`);
  } finally {
    if (token === loadToken) {
      zone.classList.remove('is-loading');
      $('dropzone-title').textContent = state.buffer ? 'Drop another audio file here' : 'Drop an audio file here';
    }
  }
}

// Decode at the file's own sample rate where we can read it, so the export keeps it.
async function decode(bytes, rate) {
  const make = (r) => new OfflineAudioContext(1, 1, r || 44100);
  let ctx;
  try { ctx = make(rate); } catch { ctx = make(); }
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

// Reads the sample rate from WAV, FLAC, OGG Vorbis and MP3 headers. Returns 0 when unknown.
export function sniffSampleRate(b) {
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const u32 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  const ok = (r) => (r >= 3000 && r <= 384000 ? r : 0);
  if (b.length < 12) return 0;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    for (let o = 12; o + 8 <= b.length;) {
      const size = u32(o + 4) >>> 0;
      if (ascii(o, 4) === 'fmt ') return ok(u32(o + 12) >>> 0);
      o += 8 + size + (size & 1);
    }
    return 0;
  }
  if (ascii(0, 4) === 'fLaC' && b.length > 21) return ok((b[18] << 12) | (b[19] << 4) | (b[20] >> 4));
  if (ascii(0, 4) === 'OggS') {
    for (let i = 0; i + 16 < b.length && i < 512; i++) {
      if (b[i] === 1 && ascii(i + 1, 6) === 'vorbis') return ok(u32(i + 12) >>> 0);
    }
    return 0;
  }
  let o = 0;
  if (ascii(0, 3) === 'ID3' && b.length > 10) o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  for (let i = o; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    const bitrate = b[i + 2] >> 4;
    const ri = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer === 0 || bitrate === 15 || bitrate === 0 || ri === 3) continue;
    return RATES[ver][ri];
  }
  return 0;
}

/* ---------- editor ---------- */
function showEditor() {
  const b = state.buffer;
  editor.hidden = false;
  zone.classList.add('dropzone--compact');
  $('file-name').textContent = state.file.name;
  const chans = b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels === 2 ? 'stereo' : `${b.numberOfChannels} channels`;
  $('file-meta').textContent = `${formatTime(b.duration)} · ${chans} · ${(b.sampleRate / 1000).toFixed(b.sampleRate % 1000 ? 1 : 0)} kHz · ${formatBytes(state.file.size)}`;
  for (const h of Object.values(handles)) h.setAttribute('aria-valuemax', b.duration.toFixed(1));
  computePeaks();
  drawWave();
  render();
}

function computePeaks() {
  const b = state.buffer;
  const width = Math.max(1, Math.round(wave.clientWidth * (window.devicePixelRatio || 1)));
  const data = [];
  for (let c = 0; c < b.numberOfChannels; c++) data.push(b.getChannelData(c));
  const min = new Float32Array(width);
  const max = new Float32Array(width);
  const per = b.length / width;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * per);
    const to = Math.max(from + 1, Math.floor((x + 1) * per));
    const step = Math.max(1, Math.floor((to - from) / 2000)); // sample long columns sparsely
    let lo = 1, hi = -1;
    for (const ch of data) {
      for (let i = from; i < to; i += step) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[x] = lo > hi ? 0 : lo;
    max[x] = lo > hi ? 0 : hi;
  }
  state.peaks = { width, min, max };
}

function drawWave() {
  if (!state.peaks) return;
  const dpr = window.devicePixelRatio || 1;
  const { width, min, max } = state.peaks;
  const height = Math.round(wave.clientHeight * dpr);
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, width, height);
  g.fillStyle = css.getPropertyValue('--line-2').trim() || '#999';
  const mid = height / 2;
  g.fillRect(0, Math.floor(mid), width, Math.max(1, Math.round(dpr)));
  g.fillStyle = css.getPropertyValue('--accent').trim() || '#5b4bdb';
  const amp = mid * 0.95;
  for (let x = 0; x < width; x++) {
    const top = mid - max[x] * amp;
    const h = Math.max(1, (max[x] - min[x]) * amp);
    g.fillRect(x, top, 1, h);
  }
}

function setRange(start, end, active) {
  const d = state.buffer.duration;
  if (active === 'start') {
    start = Math.min(Math.max(0, start), end - MIN_LEN);
  } else if (active === 'end') {
    end = Math.max(Math.min(d, end), start + MIN_LEN);
  }
  state.start = Math.max(0, Math.min(start, d - MIN_LEN));
  state.end = Math.min(d, Math.max(end, state.start + MIN_LEN));
  render();
}

function render() {
  const d = state.buffer.duration;
  const s = state.start / d * 100;
  const e = state.end / d * 100;
  handles.start.style.left = `${s}%`;
  handles.end.style.left = `${e}%`;
  $('shade-left').style.width = `${s}%`;
  $('shade-right').style.left = `${e}%`;
  $('wave-sel').style.left = `${s}%`;
  $('wave-sel').style.width = `${e - s}%`;
  wave.classList.toggle('is-delete', modeSel.value === 'delete');
  for (const [k, h] of Object.entries(handles)) {
    const v = state[k];
    h.setAttribute('aria-valuenow', v.toFixed(1));
    h.setAttribute('aria-valuetext', formatTime(v));
    h.classList.toggle('is-active', state.active === k);
  }
  if (document.activeElement !== startInput) startInput.value = formatTime(state.start);
  if (document.activeElement !== endInput) endInput.value = formatTime(state.end);
  const outLen = outputDuration();
  lengthOut.textContent = formatTime(state.end - state.start);
  const kbps = Number(bitrateSel.value);
  const b = state.buffer;
  const bytes = formatSel.value === 'wav'
    ? outLen * b.sampleRate * b.numberOfChannels * 2 + 44
    : outLen * kbps * 125;
  estimate.textContent = `Output ${formatTime(outLen)}, about ${formatBytes(bytes)}`;
  bitrateSel.disabled = formatSel.value === 'wav';
}

function outputDuration() {
  const sel = state.end - state.start;
  return modeSel.value === 'delete' ? state.buffer.duration - sel : sel;
}

/* ---------- handle dragging, clicks on the waveform, keyboard ---------- */
function timeAt(clientX) {
  const r = wave.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * state.buffer.duration;
}

function moveHandle(which, t) {
  state.active = which;
  if (which === 'start') setRange(t, state.end, 'start');
  else setRange(state.start, t, 'end');
}

for (const [which, h] of Object.entries(handles)) {
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    h.setPointerCapture(e.pointerId);
    h.focus();
    state.active = which;
    render();
    const onMove = (ev) => moveHandle(which, timeAt(ev.clientX));
    const onUp = () => {
      h.removeEventListener('pointermove', onMove);
      h.removeEventListener('pointerup', onUp);
      h.removeEventListener('pointercancel', onUp);
    };
    h.addEventListener('pointermove', onMove);
    h.addEventListener('pointerup', onUp);
    h.addEventListener('pointercancel', onUp);
  });
  h.addEventListener('focus', () => { state.active = which; render(); });
  h.addEventListener('keydown', (e) => {
    if (e.key === 'Home') { e.preventDefault(); moveHandle(which, which === 'start' ? 0 : state.start + MIN_LEN); }
    if (e.key === 'End') { e.preventDefault(); moveHandle(which, which === 'end' ? state.buffer.duration : state.end - MIN_LEN); }
  });
}

// Clicking the waveform moves the nearer handle there.
wave.addEventListener('pointerdown', (e) => {
  if (!state.buffer || e.target.closest('.wave__handle')) return;
  const t = timeAt(e.clientX);
  const which = Math.abs(t - state.start) <= Math.abs(t - state.end) ? 'start' : 'end';
  moveHandle(which, t);
  handles[which].focus();
});

document.addEventListener('keydown', (e) => {
  if (!state.buffer || editor.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  const typing = /^(INPUT|SELECT|TEXTAREA|BUTTON|A|SUMMARY)$/.test(tag) || e.target.isContentEditable || e.target === zone;
  if (typing) return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (player) stopPlayback(); else startPlayback();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
    const which = state.active;
    moveHandle(which, Math.round((state[which] + step) * 1000) / 1000);
  }
});

function commitTime(which, el) {
  const t = parseTime(el.value);
  if (!Number.isFinite(t)) {
    el.setAttribute('aria-invalid', 'true');
    el.value = formatTime(state[which]);
    toast('Use mm:ss.s, for example 01:05.5');
    return;
  }
  el.removeAttribute('aria-invalid');
  state.active = which;
  if (which === 'start') setRange(Math.min(t, state.end - MIN_LEN), state.end, 'start');
  else setRange(state.start, Math.max(t, state.start + MIN_LEN), 'end');
  el.value = formatTime(state[which]);
}
for (const [which, el] of [['start', startInput], ['end', endInput]]) {
  el.addEventListener('change', () => commitTime(which, el));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitTime(which, el); } });
}

for (const [box, num] of [[fadeInOn, fadeIn], [fadeOutOn, fadeOut]]) {
  box.addEventListener('change', () => {
    num.disabled = !box.checked;
    if (box.checked && !(Number(num.value) > 0)) num.value = '1';
  });
}
for (const el of [modeSel, formatSel, bitrateSel]) el.addEventListener('change', () => state.buffer && render());

/* ---------- preview ---------- */
function getAudioContext() {
  // Created inside a click or key handler so mobile Safari lets it play.
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function startPlayback() {
  if (!state.buffer) return;
  stopPlayback();
  const ctx = getAudioContext();
  const d = state.buffer.duration;
  // Keep: play the selection. Delete: play a few seconds either side of the cut, joined.
  const segments = modeSel.value === 'delete'
    ? [{ from: Math.max(0, state.start - 3), len: state.start - Math.max(0, state.start - 3) },
      { from: state.end, len: Math.min(3, d - state.end) }].filter((s) => s.len > 0.01)
    : [{ from: state.start, len: state.end - state.start }];
  if (!segments.length) return;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  const total = segments.reduce((a, s) => a + s.len, 0);
  if (modeSel.value === 'keep') {
    const fi = fadeInOn.checked ? Math.min(Number(fadeIn.value) || 0, total) : 0;
    const fo = fadeOutOn.checked ? Math.min(Number(fadeOut.value) || 0, total) : 0;
    gain.gain.setValueAtTime(fi ? 0 : 1, t0);
    if (fi) gain.gain.linearRampToValueAtTime(1, t0 + fi);
    if (fo) { gain.gain.setValueAtTime(1, t0 + total - fo); gain.gain.linearRampToValueAtTime(0, t0 + total); }
  }
  let at = t0;
  const sources = segments.map((s) => {
    const src = ctx.createBufferSource();
    src.buffer = state.buffer;
    src.connect(gain);
    src.start(at, s.from, s.len);
    at += s.len;
    return src;
  });
  sources[sources.length - 1].onended = () => { if (player && player.sources === sources) stopPlayback(); };
  player = { ctx, sources, t0, segments, gain };
  playBtn.textContent = '❚❚ Playing…';
  playBtn.setAttribute('aria-pressed', 'true');
  stopBtn.disabled = false;
  $('playhead').hidden = false;
  requestAnimationFrame(tick);
}

function tick() {
  if (!player) return;
  let el = player.ctx.currentTime - player.t0;
  let pos = player.segments[0].from;
  for (const s of player.segments) {
    if (el <= s.len) { pos = s.from + Math.max(0, el); break; }
    el -= s.len;
    pos = s.from + s.len;
  }
  $('playhead').style.left = `${pos / state.buffer.duration * 100}%`;
  requestAnimationFrame(tick);
}

function stopPlayback() {
  if (!player) return;
  const p = player;
  player = null;
  for (const s of p.sources) { s.onended = null; try { s.stop(); } catch { /* already stopped */ } }
  p.gain.disconnect();
  playBtn.textContent = '▶ Play selection';
  playBtn.removeAttribute('aria-pressed');
  stopBtn.disabled = true;
  $('playhead').hidden = true;
}

playBtn.addEventListener('click', () => (player ? stopPlayback() : startPlayback()));
stopBtn.addEventListener('click', stopPlayback);

/* ---------- export ---------- */
export function outputName(name, ext) {
  const base = name.replace(/\.[^./\\]+$/, '') || 'audio';
  return `${base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}-cut.${ext}`;
}

// Copies the frames to keep (the selection, or everything but it) into fresh Float32Arrays.
function selectedChannels() {
  const b = state.buffer;
  const s = Math.round(state.start * b.sampleRate);
  const e = Math.min(b.length, Math.round(state.end * b.sampleRate));
  const out = [];
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c);
    if (modeSel.value === 'delete') {
      const a = new Float32Array(s + (b.length - e));
      a.set(src.subarray(0, s), 0);
      a.set(src.subarray(e), s);
      out.push(a);
    } else {
      out.push(src.slice(s, e));
    }
  }
  return out;
}

// MP3 allows 1–2 channels and a few sample rates; mix down / resample with Web Audio only when needed.
async function fitForMp3(channels, rate) {
  const targetRate = MP3_RATES.includes(rate) ? rate : (rate > 48000 ? 48000 : MP3_RATES.find((r) => r >= rate) || 48000);
  const targetCh = Math.min(2, channels.length);
  if (targetRate === rate && targetCh === channels.length) return { channels, rate };
  const len = channels[0].length;
  const src = new AudioBuffer({ length: len, numberOfChannels: channels.length, sampleRate: rate });
  channels.forEach((ch, i) => src.copyToChannel(ch, i));
  const off = new OfflineAudioContext(targetCh, Math.ceil(len * targetRate / rate), targetRate);
  const node = off.createBufferSource();
  node.buffer = src;
  node.connect(off.destination);
  node.start();
  const r = await off.startRendering();
  const out = [];
  for (let c = 0; c < targetCh; c++) out.push(r.getChannelData(c).slice());
  return { channels: out, rate: targetRate };
}

function setProgress(v) {
  const pct = Math.floor(v * 1000) / 10; // never rounds 99.95% up to 100%
  progress.querySelector('span').style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(pct));
  progress.setAttribute('aria-valuetext', `${pct}%`);
}

function encodeInWorker(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker('./worker.js');
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') setProgress(m.value);
      else { w.terminate(); m.type === 'done' ? resolve(m.blob) : reject(new Error(m.message)); }
    };
    w.onerror = (e) => { e.preventDefault(); w.terminate(); reject(new Error(e.message || 'The encoder stopped unexpectedly.')); };
    w.postMessage(job, job.channels.map((c) => c.buffer));
  });
}

async function cut({ save = true } = {}) {
  if (!state.buffer || state.busy) return null;
  clearAlerts();
  const outLen = outputDuration();
  if (outLen < 0.05) {
    showAlert('Nothing would be left: the selection covers the whole file. Move a handle, or switch to "Keep the selection".');
    return null;
  }
  stopPlayback();
  state.busy = true;
  cutBtn.disabled = true;
  cutBtn.textContent = 'Encoding…';
  progress.hidden = false;
  setProgress(0);
  const format = formatSel.value;
  const kbps = Number(bitrateSel.value);
  try {
    let channels = selectedChannels();
    let rate = state.buffer.sampleRate;
    if (format === 'mp3') ({ channels, rate } = await fitForMp3(channels, rate));
    const fi = fadeInOn.checked ? Math.max(0, Number(fadeIn.value) || 0) : 0;
    const fo = fadeOutOn.checked ? Math.max(0, Number(fadeOut.value) || 0) : 0;
    const frames = channels[0].length;
    const blob = await encodeInWorker({ channels, sampleRate: rate, format, kbps, fadeIn: fi, fadeOut: fo });
    setProgress(1);
    const name = outputName(state.file.name, format);
    showResult(blob, name, frames / rate, format === 'mp3' ? `MP3 ${kbps} kbps` : 'WAV 16-bit', rate, channels.length, { fi, fo });
    if (save) downloadBlob(blob, name);
    return blob;
  } catch (err) {
    console.warn('export failed', err);
    showAlert(`Could not save the cut: ${err.message}. Try WAV, or a shorter file.`);
    return null;
  } finally {
    state.busy = false;
    cutBtn.disabled = false;
    cutBtn.textContent = '✂ Cut and save';
    setTimeout(() => { progress.hidden = true; }, 600);
  }
}
cutBtn.addEventListener('click', () => cut());

function showResult(blob, name, seconds, kind, rate, nCh, fades) {
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  state.outUrl = URL.createObjectURL(blob);
  results.querySelectorAll('.result').forEach((r) => r.remove());
  const row = document.createElement('div');
  row.className = 'result result--audio';
  row.innerHTML = `
    <div class="result__meta">
      <div class="result__name"></div>
      <div class="result__info stat"></div>
    </div>
    <audio class="result__audio" controls preload="metadata" aria-label="Listen to the cut"></audio>
    <a class="btn btn--primary" id="download"></a>`;
  row.querySelector('.result__name').textContent = name;
  const fadeText = [fades.fi && `fade in ${fades.fi} s`, fades.fo && `fade out ${fades.fo} s`].filter(Boolean).join(', ');
  row.querySelector('.result__info').textContent =
    `Duration ${formatTime(seconds)} · ${formatBytes(blob.size)} · ${kind} · ${nCh === 1 ? 'mono' : nCh === 2 ? 'stereo' : `${nCh} ch`} · ${rate / 1000} kHz${fadeText ? ` · ${fadeText}` : ''}`;
  row.querySelector('audio').src = state.outUrl;
  const a = row.querySelector('a');
  a.href = state.outUrl;
  a.download = name;
  a.textContent = `Download ${name}`;
  results.appendChild(row);
  row.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('pagehide', () => { if (state.outUrl) URL.revokeObjectURL(state.outUrl); });

/* ---------- resize & theme ---------- */
let resizeTimer = 0;
new ResizeObserver(() => {
  if (!state.buffer) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { computePeaks(); drawWave(); }, 80);
}).observe(wave);
new MutationObserver(() => drawWave()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawWave());

wireDropzone(zone, input, handleFiles);

// Called by the factory's screenshot script: opens the fictional "Sample Song" by "Demo Band" and cuts a section.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-song.mp3');
  const blob = await res.blob();
  await loadFile(new File([blob], 'Demo Band - Sample Song.mp3', { type: 'audio/mpeg' }));
  state.active = 'end';
  setRange(4.5, 14.0, null);
  fadeInOn.checked = true; fadeIn.disabled = false; fadeIn.value = '1';
  fadeOutOn.checked = true; fadeOut.disabled = false; fadeOut.value = '2';
  await cut({ save: false });
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  editor.scrollIntoView({ block: 'nearest' });
};

export { handleFiles, loadFile };
