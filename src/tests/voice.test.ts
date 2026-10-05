import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, srcToOut } from '../shared/timemap.js';
import { renderEdited } from '../server/media.js';
import { SR } from '../shared/types.js';

const sec = (v: number) => Math.round(v * SR);

function tone(totalSec: number, f: number, amp = 6000): Int16Array {
  const n = sec(totalSec);
  const d = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * f * i) / SR));
    d[i * 2] = v;
    d[i * 2 + 1] = v;
  }
  return d;
}

const rms = (d: Int16Array, a: number, b: number) => {
  let s = 0;
  for (let i = sec(a); i < sec(b); i++) s += d[i * 2]! ** 2;
  return Math.sqrt(s / (sec(b) - sec(a)));
};
const freq = (d: Int16Array, a: number, b: number) => {
  let c = 0;
  for (let i = sec(a) + 1; i < sec(b); i++) if ((d[(i - 1) * 2]! < 0) !== (d[i * 2]! < 0)) c++;
  return c / (b - a) / 2;
};

test('カットの声の大きさ・高さ: 指定した範囲だけ大きく・高くなり、長さは変わらない', () => {
  const data = tone(3, 300);
  // 1〜2s だけ +6dB・+6半音(約1.41倍の高さ)
  const tl = buildTimeline(sec(3), [], 4, [{ start: sec(1), end: sec(2), speed: 1, gainDb: 6, pitch: 6 }]);
  assert.equal(tl.outSamples, sec(3));
  assert.equal(srcToOut(tl, sec(2)), sec(2));
  const out = renderEdited({ sampleRate: SR, channels: 2, data }, tl).data;
  assert.equal(out.length, data.length);
  const base = rms(out, 0.1, 0.9);
  const loud = rms(out, 1.1, 1.9);
  assert.ok(loud / base > 1.8 && loud / base < 2.2, `ratio ${loud / base}`);
  assert.ok(Math.abs(freq(out, 0.1, 0.9) - 300) < 10);
  assert.ok(Math.abs(freq(out, 1.1, 1.9) - 300 * Math.SQRT2) < 20, `high ${freq(out, 1.1, 1.9)}`);
  assert.ok(Math.abs(freq(out, 2.1, 2.9) - 300) < 10);
});

test('大きくしすぎても音が割れない(上限の近くはやわらかく抑える)', () => {
  const data = tone(1, 200, 20000);
  const tl = buildTimeline(sec(1), [], 4, [{ start: 0, end: sec(1), speed: 1, gainDb: 9 }]);
  const out = renderEdited({ sampleRate: SR, channels: 2, data }, tl).data;
  let clipped = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]!) >= 32767) clipped++;
  assert.ok(clipped / out.length < 0.001, `clipped ${clipped}`);
});
