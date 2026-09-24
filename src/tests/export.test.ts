import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrt, sceneSpans } from '../server/export.js';
import { createProject } from '../shared/project.js';
import { buildTimeline, totalFrames } from '../shared/timemap.js';
import { SR } from '../shared/types.js';

test('シーンのフレーム範囲は隙間なく並び、合計が出力全体のフレーム数と一致する', () => {
  const src = Math.round(20.3333 * SR);
  const removes = [];
  for (let i = 1; i < 19; i++) removes.push({ start: i * SR + 1234, end: i * SR + 1234 + Math.round(0.173 * SR) });
  const tl = buildTimeline(src, removes, 4);
  const p = createProject('ptest', 't');
  const bounds = [0, 3.1, 7.77, 7.8, 12.05, 18.4].map((s) => Math.round(s * SR));
  p.scenes = bounds.map((b, i) => ({ id: `s${i}`, srcStart: b, srcEnd: bounds[i + 1] ?? src, bg: null, inset: null }));
  p.timeline = tl;
  const spans = sceneSpans(p, tl, 30);
  assert.equal(spans[0]!.f0, 0);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i]!.f0, spans[i - 1]!.f1);
  assert.equal(spans[spans.length - 1]!.f1, totalFrames(tl.outSamples, 30));
});

test('SRT は出力時刻で書き出す', () => {
  const srt = buildSrt([
    { id: 'b', outStart: 2 * SR, outEnd: Math.round(3.5 * SR), text: '二つ目', file: '' },
    { id: 'a', outStart: 0, outEnd: Math.round(1.25 * SR), text: '一つ目\n改行', file: '' },
  ]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,250\n一つ目\n改行\n\n2\n00:00:02,000 --> 00:00:03,500\n二つ目\n\n');
});
