import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMotions, compileExpr, evalMotion, motionExprs, toFfmpegExpr, MOTION_LABELS } from '../shared/motion.js';
import { buildCaptions, DEFAULT_SEGMENT_OPTIONS, regroupToWords, splitLongScenes } from '../shared/segment.js';
import { buildTimeline } from '../shared/timemap.js';
import { SR, type MotionType, type Scene, type Token } from '../shared/types.js';

const W = 1080;
const H = 1920;

test('どの動きも、拡大で生まれた余白の内側でしか動かない(端に黒が出ない)', () => {
  for (const type of Object.keys(MOTION_LABELS) as MotionType[]) {
    for (const strength of [0.3, 1, 2]) {
      const ex = motionExprs({ type, strength }, 1.5, W, H);
      if (type === 'none') {
        assert.equal(ex, null);
        continue;
      }
      for (let T = 0; T <= 1.5; T += 1 / 30) {
        const m = evalMotion(ex!, T);
        assert.ok(m.s >= 1, `${type} s=${m.s}`);
        assert.ok(Math.abs(m.dx) <= ((m.s - 1) * W) / 2 + 0.5, `${type} dx=${m.dx} s=${m.s}`);
        assert.ok(Math.abs(m.dy) <= ((m.s - 1) * H) / 2 + 0.5, `${type} dy=${m.dy} s=${m.s}`);
      }
    }
  }
});

test('動きの式はプレビュー用と書き出し用で同じ(T をフレーム番号から計算した秒に置き換えるだけ)', () => {
  const ex = motionExprs({ type: 'shake', strength: 1 }, 2, W, H)!;
  const ff = toFfmpegExpr(ex.dx, 30);
  assert.ok(!/\bT\b/.test(ff) && ff.includes('(n/30)'));
  // FFmpeg の式を n を変数にして JS で評価すると、プレビューの値と一致する
  const asJs = compileExpr(ff.replace(/\(n\/30\)/g, '(T)'));
  for (const n of [0, 7, 29, 45]) assert.equal(asJs(n / 30), evalMotion(ex, n / 30).dx);
  // 動きには意味のある変化がある
  const z = motionExprs({ type: 'zoomIn', strength: 1 }, 2, W, H)!;
  assert.ok(evalMotion(z, 2).s > evalMotion(z, 0).s + 0.05);
  const pi = motionExprs({ type: 'punchIn', strength: 1 }, 2, W, H)!;
  assert.ok(evalMotion(pi, 0.2).s > 1.1 && evalMotion(pi, 0).s < 1.01);
});

test('おまかせの動き: 連続で同じにせず、「！」のカットは強めの動き', () => {
  const scenes: Scene[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, srcStart: i, srcEnd: i + 1, bg: null, inset: null }));
  const texts = ['色黒女子は', '全員これ使え！', 'まず', '白玉点滴とか', '美容医療に', '手出す前に', '家でも', '白玉ケアできる', '吸収率7.9倍！', 'すごい', 'ほんとに', 'おすすめ'];
  const ms = autoMotions(scenes, (s) => texts[Number(s.id.slice(1))]!);
  for (let i = 1; i < ms.length; i++) assert.notEqual(ms[i]!.type, ms[i - 1]!.type);
  for (const i of [0, 1, 8]) assert.ok(['punchIn', 'impact', 'shake'].includes(ms[i]!.type), `${i}: ${ms[i]!.type}`);
  assert.ok(['zoomIn', 'zoomOut', 'panLeft', 'panRight', 'panUp', 'panDown'].includes(ms[3]!.type));
});

test('whisper の細切れトークンを語に組み直して、話の区切りでテロップを分ける', () => {
  const text = '色黒女子は全員これ使え！';
  const parts = text.match(/.{1,2}/gu)!;
  let t = 0;
  const toks: Token[] = parts.map((w, i) => {
    const d = Array.from(w).length * 0.11 * SR;
    const o: Token = { id: `t${i}`, text: w, start: Math.round(t), end: Math.round(t + d), p: 0.9, seg: 0, timing: 'token' };
    t += d;
    return o;
  });
  const words = regroupToWords(toks);
  assert.equal(words.map((w) => w.token.text).join(''), text);
  assert.ok(words.some((w) => w.token.text === '女子'));
  const caps = buildCaptions(toks, null, { ...DEFAULT_SEGMENT_OPTIONS, charsPerLine: 8, maxLines: 1, captionMinSec: 0.4, captionMaxSec: 1.6 });
  assert.deepEqual(caps.map((c) => c.text), ['色黒女子は', '全員これ使え！']);
  // 元のトークンIDは保持される(テロップの分割などに使う)
  assert.ok(caps[0]!.tokenIds.every((id) => /^t\d+$/.test(id)));
  assert.equal(caps.flatMap((c) => c.tokenIds).length >= toks.length, true);
});

test('冒頭だけさらに細かく切る', () => {
  const tl = buildTimeline(10 * SR, []);
  const scenes: Scene[] = [{ id: 'a', srcStart: 0, srcEnd: 4 * SR, bg: null, inset: null }, { id: 'b', srcStart: 4 * SR, srcEnd: 10 * SR, bg: null, inset: null }];
  const out = splitLongScenes(scenes, [], tl, { ...DEFAULT_SEGMENT_OPTIONS, sceneMinSec: 1, sceneMaxSec: 2, introSec: 3, introMaxSec: 0.8 });
  const first = out.filter((s) => s.srcEnd <= 4 * SR);
  const rest = out.filter((s) => s.srcStart >= 4 * SR);
  for (const s of first) assert.ok((s.srcEnd - s.srcStart) / SR <= 0.81, `冒頭 ${(s.srcEnd - s.srcStart) / SR}`);
  for (const s of rest) assert.ok((s.srcEnd - s.srcStart) / SR <= 2.01 && (s.srcEnd - s.srcStart) / SR > 1.5);
});

test('メリハリ: 冒頭は細かく、強調は速く、説明は長めで、速いカットが続きすぎない', async () => {
  const { applyRhythm } = await import('../shared/segment.js');
  const tl = buildTimeline(30 * SR, []);
  const tokens: Token[] = [];
  for (let t = 0, i = 0; t < 29.8; t += 0.25, i++) tokens.push({ id: `t${i}`, text: 'あ', start: Math.round(t * SR), end: Math.round((t + 0.2) * SR), p: 0.9, seg: 0, timing: 'token' });
  // 3秒ずつのシーン。8〜11秒は強調(！)、それ以外は説明
  const scenes: Scene[] = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, srcStart: i * 3 * SR, srcEnd: (i + 1) * 3 * SR, bg: null, inset: null }));
  const caps = scenes.map((s, i) => ({ id: `c${i}`, srcStart: s.srcStart + 0.1 * SR, srcEnd: s.srcEnd - 0.1 * SR, tokenIds: [], rawText: i === 3 ? 'すごい！' : '説明です', text: '', textEdited: false, timingEdited: false }));
  const out = applyRhythm(scenes, tokens, tl, caps, { ...DEFAULT_SEGMENT_OPTIONS, sceneMinSec: 1.5, sceneMaxSec: 3, introSec: 3, introMaxSec: 0.7 });
  const d = out.map((s) => (s.srcEnd - s.srcStart) / SR);
  const start = out.map((s) => s.srcStart / SR);
  // 冒頭3秒は 0.7秒以下
  out.forEach((_, i) => start[i]! < 3 && assert.ok(d[i]! <= 0.76, `冒頭 ${d[i]}`));
  // 強調(9〜12秒)は約1秒以下
  out.forEach((_, i) => start[i]! >= 9 && start[i]! < 12 && assert.ok(d[i]! <= 1.15, `強調 ${d[i]}`));
  // 長いカット(2秒以上)と短いカットの両方がある
  assert.ok(d.some((x) => x >= 2.5) && d.filter((x) => x < 1.3).length >= 5, d.map((x) => x.toFixed(2)).join(' '));
  // 説明の区間では、速いカットが4つ以上続かない
  let run = 0;
  out.forEach((_, i) => {
    if (start[i]! < 12) return;
    run = d[i]! < 1.3 ? run + 1 : 0;
    assert.ok(run <= 3, `速いカットが続きすぎ: ${d.map((x) => x.toFixed(2)).join(' ')}`);
  });
  console.log('カットの長さ:', d.map((x) => x.toFixed(1)).join(' '));
});
