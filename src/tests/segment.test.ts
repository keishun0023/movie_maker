import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptions, buildScenes, captionOutputTimings, mergeCaptions } from '../shared/segment.js';
import { wrapText, displayFromRaw, estimateWidth, NO_LINE_START } from '../shared/jatext.js';
import { buildTimeline, srcToOut } from '../shared/timemap.js';
import { hintTerms, suggestFromScript } from '../shared/script.js';
import { SR, type Token } from '../shared/types.js';

/** 文字列を語ごとに区切ってトークン列を作る(1文字 = 0.12秒、| は 0.4 秒の間) */
function tokensFrom(text: string, startSec = 0.3): Token[] {
  const out: Token[] = [];
  let t = startSec * SR;
  let i = 0;
  for (const part of text.split(/(\|)/)) {
    if (part === '|') {
      t += 0.4 * SR;
      continue;
    }
    for (const w of part.split('/')) {
      if (!w) continue;
      const d = Array.from(w).length * 0.12 * SR;
      out.push({ id: `t${i++}`, text: w, start: Math.round(t), end: Math.round(t + d), p: 0.9, seg: 0, timing: 'token' });
      t += d;
    }
  }
  return out;
}

const TEXT = '今日は/みなさんに/とっておきの/節約術を/紹介します。|まず/一つ目は/コンビニで/買い物を/しないこと。|なぜなら/ついで買いが/増えて/しまうから/です。|二つ目は/固定費の/見直しです。|スマホの/プランを/変えるだけで/月に/3000円/安く/なります。';

test('テロップは文字数と長さの目安に収まり、語の途中で切れない', () => {
  const toks = tokensFrom(TEXT);
  const caps = buildCaptions(toks, null);
  assert.ok(caps.length >= 6, `caps=${caps.length}`);
  for (const c of caps) {
    assert.ok(estimateWidth(c.text) <= 22, `長すぎる: ${c.text}`);
    const first = Array.from(c.text)[0]!;
    assert.ok(!NO_LINE_START.has(first), `禁則文字で始まる: ${c.text}`);
  }
  // 原文は失われない(連結すると元に戻る)
  assert.equal(caps.map((c) => c.rawText).join(''), toks.map((t) => t.text).join(''));
  // 文末(。)の直後で切れている
  const joined = caps.map((c) => c.rawText);
  assert.ok(joined.some((r) => r.endsWith('紹介します。')));
  assert.ok(joined.some((r) => r.endsWith('しないこと。')));
});

test('シーンは元音声全体を隙間なく覆い、テロップ境界にそろう', () => {
  const toks = tokensFrom(TEXT);
  const dur = toks[toks.length - 1]!.end + 0.5 * SR;
  const tl = buildTimeline(dur, [{ start: 0, end: 0.2 * SR }]);
  const caps = buildCaptions(toks, tl);
  const scenes = buildScenes(caps, tl, dur);
  assert.equal(scenes[0]!.srcStart, 0);
  assert.equal(scenes[scenes.length - 1]!.srcEnd, dur);
  for (let i = 1; i < scenes.length; i++) assert.equal(scenes[i]!.srcStart, scenes[i - 1]!.srcEnd);
  for (const s of scenes) {
    const d = (srcToOut(tl, s.srcEnd) - srcToOut(tl, s.srcStart)) / SR;
    assert.ok(d > 0.8 && d < 8, `scene ${d}s`);
  }
});

test('表示時刻は対応表を通して計算され、無音カット後もずれない', () => {
  const toks = tokensFrom('こんにちは。|今日は/いい天気/ですね。');
  const dur = toks[toks.length - 1]!.end + SR;
  // 間(0.4s)を削る
  const gapStart = toks[0]!.end + 0.05 * SR;
  const gapEnd = toks[1]!.start - 0.03 * SR;
  const tl = buildTimeline(dur, [{ start: gapStart, end: gapEnd }]);
  const caps = buildCaptions(toks, tl);
  const times = captionOutputTimings(caps, tl);
  const second = caps.find((c) => c.rawText.startsWith('今日は'))!;
  const t2 = times.find((t) => t.id === second.id)!;
  // 2つ目のテロップの出力開始 = 元の開始 - 削除した長さ
  assert.equal(t2.outStart, second.srcStart - (gapEnd - gapStart));
});

test('禁則を守って2行に折り返し、行幅をそろえる', () => {
  const measure = (t: string) => estimateWidth(t) * 76;
  const lines = wrapText('プランを変えるだけで月に3000円安くなります', 880, measure, 2);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(measure(l) <= 880, l);
  assert.ok(!NO_LINE_START.has(Array.from(lines[1]!)[0]!));
  assert.ok(!lines.join('|').includes('30|00'), '数字の途中で改行しない');
  // 手動改行は尊重する
  assert.deepEqual(wrapText('一行目\n二行目', 880, measure, 2), ['一行目', '二行目']);
  // 句読点は行頭に来ない
  const l2 = wrapText('ああああああああああああ、いいいいいいい', 76 * 12, measure, 2);
  assert.ok(!l2[1]!.startsWith('、'));
});

test('表示用テキストは句点だけを外し、言い換えない', () => {
  assert.equal(displayFromRaw('今日は、いい天気ですね。'), '今日は、いい天気ですね');
  assert.equal(displayFromRaw(' 3000円安くなります。'), '3000円安くなります');
});

test('再生成しても手動修正したテロップは保持される', () => {
  const toks = tokensFrom(TEXT);
  const caps = buildCaptions(toks, null);
  const edited = caps.map((c, i) => (i === 1 ? { ...c, text: '手で直した', textEdited: true } : c));
  const fresh = buildCaptions(toks, null);
  const merged = mergeCaptions(edited, fresh);
  assert.ok(merged.some((c) => c.text === '手で直した'));
  // 重なる自動テロップは入らない
  const manual = merged.find((c) => c.text === '手で直した')!;
  assert.ok(!merged.some((c) => c !== manual && c.srcStart < manual.srcEnd && c.srcEnd > manual.srcStart));
});

test('台本から認識ヒントと表記候補を作る(自動挿入はしない)', () => {
  const script = 'スマホのプランをアハモに変えるだけで、月に3000円安くなります。';
  const hints = hintTerms(script);
  assert.ok(hints.includes('アハモ'));
  assert.ok(hints.some((h) => h.startsWith('3000')));
  const s = suggestFromScript('スマホのプランをアハものに変えるだけで', script);
  assert.ok(s && s.text.includes('アハモに'));
  assert.equal(suggestFromScript('全く関係のない話題です', script), null);
});

test('短く区切る: 「誰でも / 憧れの」のような細切れや、語と助詞の間では切らない', async () => {
  const { tokensFromChunks } = await import('../shared/chunks.js');
  const { buildCaptions, DEFAULT_SEGMENT_OPTIONS } = await import('../shared/segment.js');
  const texts = ['吸収率7.9倍のナノリポソームVC配合で', '誰でも憧れの白玉肌目指せちゃう！', 'Amazonランキングも1位の超人気商品なんだけど', 'だから気になる人はちゃんと公式から買ってほしい！', '韓国でも話題の美容成分10種と'];
  let t = 0;
  const chunks = texts.map((x) => {
    const d = x.length / 8.5;
    const c = { start: Math.round(t * 48000), end: Math.round((t + d) * 48000) };
    t += d + 0.25;
    return c;
  });
  const caps = buildCaptions(tokensFromChunks(chunks, texts), null, { ...DEFAULT_SEGMENT_OPTIONS, charsPerLine: 11, maxLines: 1, captionMinSec: 0.5, captionMaxSec: 2.2, minChars: 5 });
  const out = caps.map((c) => c.text.replace(/\n/g, ''));
  assert.ok(out.includes('誰でも憧れの'), out.join(' / '));
  assert.ok(out.includes('だから気になる人は'), out.join(' / '));
  assert.ok(out.includes('韓国でも'), out.join(' / '));
  assert.ok(!out.some((x) => /^(の|でも|は)/.test(x)), out.join(' / '));
});
