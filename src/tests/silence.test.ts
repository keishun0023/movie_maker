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
  // (雑音床 約 -59dB・ふだんの声 約 -23dB・小声 約 -47dB)
  const pcm = synth(4, [
    [0.2, 1.0, 0.1],
    [1.5, 2.0, 0.006],
    [3.0, 3.5, 0.1],
  ], 0.002);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  const soft = cands.find((c) => c.start <= 1.5 * SR && c.end >= 2.0 * SR);
  assert.ok(soft, '小声区間は音量上は無音候補になる');
  const tok: Token = { id: 't1', text: 'はい', start: 1.55 * SR, end: 1.95 * SR, p: 0.8, seg: 0, timing: 'token' };
  const prot = protectBySpeech(cands, [tok], a);
  assert.ok(prot.some((c) => c.protectedBySpeech && c.start <= 1.56 * SR && c.end >= 1.94 * SR), '小声の部分は守る');
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

test('文字量から推定した時刻(Gemini)の語では、無音を「発話の可能性あり」として残さない', () => {
  const pcm = synth(4, [
    [0.2, 1.0, 0.1],
    [1.5, 2.0, 0.006], // 小さな声
    [3.0, 3.5, 0.1],
  ], 0.002);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  const est: Token = { id: 'g', text: 'です', start: 1.55 * SR, end: 1.95 * SR, p: 0.9, seg: 0, timing: 'chunk' };
  assert.ok(protectBySpeech(cands, [est], a).every((c) => !c.protectedBySpeech));
  const precise: Token = { ...est, timing: 'token' };
  assert.ok(protectBySpeech(cands, [precise], a).some((c) => c.protectedBySpeech));
});

test('ほぼ無音(-85dB 程度)の間は、語の時刻がまたいでいても「発話の可能性あり」で残さない', async () => {
  const { computeAnalysis, detectSilences, protectBySpeech } = await import('../shared/silence.js');
  const SRATE = 48000;
  // 完全な無音 0.5秒(書き出し済み動画の頭などでよくある) → 声 0.8秒 → ほぼ無音 0.3秒 → 声 0.8秒
  const n = Math.round(2.4 * SRATE);
  const x = new Float32Array(n);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / SRATE;
    if (t < 0.5) x[i] = 0;
    else if (t < 1.3 || t >= 1.6) x[i] = 0.3 * Math.sin(i * 0.05);
    else x[i] = rnd() * 0.0001; // 約 -85dB のかすかな雑音
  }
  const a = computeAnalysis(x);
  const cands = detectSilences(a, 0, 50).filter((c) => c.start > 0.6 * SRATE);
  assert.equal(cands.length, 1);
  // 推定で付けた語の時刻が無音をまたいでいる
  const tok = { id: 't', text: 'だから', start: Math.round(1.2 * SRATE), end: Math.round(1.7 * SRATE), p: 0.9, seg: 0, timing: 'aligned' as const };
  assert.equal(protectBySpeech(cands, [tok], a)[0]!.protectedBySpeech, false);
});

test('発話保護は音がある所だけ。同じ間の残りの無音は詰める', () => {
  // 0.2-1.0s 声 / 1.0-2.6s 間(1.7-1.8s にだけ小さな音) / 2.6-3.4s 声
  const pcm = synth(4, [
    [0.2, 1.0, 0.1],
    [1.7, 1.8, 0.006],
    [2.6, 3.4, 0.1],
  ], 0.002);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  const tok: Token = { id: 't1', text: 'え', start: 1.68 * SR, end: 1.82 * SR, p: 0.8, seg: 0, timing: 'token' };
  const prot = protectBySpeech(cands, [tok], a);
  const cuts = decideCuts(prot, CUT_PRESETS.jumpcut.params, a.durationSamples);
  const tl = buildTimeline(a.durationSamples, cuts);
  // 小さな音は残り、間の大部分(1.6秒→0.4秒未満)は詰まる
  assert.ok(!cuts.some((c) => c.start < 1.8 * SR && c.end > 1.7 * SR), '小さな音は削らない');
  const gap = (srcToOut(tl, 2.6 * SR) - srcToOut(tl, 1.0 * SR)) / SR;
  assert.ok(gap < 0.4, `gap=${gap}`);
});

test('前の語の時刻が間に食い込んでいるだけなら、間を守らない', () => {
  const pcm = synth(4, [
    [0.2, 1.0, 0.5],
    [1.0, 1.6, 0.002], // 間に息・雑音
    [2.0, 2.8, 0.5],
  ], 0.0003);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  // 語は 0.7-1.4s: 半分以上は前の声の中
  const tok: Token = { id: 't1', text: 'ます', start: 0.7 * SR, end: 1.4 * SR, p: 0.8, seg: 0, timing: 'token' };
  assert.ok(protectBySpeech(cands, [tok], a).every((c) => !c.protectedBySpeech));
});

test('間の息・雑音(雑音床より少し大きい程度)は、語の時刻が重なっていても発話として守らない', () => {
  // 声 → 0.3秒の間(息のような小さな音が続く) → 声。雑音床は約 -63dB、息は約 -50dB
  const pcm = synth(3, [
    [0.2, 1.4, 0.3],
    [1.4, 1.7, 0.004],
    [1.7, 2.8, 0.3],
  ], 0.001);
  const a = computeAnalysis(pcm);
  const cands = detectSilences(a);
  const gap = cands.find((c) => c.start <= 1.45 * SR && c.end >= 1.65 * SR);
  assert.ok(gap, '息の間は無音候補になる');
  // 認識の時刻がずれて、短い語が間の中に入っている
  const tok: Token = { id: 't1', text: 'て', start: 1.47 * SR, end: 1.63 * SR, p: 0.8, seg: 0, timing: 'token' };
  const prot = protectBySpeech(cands, [tok], a);
  assert.ok(prot.every((c) => !c.protectedBySpeech));
  const tl = buildTimeline(a.durationSamples, decideCuts(prot, CUT_PRESETS.jumpcut.params, a.durationSamples));
  const left = (srcToOut(tl, 1.7 * SR) - srcToOut(tl, 1.4 * SR)) / SR;
  assert.ok(left < 0.12, `left=${left}`);
});
