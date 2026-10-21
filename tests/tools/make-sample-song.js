// Generates tests/fixtures/sample-song.mp3: "Sample Song" by the fictional "Demo Band".
// 20 seconds, stereo, 44.1 kHz: three sine tones separated by quiet gaps, so the waveform has visible sections.
// Run with: node tests/tools/make-sample-song.js   (uses the vendored lamejs, no network)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'vendor/lamejs/lame.min.js'), 'utf8'));

const rate = 44100;
const seconds = 20;
const n = rate * seconds;
const left = new Int16Array(n);
const right = new Int16Array(n);
// [start, end, frequency, peak]: tone A, gap, tone B, gap, tone C
const sections = [[0, 6, 220, 0.8], [8, 13, 330, 0.45], [14.5, 20, 440, 0.65]];
for (const [s, e, f, peak] of sections) {
  for (let i = Math.round(s * rate); i < Math.round(e * rate); i++) {
    const t = i / rate;
    const ramp = Math.min(1, (t - s) / 0.01, (e - t) / 0.01); // 10 ms edges avoid clicks
    const v = Math.sin(2 * Math.PI * f * t) * peak * ramp;
    left[i] = Math.round(v * 32767);
    right[i] = Math.round(v * 0.85 * 32767);
  }
}
const enc = new lamejs.Mp3Encoder(2, rate, 128);
const parts = [];
for (let i = 0; i < n; i += 1152) {
  const out = enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
  if (out.length) parts.push(Buffer.from(out.buffer, out.byteOffset, out.length));
}
const tail = enc.flush();
if (tail.length) parts.push(Buffer.from(tail.buffer, tail.byteOffset, tail.length));
const file = path.join(root, 'tests/fixtures/sample-song.mp3');
fs.writeFileSync(file, Buffer.concat(parts));
console.log(`wrote ${file} (${fs.statSync(file).size} bytes)`);
