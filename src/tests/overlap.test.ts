import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalysis, CUT_PRESETS, decideCuts, detectSilences, removeRangesFromCuts } from '../shared/silence.js';
import { buildTimeline, srcToOut } from '../shared/timemap.js';
import { renderEdited } from '../server/media.js';
import { SR } from '../shared/types.js';

/** [開始秒, 終了秒, 周波数] の音を並べたステレオPCM */
function voice(totalSec: number, spans: [number, number, number][]): Int16Array {
  const n = Math.round(totalSec * SR);
  const a = new Int16Array(n * 2);
  for (const [s, e, f] of spans) {
    for (let i = Math.round(s * SR); i < Math.round(e * SR); i++) {
      const v = Math.round(9000 * Math.sin((2 * Math.PI * f * i) / SR));
      a[i * 2] = v;
      a[i * 2 + 1] = v;
    }
  }
  return a;
}

function mono(a: Int16Array): Float32Array {
  const m = new Float32Array(a.length / 2);
  for (let i = 0; i < m.length; i++) m[i] = a[i * 2]! / 32768;
  return m;
}

const SPANS: [number, number, number][] = [
  [0.3, 1.5, 220],
  [1.9, 3.0, 330],
  [3.2, 4.4, 247],
];

test('被せ: 無音をなくしたうえで、前後の発話へ設定した長さだけ食い込む', () => {
  const pcm = voice(5, SPANS);
  const a = computeAnalysis(mono(pcm));
  const params = CUT_PRESETS.tsuratsura.params;
  const cands = detectSilences(a, params.sensitivityDb, 50);
  const cuts = decideCuts(cands, params, a.durationSamples);
  const gapCuts = cuts.filter((c) => c.reason === 'gap');
  assert.equal(gapCuts.length, 2);
  const ov = (params.overlapMs / 1000) * SR;
  // 1つ目の間 (1.5〜1.9s): 発話の終わり 1.5s より前から、次の発話 1.9s より後まで削る
  const g = gapCuts[0]!;
  assert.ok(g.start < 1.5 * SR && g.end > 1.9 * SR, `${g.start / SR}-${g.end / SR}`);
  const eaten = 1.5 * SR - g.start + (g.end - 1.9 * SR);
  const expected = ov - ((params.padAfterMs + params.padBeforeMs) / 1000) * SR;
  assert.ok(Math.abs(eaten - expected) < 0.012 * SR, `eaten ${eaten / SR}s expected ${expected / SR}s`);
});

test('被せ: つなぎ目はクロスフェードで重なり、音が途切れない', () => {
  const pcm = voice(5, SPANS);
  const a = computeAnalysis(mono(pcm));
  const params = CUT_PRESETS.tsuratsura.params;
  const cuts = decideCuts(detectSilences(a, params.sensitivityDb, 50), params, a.durationSamples);
  const tl = buildTimeline(a.durationSamples, removeRangesFromCuts(cuts, a.durationSamples), params.fadeMs, [], params.overlapMs);
  const out = renderEdited({ sampleRate: SR, channels: 2, data: pcm }, tl);
  assert.equal(out.data.length / 2, tl.outSamples);
  // 1つ目の発話の開始から3つ目の発話の終わりまで、5ms 窓の音量が大きく落ち込まない
  const s0 = srcToOut(tl, 0.35 * SR);
  const s1 = srcToOut(tl, 4.35 * SR);
  let minRms = Infinity;
  for (let w = s0; w + 240 < s1; w += 120) {
    let sum = 0;
    for (let i = w; i < w + 240; i++) sum += (out.data[i * 2]! / 32768) ** 2;
    minRms = Math.min(minRms, Math.sqrt(sum / 240));
  }
  assert.ok(minRms > 0.1, `つなぎ目で音量が落ちている: ${minRms}`);
  // 被せなしの即カットより短くなる
  const jc = CUT_PRESETS.jumpcut.params;
  const tlJ = buildTimeline(a.durationSamples, removeRangesFromCuts(decideCuts(detectSilences(a, jc.sensitivityDb, 50), jc, a.durationSamples), a.durationSamples), jc.fadeMs);
  assert.ok(tl.outSamples < tlJ.outSamples - 0.1 * SR, `${tl.outSamples / SR} vs ${tlJ.outSamples / SR}`);
});

test('被せ 0 の「即カット」は従来どおり発話を削らない', () => {
  const pcm = voice(5, SPANS);
  const a = computeAnalysis(mono(pcm));
  const cuts = decideCuts(detectSilences(a, 0, 50), CUT_PRESETS.jumpcut.params, a.durationSamples);
  for (const [s, e] of SPANS) for (const c of cuts) assert.ok(c.end <= s * SR || c.start >= e * SR);
});
