import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, outToSrc, sourcePiecesForOutput, srcToOut, totalFrames } from '../shared/timemap.js';
import { timeStretch } from '../shared/stretch.js';
import { captionOutputTimings } from '../shared/segment.js';
import { SR, type Caption } from '../shared/types.js';

test('速さを変えた範囲は出力の長さが 元の長さ/速さ になり、他は等速のまま', () => {
  // 10秒。[2s,3s) を削除、[4s,8s) を 2倍速
  const tl = buildTimeline(10 * SR, [{ start: 2 * SR, end: 3 * SR }], 0, [{ start: 4 * SR, end: 8 * SR, speed: 2 }]);
  assert.equal(tl.outSamples, (2 + 1 + 2 + 2) * SR);
  assert.equal(srcToOut(tl, 3.5 * SR), 2.5 * SR);
  assert.equal(srcToOut(tl, 4 * SR), 3 * SR);
  assert.equal(srcToOut(tl, 6 * SR), 4 * SR); // 2秒進んで出力は1秒
  assert.equal(srcToOut(tl, 8 * SR), 5 * SR);
  assert.equal(srcToOut(tl, 9 * SR), 6 * SR);
  assert.equal(outToSrc(tl, 4.5 * SR), 7 * SR);
  assert.ok(tl.speedKey);
  // 単調・連続
  let prev = -1;
  for (let s = 0; s <= 10 * SR; s += 997) {
    const o = srcToOut(tl, s);
    assert.ok(o >= prev);
    prev = o;
  }
});

test('速さの変更をまたぐテロップ・シーンの時刻も対応表から計算される', () => {
  const tl = buildTimeline(10 * SR, [], 0, [{ start: 5 * SR, end: 10 * SR, speed: 1.25 }]);
  const cap: Caption = { id: 'c', srcStart: 6 * SR, srcEnd: 8.5 * SR, tokenIds: [], rawText: '', text: 'x', textEdited: false, timingEdited: false };
  const t = captionOutputTimings([cap], tl)[0]!;
  assert.equal(t.outStart, 5 * SR + 0.8 * SR);
  assert.equal(t.outEnd, 5 * SR + 2.8 * SR);
  // 同期する映像の断片にも速さが付く
  const pieces = sourcePiecesForOutput(tl, 4 * SR, 6 * SR);
  assert.deepEqual(pieces.map((p) => [p.srcStart / SR, p.srcEnd / SR, p.speed ?? 1]), [[4, 5, 1], [5, 6.25, 1.25]]);
});

test('細かく速さが変わっても末尾まで誤差が累積しない', () => {
  const speeds = [];
  for (let i = 0; i < 200; i++) speeds.push({ start: i * 0.5 * SR, end: (i + 1) * 0.5 * SR, speed: i % 3 === 0 ? 1.1 : i % 3 === 1 ? 0.9 : 1.33 });
  const tl = buildTimeline(100 * SR, [{ start: 10 * SR, end: 11 * SR }], 0, speeds);
  let acc = 0;
  for (const seg of tl.segments) {
    assert.equal(seg.outStart, acc);
    acc = seg.outEnd;
  }
  assert.equal(acc, tl.outSamples);
  assert.equal(srcToOut(tl, 100 * SR), tl.outSamples);
  assert.ok(totalFrames(tl.outSamples, 30) > 0);
});

function sine(sec: number, freq: number, ch = 2): Int16Array {
  const n = Math.round(sec * SR);
  const a = new Int16Array(n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) a[i * ch + c] = Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / SR));
  return a;
}

/** ゼロ交差から周波数を推定 */
function freqOf(a: Int16Array, ch: number, from: number, to: number): number {
  let z = 0;
  for (let i = from + 1; i < to; i++) if ((a[(i - 1) * ch]! < 0) !== (a[i * ch]! < 0)) z++;
  return (z / 2) * (SR / (to - from));
}

test('音程を変えずに速さを変え、出力の長さはサンプル単位で指定どおり', () => {
  const input = sine(2, 220);
  for (const speed of [0.5, 0.8, 1.25, 1.5, 2]) {
    const outFrames = Math.round((2 * SR) / speed);
    const out = timeStretch(input, 2, outFrames);
    assert.equal(out.length, outFrames * 2);
    const f = freqOf(out, 2, Math.round(outFrames * 0.2), Math.round(outFrames * 0.8));
    assert.ok(Math.abs(f - 220) < 6, `speed ${speed}: ${f}Hz`);
    // 振幅も保たれる(途切れ・音量の落ち込みがない)
    let min = Infinity;
    for (let w = Math.round(outFrames * 0.1); w + 480 < outFrames * 0.9; w += 480) {
      let pk = 0;
      for (let i = w; i < w + 480; i++) pk = Math.max(pk, Math.abs(out[i * 2]!));
      min = Math.min(min, pk);
    }
    assert.ok(min > 8000, `speed ${speed}: min peak ${min}`);
  }
});

test('発話と無音の並びは、速さを変えても順番と比率が保たれる', () => {
  // 0.5s 無音 → 1s 音 → 0.5s 無音
  const ch = 1;
  const a = new Int16Array(2 * SR);
  for (let i = 0.5 * SR; i < 1.5 * SR; i++) a[i] = Math.round(10000 * Math.sin((2 * Math.PI * 300 * i) / SR));
  const out = timeStretch(a, ch, Math.round((2 * SR) / 1.5));
  const onset = out.findIndex((v) => Math.abs(v) > 3000);
  let last = out.length - 1;
  while (last > 0 && Math.abs(out[last]!) < 3000) last--;
  assert.ok(Math.abs(onset / SR - 0.5 / 1.5) < 0.03, `onset ${onset / SR}`);
  assert.ok(Math.abs(last / SR - 1.5 / 1.5) < 0.03, `offset ${last / SR}`);
});
