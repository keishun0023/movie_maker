// 認識トークンからテロップとシーンを自動生成する。
// 句読点・接続表現・発話の間・表示文字量を組み合わせた動的計画法で区切る。
import { SR, type Caption, type Scene, type Timeline, type Token } from './types.js';
import { charClass, displayFromRaw, estimateWidth } from './jatext.js';
import { msToSamples, srcToOut } from './timemap.js';

export interface SegmentOptions {
  /** 1行あたりの全角文字数の目安 */
  charsPerLine: number;
  maxLines: number;
  captionMinSec: number;
  captionMaxSec: number;
  sceneMinSec: number;
  sceneMaxSec: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  charsPerLine: 11,
  maxLines: 2,
  captionMinSec: 0.8,
  captionMaxSec: 3.0,
  sceneMinSec: 2.0,
  sceneMaxSec: 5.0,
};

const SENTENCE_END = /[。！？!?]$/;
const COMMA_END = /[、，,]$/;
const CONJ_PARTICLE_END = /(けど|けれど|けれども|から|ので|のに|たら|なら|ながら|し|が|て|で|ば)$/;
const CASE_PARTICLE_END = /(は|を|に|へ|と|も|や)$/;
const CONJ_START = /^(でも|だから|しかし|そして|なので|それで|ただ|実は|つまり|まず|次に|さらに|ちなみに|結局|要するに|ところが|それから|あと|なぜなら|例えば)/;

export function usableTokens(tokens: Token[]): Token[] {
  return tokens.filter(
    (t) => t.text.trim() !== '' && !t.flags?.includes('silence') && !t.flags?.includes('hallucination'),
  );
}

/** トークン i と i+1 の間で区切るときの良さ(大きいほど区切りやすい) */
export function boundaryScore(tokens: Token[], i: number, tl: Timeline | null): number {
  const a = tokens[i]!;
  const b = tokens[i + 1];
  if (!b) return 10;
  const at = a.text.trim();
  const bt = b.text.trim();
  if (bt === '') return 0;
  const firstB = Array.from(bt)[0]!;
  const lastA = Array.from(at).slice(-1)[0] ?? '';
  // 句読点や小書き文字・長音の前では切らない
  if (/^[、。，．,.!！?？ーぁぃぅぇぉっゃゅょァィゥェォッャュョ」』）)]/.test(firstB)) return -100;
  let s = 0;
  if (SENTENCE_END.test(at)) s += 10;
  else if (COMMA_END.test(at)) s += 6;
  else if (CONJ_PARTICLE_END.test(at)) s += 3;
  else if (CASE_PARTICLE_END.test(at)) s += 1.5;
  if (CONJ_START.test(bt)) s += 3;
  // 発話の間(元音声での隙間)
  const gap = (b.start - a.end) / SR;
  if (gap >= 0.3) s += 6;
  else if (gap >= 0.15) s += 4;
  else if (gap >= 0.08) s += 1.5;
  // 無音カットをまたぐ
  if (tl && srcToOut(tl, b.start) - srcToOut(tl, a.end) < b.start - a.end - msToSamples(30)) s += 1.5;
  // 語の途中らしい切れ目
  const ca = charClass(lastA);
  const cb = charClass(firstB);
  if (ca === 'kata' && cb === 'kata') s -= 5;
  else if (ca === 'kanji' && cb === 'kanji') s -= 2.5;
  else if (ca === 'kanji' && cb === 'hira') s -= 2;
  else if ((ca === 'latin' || ca === 'digit') && (cb === 'latin' || cb === 'digit')) s -= 5;
  else if (ca === 'hira' && cb === 'hira' && s < 1) s -= 1.5;
  return s;
}

function tokenOut(tl: Timeline | null, s: number): number {
  return tl ? srcToOut(tl, s) : s;
}

/** トークン列をテロップ単位に分割する(インデックス範囲の配列) */
export function splitIntoCaptionRanges(tokens: Token[], tl: Timeline | null, opt: SegmentOptions): [number, number][] {
  const n = tokens.length;
  if (n === 0) return [];
  const maxChars = opt.charsPerLine * opt.maxLines;
  const scores = tokens.map((_, i) => boundaryScore(tokens, i, tl));
  const widths = tokens.map((t) => estimateWidth(displayFromRaw(t.text) || t.text.trim()));
  const cost: number[] = new Array(n + 1).fill(Infinity);
  const prev: number[] = new Array(n + 1).fill(-1);
  cost[0] = 0;
  const MAX_TOKENS = 48;
  for (let j = 1; j <= n; j++) {
    let chars = 0;
    for (let i = j - 1; i >= Math.max(0, j - MAX_TOKENS); i--) {
      chars += widths[i]!;
      if (chars > maxChars && i < j - 1) break;
      if (!isFinite(cost[i]!)) continue;
      const dur = (tokenOut(tl, tokens[j - 1]!.end) - tokenOut(tl, tokens[i]!.start)) / SR;
      let c = 2.0; // テロップ1枚ごとの基本コスト(細切れ防止)
      if (dur < opt.captionMinSec) c += (opt.captionMinSec - dur) * 8;
      if (dur > opt.captionMaxSec) c += (dur - opt.captionMaxSec) * 5;
      if (chars < 4) c += (4 - chars) * 0.8;
      if (chars > opt.charsPerLine) c += (chars - opt.charsPerLine) * 0.08; // 2行目は少しだけ避ける
      if (chars > maxChars) c += 50;
      const bs = j < n ? scores[j - 1]! : 0;
      c -= bs;
      if (bs <= -100) c += 1000;
      const total = cost[i]! + c;
      if (total < cost[j]!) {
        cost[j] = total;
        prev[j] = i;
      }
    }
  }
  const ranges: [number, number][] = [];
  let j = n;
  while (j > 0) {
    const i = prev[j]!;
    if (i < 0) {
      ranges.push([0, j]);
      break;
    }
    ranges.push([i, j]);
    j = i;
  }
  return ranges.reverse();
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}${idCounter.toString(36)}`;
}

export function joinTokenText(tokens: Token[]): string {
  return tokens.map((t) => t.text).join('').replace(/^\s+/, '');
}

/** トークンからテロップを生成する */
export function buildCaptions(tokens: Token[], tl: Timeline | null, opt: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): Caption[] {
  const use = usableTokens(tokens);
  const ranges = splitIntoCaptionRanges(use, tl, opt);
  return ranges.map(([i, j]) => {
    const toks = use.slice(i, j);
    const raw = joinTokenText(toks);
    const lowConf = toks.some((t) => t.flags?.includes('lowConf'));
    const segmentOnly = toks.every((t) => t.timing === 'segment');
    const review = lowConf ? '認識の確からしさが低い語を含みます' : segmentOnly ? '語単位の時刻が取れていません' : undefined;
    const cap: Caption = {
      id: newId('cap'),
      srcStart: toks[0]!.start,
      srcEnd: toks[toks.length - 1]!.end,
      tokenIds: toks.map((t) => t.id),
      rawText: raw,
      text: displayFromRaw(raw),
      textEdited: false,
      timingEdited: false,
    };
    if (review) cap.review = review;
    return cap;
  });
}

/** テロップのまとまりからシーンを作る。シーンは元音声全体を隙間なく覆う */
export function buildScenes(captions: Caption[], tl: Timeline | null, srcSamples: number, opt: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): Scene[] {
  if (captions.length === 0) {
    return [{ id: newId('scn'), srcStart: 0, srcEnd: srcSamples, bg: null, inset: null }];
  }
  const n = captions.length;
  const outOf = (s: number) => tokenOut(tl, s);
  // 境界候補の良さ: 句点で終わるテロップの後は切りやすい
  const bscore = captions.map((c, i) => {
    const next = captions[i + 1];
    if (!next) return 0;
    let s = 0;
    if (SENTENCE_END.test(c.rawText.trim())) s += 4;
    else if (COMMA_END.test(c.rawText.trim())) s += 1.5;
    const gap = (next.srcStart - c.srcEnd) / SR;
    if (gap > 0.25) s += 2;
    if (CONJ_START.test(next.rawText.trim())) s += 1;
    return s;
  });
  const cost: number[] = new Array(n + 1).fill(Infinity);
  const prev: number[] = new Array(n + 1).fill(-1);
  cost[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (!isFinite(cost[i]!)) continue;
      const start = i === 0 ? 0 : outOf(captions[i]!.srcStart);
      const end = j === n ? outOf(srcSamples) : outOf(captions[j]!.srcStart);
      const dur = (end - start) / SR;
      let c = 1.5;
      if (dur < opt.sceneMinSec) c += (opt.sceneMinSec - dur) * 4;
      if (dur > opt.sceneMaxSec) c += (dur - opt.sceneMaxSec) * 4;
      c -= j < n ? bscore[j - 1]! : 0;
      const total = cost[i]! + c;
      if (total < cost[j]!) {
        cost[j] = total;
        prev[j] = i;
      }
      if (dur > opt.sceneMaxSec * 3) break;
    }
  }
  const groups: [number, number][] = [];
  let j = n;
  while (j > 0) {
    const i = Math.max(0, prev[j]!);
    groups.push([i, j]);
    j = i;
  }
  groups.reverse();
  const scenes: Scene[] = [];
  groups.forEach(([i, j], k) => {
    const srcStart = k === 0 ? 0 : sceneBoundary(captions[i - 1]!, captions[i]!);
    const srcEnd = k === groups.length - 1 ? srcSamples : sceneBoundary(captions[j - 1]!, captions[j]!);
    scenes.push({ id: newId('scn'), srcStart, srcEnd, bg: null, inset: null });
  });
  return scenes;
}

/** 2つのテロップの間のシーン境界(元音声の位置)。無音の中央に置く */
function sceneBoundary(a: Caption, b: Caption): number {
  if (b.srcStart <= a.srcEnd) return b.srcStart;
  return Math.round((a.srcEnd + b.srcStart) / 2);
}

export interface CaptionTiming {
  id: string;
  outStart: number;
  outEnd: number;
}

/**
 * 表示用の出力時刻を計算する(プレビューと書き出しで共通)。
 * 次のテロップまでの隙間が短ければ表示を延ばしてちらつきを防ぐ。
 */
export function captionOutputTimings(captions: Caption[], tl: Timeline | null, holdGapSec = 0.6): CaptionTiming[] {
  const sorted = [...captions].sort((a, b) => a.srcStart - b.srcStart);
  const base = sorted.map((c) => ({ id: c.id, outStart: tokenOut(tl, c.srcStart), outEnd: tokenOut(tl, c.srcEnd), edited: c.timingEdited }));
  const hold = Math.round(holdGapSec * SR);
  for (let i = 0; i < base.length; i++) {
    const cur = base[i]!;
    const next = base[i + 1];
    if (next) {
      if (cur.outEnd > next.outStart) cur.outEnd = next.outStart;
      else if (!cur.edited && next.outStart - cur.outEnd <= hold) cur.outEnd = next.outStart;
    }
  }
  return base.filter((c) => c.outEnd > c.outStart).map(({ id, outStart, outEnd }) => ({ id, outStart, outEnd }));
}

/** シーンの出力範囲 */
export function sceneOutputRanges(scenes: Scene[], tl: Timeline | null): { id: string; outStart: number; outEnd: number }[] {
  return scenes.map((s) => ({ id: s.id, outStart: tokenOut(tl, s.srcStart), outEnd: tokenOut(tl, s.srcEnd) }));
}

/**
 * 再解析後のテロップの統合。手動で直した文章・時刻は保持し、
 * 新しい認識結果と重なる自動テロップだけを置き換える。
 */
export function mergeCaptions(oldCaps: Caption[], fresh: Caption[]): Caption[] {
  const kept = oldCaps.filter((c) => c.textEdited || c.timingEdited || c.style);
  const result: Caption[] = [...kept];
  for (const f of fresh) {
    const overlap = kept.some((k) => k.srcStart < f.srcEnd && k.srcEnd > f.srcStart);
    if (!overlap) result.push(f);
  }
  return result.sort((a, b) => a.srcStart - b.srcStart);
}

/**
 * シーン再生成時に素材割り当てを引き継ぐ。
 * 新しいシーンの中央を含む旧シーンの割り当てをコピーする。
 */
export function carryOverScenes(oldScenes: Scene[], fresh: Scene[]): Scene[] {
  return fresh.map((s) => {
    const mid = (s.srcStart + s.srcEnd) / 2;
    const old = oldScenes.find((o) => o.srcStart <= mid && o.srcEnd > mid);
    return old ? { ...s, bg: old.bg ? { ...old.bg } : null, inset: old.inset ? { ...old.inset } : null } : s;
  });
}
