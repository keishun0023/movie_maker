import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapFor, planAssignments, shotsFromCuts, type Shot } from '../server/ai/plan.js';

test('場面分け: 短い場面は隣とまとめ、長い場面は数秒ずつに分ける(同じ group)', () => {
  const s = shotsFromCuts(20, [3, 3.2, 8]);
  // 3〜3.2 の 0.2秒は隣とまとめる。8〜20 の12秒は分ける
  assert.equal(s[0]!.start, 0);
  assert.ok(s.every((x) => x.end - x.start >= 0.6));
  const long = s.filter((x) => x.start >= 8);
  assert.ok(long.length >= 3);
  assert.ok(long.every((x) => x.group === long[0]!.group));
  assert.equal(s[s.length - 1]!.end, 20);
});

const shot = (id: string, group = id, len = 3): Shot => ({ id, assetId: 'v', start: 0, end: len, group, image: false });

test('割り当て: Claude が同じ場面ばかり挙げても、近いカットでは重ならない', () => {
  const shots = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((x) => shot(x));
  const cuts = Array.from({ length: 12 }, () => ({ durationSec: 1.5, choices: ['A', 'B'] }));
  const out = planAssignments(cuts, shots, gapFor(shots.length, shots.length)).map((x) => x.shot.id);
  const gap = gapFor(shots.length, shots.length).minGap;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j <= Math.min(out.length - 1, i + gap); j++) assert.notEqual(out[i], out[j], `${i},${j}: ${out.join(' ')}`);
  }
  // 候補の1つ目・2つ目を先に使う
  assert.deepEqual(out.slice(0, 2), ['A', 'B']);
  // 場面を満遍なく使う
  assert.equal(new Set(out).size, 8);
});

test('割り当て: 同じ長い場面の一部は連続させない。場面が少なくても連続はしない', () => {
  const shots = [shot('L1', 'L'), shot('L2', 'L'), shot('L3', 'L'), shot('X')];
  const out = planAssignments(
    Array.from({ length: 6 }, () => ({ durationSec: 1, choices: ['L1', 'L2', 'L3'] })),
    shots,
    gapFor(4, 2),
  ).map((x) => x.shot);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i]!.group, out[i - 1]!.group, out.map((s) => s.id).join(' '));
  const two = planAssignments(Array.from({ length: 5 }, () => ({ durationSec: 1, choices: ['A'] })), [shot('A'), shot('B')], gapFor(2, 2)).map((x) => x.shot.id);
  for (let i = 1; i < two.length; i++) assert.notEqual(two[i], two[i - 1]);
});

test('割り当て: 最初と最後のように離れていれば同じ場面を使ってよい', () => {
  const shots = ['A', 'B', 'C', 'D'].map((x) => shot(x));
  const out = planAssignments(
    [{ durationSec: 1, choices: ['A'] }, { durationSec: 1, choices: ['B'] }, { durationSec: 1, choices: ['C'] }, { durationSec: 1, choices: ['D'] }, { durationSec: 1, choices: ['A'] }],
    shots,
    gapFor(4, 4),
  ).map((x) => x.shot.id);
  assert.deepEqual(out, ['A', 'B', 'C', 'D', 'A']);
});
