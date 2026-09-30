import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensFromChunks } from '../shared/chunks.js';
import { alignChunkTokens } from '../shared/align.js';
import { buildCaptions } from '../shared/segment.js';
import { SR, type Token } from '../shared/types.js';

/** 文字ごとの本当の時刻から、whisper 風の時刻付きトークン(誤字あり)を作る */
function fakeWhisper(text: string, times: number[], typo: (i: number) => string | null): Token[] {
  const cs = Array.from(text);
  const out: Token[] = [];
  for (let i = 0; i < cs.length; i += 2) {
    const t = cs
      .slice(i, i + 2)
      .map((c, k) => typo(i + k) ?? c)
      .join('');
    out.push({ id: `w${i}`, text: t, start: Math.round(times[i]! * SR), end: Math.round((times[i + 2] ?? times[i]! + 0.15) * SR), p: 0.8, seg: 0, timing: 'dtw' });
  }
  return out;
}

test('話す速さが途中で変わっても、whisper の時刻に合わせてテロップの開始がずれない', () => {
  // 前半はゆっくり(0.2秒/文字)、後半は早口(0.07秒/文字)
  const a = 'モテ白肌なりたい人は';
  const b = '今すぐチェック';
  const text = a + b;
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    times.push(t);
    t += i < a.length ? 0.2 : 0.07;
  }
  const chunk = { start: 0, end: Math.round(t * SR) };
  const est = tokensFromChunks([chunk], [text + '！']);
  // 誤字を混ぜる(3文字に1文字)
  const timed = fakeWhisper(text, times, (i) => (i % 3 === 1 ? 'ぬ' : null));
  const { tokens, stats } = alignChunkTokens(est, timed);
  assert.equal(stats.aligned, 1);
  assert.ok(tokens.every((x) => x.timing === 'aligned'));
  const startOf = (toks: Token[], word: string) => {
    const k = toks.findIndex((x) => x.text.startsWith(word));
    return toks[k]!.start / SR;
  };
  const truth = times[a.length]!;
  const before = Math.abs(startOf(est, '今') - truth);
  const after = Math.abs(startOf(tokens, '今') - truth);
  assert.ok(before > 0.3, `推定のずれが再現していない: ${before}`);
  assert.ok(after < 0.08, `合わせた後もずれている: ${after}`);
  // 時刻は逆行しない
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i]!.start >= tokens[i - 1]!.start);
  const caps = buildCaptions(tokens, null);
  assert.ok(caps.length >= 1);
});

test('whisper の文字がほとんど一致しない音声片は、推定時刻のまま残す', () => {
  const text = '白玉点滴とか美容医療に手出す前に';
  const est = tokensFromChunks([{ start: 0, end: 3 * SR }], [text]);
  const timed: Token[] = [{ id: 'w0', text: 'ありがとうございました', start: 0, end: 3 * SR, p: 0.5, seg: 0, timing: 'dtw' }];
  const { tokens, stats } = alignChunkTokens(est, timed);
  assert.equal(stats.aligned, 0);
  assert.deepEqual(tokens, est);
});
