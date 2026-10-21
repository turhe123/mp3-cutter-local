// worker.js — encodes the cut audio off the main thread (classic worker).
// In:  { channels: Float32Array[], sampleRate, format: 'mp3' | 'wav', kbps, fadeIn, fadeOut }  (seconds)
// Out: { type: 'progress', value: 0..1 } … then { type: 'done', blob } or { type: 'error', message }
/* global lamejs */
importScripts('vendor/lamejs/lame.min.js');

const CHUNK = 1152; // one MP3 frame of samples per encodeBuffer call

self.onmessage = (e) => {
  try {
    const { channels, sampleRate, format, kbps, fadeIn, fadeOut } = e.data;
    applyFades(channels, sampleRate, fadeIn, fadeOut);
    const blob = format === 'wav' ? encodeWav(channels, sampleRate) : encodeMp3(channels, sampleRate, kbps);
    self.postMessage({ type: 'done', blob });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};

// Linear gain ramps at the start and end of the output.
function applyFades(channels, rate, fadeIn, fadeOut) {
  const len = channels[0].length;
  const inN = Math.min(len, Math.round((fadeIn || 0) * rate));
  const outN = Math.min(len, Math.round((fadeOut || 0) * rate));
  for (const ch of channels) {
    for (let i = 0; i < inN; i++) ch[i] *= i / inN;
    for (let i = 0; i < outN; i++) ch[len - 1 - i] *= i / outN;
  }
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeMp3(channels, rate, kbps) {
  const stereo = channels.length > 1;
  const left = toInt16(channels[0]);
  const right = stereo ? toInt16(channels[1]) : null;
  const enc = new lamejs.Mp3Encoder(stereo ? 2 : 1, rate, kbps);
  const parts = [];
  const total = left.length;
  let lastReport = 0;
  for (let i = 0; i < total; i += CHUNK) {
    const l = left.subarray(i, i + CHUNK);
    const out = stereo ? enc.encodeBuffer(l, right.subarray(i, i + CHUNK)) : enc.encodeBuffer(l);
    if (out.length) parts.push(out);
    if (i - lastReport > rate) { // about once per second of audio
      lastReport = i;
      self.postMessage({ type: 'progress', value: i / total });
    }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail);
  return new Blob(parts, { type: 'audio/mpeg' });
}

// 16-bit PCM WAV with a hand-written 44-byte header; any channel count, original sample rate.
function encodeWav(channels, rate) {
  const nCh = channels.length;
  const len = channels[0].length;
  const dataBytes = len * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * nCh * 2, true); v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(buf, 44);
  const ints = channels.map(toInt16);
  for (let i = 0, k = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) pcm[k++] = ints[c][i];
    if (i % (rate * 10) === 0) self.postMessage({ type: 'progress', value: i / len });
  }
  return new Blob([buf], { type: 'audio/wav' });
}
