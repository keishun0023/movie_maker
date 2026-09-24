import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalysis, CUT_PRESETS, decideCuts, detectSilences, flagTokens, protectBySpeech } from '../shared/silence.js';
import { buildTimeline, srcToOut } from '../shared/timemap.js';
import { SR, type Token } from '../shared/types.js';

/** 発話の代わりにトーンを鳴らす合成音声。spans は [開始秒, 終了秒, 振幅] */
function synth(totalSec: number, spans: [number, number, number][], noise = 0): Float32Array {
  const a = new Float32Array(Math.round(totalSec * SR));
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < a.length; i++) a[i] = noise * rnd();
  for (const [s, e, amp] of spans) {
    for (let i = Math.round(s * SR); i < Math.round(e * SR); i++) a[i]! += amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return a;
}

test('即カット: 長い無音を削り、発話は1サンプルも削らない', () => {
  const speech: [number, number, number][] = [
    [0.5, 1.5, 0.5],
    [2.8, 4.0, 0.5],
    [4.25, 5.0, 0.5], // 250ms の短い間
    [7.0, 8.0, 0.5],
  ];
  const pcm = synth(9, speech, 0.0005);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a, 0, 50);
  const params = CUT_PRESETS.jumpcut.params;
  const cuts = decideCuts(cands, params, a.durationSamples);
  const tl = buildTimeline(a.durationSamples, cuts);
  // 発話区間と削除区間が重ならない
  for (const [s, e] of speech) {
    for (const c of cuts) {
      assert.ok(c.end <= Math.round(s * SR) || c.start >= Math.round(e * SR), `発話 ${s}-${e} を削っている: ${c.start / SR}-${c.end / SR}`);
    }
    // 発話の長さは出力でも同じ
    const outLen = srcToOut(tl, Math.round(e * SR)) - srcToOut(tl, Math.round(s * SR));
    assert.equal(outLen, Math.round(e * SR) - Math.round(s * SR));
  }
  // 長い無音(1.5-2.8, 5.0-7.0)は余白だけ残して縮む
  const gap1 = srcToOut(tl, 2.8 * SR) - srcToOut(tl, 1.5 * SR);
  const gap2 = srcToOut(tl, 7.0 * SR) - srcToOut(tl, 5.0 * SR);
  const expectedMax = ((params.padAfterMs + params.padBeforeMs + 30) / 1000) * SR; // 10ms フレーム誤差ぶん
  assert.ok(gap1 <= expectedMax, `gap1=${gap1 / SR}`);
  assert.ok(gap2 <= expectedMax, `gap2=${gap2 / SR}`);
  // 250ms の間も即カット対象
  const gap3 = srcToOut(tl, 4.25 * SR) - srcToOut(tl, 4.0 * SR);
  assert.ok(gap3 < 0.25 * SR);
  // 冒頭の無音はほぼ無くなる
  assert.ok(srcToOut(tl, 0.5 * SR) <= 0.05 * SR);
  assert.ok(tl.outSamples < 5.2 * SR, `total=${tl.outSamples / SR}`);
});

test('自然プリセット: 350ms未満の間は残し、長い間は180ms程度に縮める', () => {
  const pcm = synth(6, [
    [0.2, 1.0, 0.5],
    [1.3, 2.0, 0.5], // 300ms
    [3.5, 4.5, 0.5], // 1.5s
  ], 0.0005);
  const a = computeAnalysis(pcm);
  const cuts = decideCuts(detectSilences(a), CUT_PRESETS.natural.params, a.durationSamples);
  const tl = buildTimeline(a.durationSamples, cuts);
  const short = srcToOut(tl, 1.3 * SR) - srcToOut(tl, 1.0 * SR);
  assert.equal(short, 0.3 * SR);
  const long = (srcToOut(tl, 3.5 * SR) - srcToOut(tl, 2.0 * SR)) / SR;
  assert.ok(long > 0.15 && long < 0.23, `long=${long}`);
});

test('「この間は残す」を指定した無音は削らない', () => {
  const pcm = synth(4, [
    [0.2, 1.0, 0.5],
    [2.5, 3.0, 0.5],
  ], 0.0005);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  const cuts = decideCuts(cands, CUT_PRESETS.jumpcut.params, a.durationSamples, [{ start: 1.5 * SR, end: 1.6 * SR }]);
  assert.ok(!cuts.some((c) => c.start < 2.5 * SR && c.end > 1.0 * SR));
});

test('低音量でも認識語があり雑音より大きければ削らない', () => {
  // 1.5-2.0s に小さな発話(しきい値未満だが雑音床より大きい)
  const pcm = synth(4, [
    [0.2, 1.0, 0.5],
    [1.5, 2.0, 0.002],
    [3.0, 3.5, 0.5],
  ], 0.0003);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  const soft = cands.find((c) => c.start <= 1.5 * SR && c.end >= 2.0 * SR);
  assert.ok(soft, '小声区間は音量上は無音候補になる');
  const tok: Token = { id: 't1', text: 'はい', start: 1.55 * SR, end: 1.95 * SR, p: 0.8, seg: 0, timing: 'token' };
  const prot = protectBySpeech(cands, [tok], a);
  const target = prot.find((c) => c.id === soft!.id)!;
  assert.equal(target.protectedBySpeech, true);
  const cuts = decideCuts(prot, CUT_PRESETS.jumpcut.params, a.durationSamples);
  assert.ok(!cuts.some((c) => c.start < 1.95 * SR && c.end > 1.55 * SR));
});

test('完全な無音に出た認識語は幻覚の可能性として印を付ける', () => {
  const pcm = synth(4, [[0.2, 1.0, 0.5]], 0);
  const a = computeAnalysis(pcm);
  const toks: Token[] = [
    { id: 'a', text: 'こんにちは', start: 0.2 * SR, end: 1.0 * SR, p: 0.9, seg: 0, timing: 'token' },
    { id: 'b', text: 'ご視聴ありがとうございました', start: 2 * SR, end: 3.5 * SR, p: 0.6, seg: 1, timing: 'token' },
  ];
  const f = flagTokens(toks, a);
  assert.deepEqual(f[0]!.flags, []);
  assert.ok(f[1]!.flags!.includes('silence'));
  assert.ok(f[1]!.flags!.includes('hallucination'));
});
