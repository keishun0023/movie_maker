import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, outToSrc, sampleToFrame, sourcePiecesForOutput, srcToOut, totalFrames } from '../shared/timemap.js';
import { SR } from '../shared/types.js';

test('保持区間から出力時刻へ変換できる', () => {
  // 10秒の元音声から [2s,3s) と [5s,7.5s) を削除
  const tl = buildTimeline(10 * SR, [
    { start: 2 * SR, end: 3 * SR },
    { start: 5 * SR, end: 7.5 * SR },
  ]);
  assert.equal(tl.segments.length, 3);
  assert.equal(tl.outSamples, 6.5 * SR);
  assert.equal(srcToOut(tl, 1 * SR), 1 * SR);
  assert.equal(srcToOut(tl, 4 * SR), 3 * SR);
  assert.equal(srcToOut(tl, 8 * SR), 4.5 * SR);
  assert.equal(srcToOut(tl, 10 * SR), 6.5 * SR);
  for (const seg of tl.segments) {
    assert.equal(seg.outEnd - seg.outStart, seg.srcEnd - seg.srcStart, '速度は変えない');
  }
});

test('削除区間内の時刻は削除点に写り、境界は連続する', () => {
  const tl = buildTimeline(10 * SR, [{ start: 2 * SR, end: 3 * SR }]);
  assert.equal(srcToOut(tl, 2.5 * SR), 2 * SR);
  assert.equal(srcToOut(tl, 2 * SR), 2 * SR);
  assert.equal(srcToOut(tl, 3 * SR), 2 * SR);
  // 単調非減少
  let prev = -1;
  for (let s = 0; s <= 10 * SR; s += 997) {
    const o = srcToOut(tl, s);
    assert.ok(o >= prev);
    prev = o;
  }
});

test('削除境界をまたぐ字幕は出力で短くなり、前後の字幕と隙間なく並ぶ', () => {
  const tl = buildTimeline(10 * SR, [{ start: 4 * SR, end: 6 * SR }]);
  // 字幕A: 3s-5s (後半が削除区間), 字幕B: 5s-8s (前半が削除区間)
  const aStart = srcToOut(tl, 3 * SR);
  const aEnd = srcToOut(tl, 5 * SR);
  const bStart = srcToOut(tl, 5 * SR);
  const bEnd = srcToOut(tl, 8 * SR);
  assert.equal(aStart, 3 * SR);
  assert.equal(aEnd, 4 * SR);
  assert.equal(bStart, 4 * SR);
  assert.equal(bEnd, 6 * SR);
});

test('冒頭と末尾の削除', () => {
  const tl = buildTimeline(10 * SR, [
    { start: 0, end: 1 * SR },
    { start: 9 * SR, end: 10 * SR },
  ]);
  assert.equal(tl.segments[0]!.srcStart, 1 * SR);
  assert.equal(tl.segments[0]!.outStart, 0);
  assert.equal(srcToOut(tl, 0), 0);
  assert.equal(srcToOut(tl, 0.5 * SR), 0);
  assert.equal(srcToOut(tl, 9.5 * SR), 8 * SR);
  assert.equal(tl.outSamples, 8 * SR);
  assert.equal(outToSrc(tl, 0), 1 * SR);
  assert.equal(outToSrc(tl, 8 * SR), 9 * SR);
});

test('出力→元音声の逆変換は保持区間内で往復一致する', () => {
  const tl = buildTimeline(20 * SR, [
    { start: 1 * SR, end: 1.2 * SR },
    { start: 5 * SR, end: 6 * SR },
    { start: 12 * SR, end: 12.05 * SR },
  ]);
  for (const seg of tl.segments) {
    for (const s of [seg.srcStart, Math.floor((seg.srcStart + seg.srcEnd) / 2), seg.srcEnd - 1]) {
      assert.equal(outToSrc(tl, srcToOut(tl, s)), s);
    }
  }
});

test('多数の区間でも丸め誤差が累積しない(整数サンプル)', () => {
  // 1000回、7.3ms ずつ不規則に削る
  const removes = [];
  let t = 0;
  for (let i = 0; i < 1000; i++) {
    t += Math.round(0.1234567 * SR);
    removes.push({ start: t, end: t + Math.round(0.0073 * SR) });
    t += Math.round(0.0073 * SR);
  }
  const total = t + SR;
  const tl = buildTimeline(total, removes);
  const removed = removes.reduce((a, r) => a + (r.end - r.start), 0);
  assert.equal(tl.outSamples, total - removed);
  assert.equal(srcToOut(tl, total), total - removed);
  // 各区間の出力開始は、それまでの保持長の合計と完全一致
  let acc = 0;
  for (const seg of tl.segments) {
    assert.equal(seg.outStart, acc);
    acc += seg.srcEnd - seg.srcStart;
  }
  // フレーム境界も絶対位置から計算するので末尾で誤差が出ない
  const fps = 30;
  const frames = totalFrames(tl.outSamples, fps);
  assert.ok(Math.abs(frames / fps - tl.outSamples / SR) < 1 / fps);
  assert.equal(sampleToFrame(tl.outSamples, fps), Math.round((tl.outSamples / SR) * fps));
});

test('出力範囲に対応する元音声の断片', () => {
  const tl = buildTimeline(10 * SR, [{ start: 2 * SR, end: 3 * SR }]);
  const pieces = sourcePiecesForOutput(tl, 1 * SR, 4 * SR);
  assert.deepEqual(
    pieces.map((p) => [p.srcStart / SR, p.srcEnd / SR, p.outStart / SR, p.outEnd / SR]),
    [
      [1, 2, 1, 2],
      [3, 5, 2, 4],
    ],
  );
});
