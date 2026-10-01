import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, outToSrc, srcToOut } from '../shared/timemap.js';
import { renderEdited } from '../server/media.js';
import { pausesOf, timelineOf } from '../shared/project.js';
import { SR, type Scene } from '../shared/types.js';

const sec = (v: number) => Math.round(v * SR);

test('足す間: 削った所(無音)の位置に入れると、前の声の直後に無音が入り、後ろはその分ずれる', () => {
  // 0-1s 声 / 1-2s 無音(削る) / 2-3s 声
  const base = buildTimeline(sec(3), [{ start: sec(1), end: sec(2) }]);
  const tl = buildTimeline(sec(3), [{ start: sec(1), end: sec(2) }], 0, [], 0, [{ at: sec(1.5), samples: sec(0.5) }]);
  assert.equal(tl.outSamples, base.outSamples + sec(0.5));
  // 前の声の終わりはそのまま、後ろの声の始まりは 0.5秒後ろへ
  assert.equal(srcToOut(tl, sec(0.999)), srcToOut(base, sec(0.999)));
  assert.equal(srcToOut(tl, sec(2)), srcToOut(base, sec(2)) + sec(0.5));
  // 削った所(カットの境目)は、間の後ろに対応する(間は前のカットに含まれる)
  assert.equal(srcToOut(tl, sec(1.5)), sec(1.5));
  // 間の中は元音声の同じ位置のまま
  assert.equal(outToSrc(tl, sec(1.2)), sec(1));
  assert.notEqual(tl.hash, base.hash);
});

test('足す間: 話している途中の位置なら、そこで分けて間を入れる', () => {
  const tl = buildTimeline(sec(2), [], 0, [], 0, [{ at: sec(1), samples: sec(0.3) }]);
  assert.equal(tl.outSamples, sec(2.3));
  assert.equal(srcToOut(tl, sec(0.9)), sec(0.9));
  assert.equal(srcToOut(tl, sec(1)), sec(1.3));
  assert.equal(srcToOut(tl, sec(1.5)), sec(1.8));
});

test('足す間は無音で書き出し、前後の声は削らない', () => {
  const n = sec(3);
  const data = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = i < sec(1) || i >= sec(2) ? Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / SR)) : 0;
    data[i * 2] = v;
    data[i * 2 + 1] = v;
  }
  const tl = buildTimeline(n, [{ start: sec(1), end: sec(2) }], 4, [], 0, [{ at: sec(1), samples: sec(0.6) }]);
  const out = renderEdited({ sampleRate: SR, channels: 2, data }, tl);
  assert.equal(out.data.length / 2, sec(2.6));
  // 間の中(1.05〜1.55s)は無音、その後(1.65s〜)は声
  const rms = (a: number, b: number) => {
    let s = 0;
    for (let i = sec(a); i < sec(b); i++) s += out.data[i * 2]! ** 2;
    return Math.sqrt(s / (sec(b) - sec(a)));
  };
  assert.ok(rms(1.05, 1.55) < 1, `gap rms=${rms(1.05, 1.55)}`);
  assert.ok(rms(1.65, 2.5) > 3000);
  assert.ok(rms(0.1, 0.95) > 3000);
});

test('カットの「後の間」は、そのカットの終わりに入り、次のカットの始まりが後ろへずれる', () => {
  const scenes: Scene[] = [
    { id: 'a', srcStart: 0, srcEnd: sec(1.5), bg: null, inset: null, pauseAfterMs: 400 },
    { id: 'b', srcStart: sec(1.5), srcEnd: sec(3), bg: null, inset: null },
  ];
  const tl = buildTimeline(sec(3), [{ start: sec(1), end: sec(2) }], 0, [], 0, pausesOf(scenes));
  // カット a の出力の終わり = 声 1秒 + 間 0.4秒
  assert.equal(srcToOut(tl, scenes[0]!.srcEnd), sec(1.4));
  assert.equal(srcToOut(tl, sec(2)), sec(1.4));
  void timelineOf;
});
