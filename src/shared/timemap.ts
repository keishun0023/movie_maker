// 元音声 → 編集後音声 の時間対応表。
// すべて整数サンプル(48kHz)で計算し、表示用の丸め値は計算に使わない。
import { SR, type KeepSegment, type Timeline } from './types.js';

export interface Range {
  start: number;
  end: number;
}

/** 範囲を整列・結合・クリップする */
export function normalizeRanges(ranges: Range[], min: number, max: number): Range[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(min, Math.round(r.start)), end: Math.min(max, Math.round(r.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** 削除する範囲から保持区間の対応表を作る */
export function buildTimeline(srcSamples: number, removeRanges: Range[], fadeMs = 0): Timeline {
  const total = Math.max(0, Math.round(srcSamples));
  const removes = normalizeRanges(removeRanges, 0, total);
  const segments: KeepSegment[] = [];
  let cursor = 0;
  let out = 0;
  const push = (a: number, b: number) => {
    if (b <= a) return;
    segments.push({ srcStart: a, srcEnd: b, outStart: out, outEnd: out + (b - a) });
    out += b - a;
  };
  for (const r of removes) {
    push(cursor, r.start);
    cursor = r.end;
  }
  push(cursor, total);
  return { segments, outSamples: out, srcSamples: total, fadeMs, hash: hashSegments(segments, fadeMs) };
}

export function identityTimeline(srcSamples: number): Timeline {
  return buildTimeline(srcSamples, [], 0);
}

function findSegBySrc(segs: KeepSegment[], s: number): number {
  // srcStart <= s を満たす最後の区間
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.srcStart <= s) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function findSegByOut(segs: KeepSegment[], o: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.outStart <= o) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * 元音声の位置 → 出力位置。削除区間内の位置は削除点(1点)に写る。
 * 単調非減少かつ連続なので、境界を共有する区間同士は出力でも隙間なく並ぶ。
 */
export function srcToOut(tl: Timeline, s: number): number {
  const segs = tl.segments;
  if (segs.length === 0) return 0;
  const i = findSegBySrc(segs, s);
  if (i < 0) return 0;
  const seg = segs[i]!;
  if (s < seg.srcEnd) return seg.outStart + (Math.round(s) - seg.srcStart);
  return seg.outEnd;
}

/** 出力位置 → 元音声の位置。削除点ちょうどの場合は後ろの保持区間の先頭を返す */
export function outToSrc(tl: Timeline, o: number): number {
  const segs = tl.segments;
  if (segs.length === 0) return 0;
  if (o >= tl.outSamples) return segs[segs.length - 1]!.srcEnd;
  const i = Math.max(0, findSegByOut(segs, o));
  const seg = segs[i]!;
  return seg.srcStart + (Math.max(seg.outStart, Math.round(o)) - seg.outStart);
}

/** 出力範囲に対応する元音声の断片(元動画と同期モードで使う) */
export function sourcePiecesForOutput(tl: Timeline, o0: number, o1: number): KeepSegment[] {
  const pieces: KeepSegment[] = [];
  for (const seg of tl.segments) {
    const a = Math.max(o0, seg.outStart);
    const b = Math.min(o1, seg.outEnd);
    if (b > a) {
      pieces.push({
        outStart: a,
        outEnd: b,
        srcStart: seg.srcStart + (a - seg.outStart),
        srcEnd: seg.srcStart + (b - seg.outStart),
      });
    }
  }
  return pieces;
}

/** 出力位置が削除点(カット)にあたるか。カット点の一覧 */
export function cutPoints(tl: Timeline): number[] {
  return tl.segments.slice(1).map((s) => s.outStart);
}

export function hashSegments(segments: KeepSegment[], fadeMs: number): string {
  // FNV-1a 32bit を2本(簡易64bit)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  const feed = (n: number) => {
    const str = String(n) + ',';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
  };
  feed(fadeMs);
  for (const s of segments) {
    feed(s.srcStart);
    feed(s.srcEnd);
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** サンプル → フレーム番号(絶対位置から丸めるので誤差は累積しない) */
export function sampleToFrame(samples: number, fps: number): number {
  return Math.round((samples * fps) / SR);
}

export function frameToSample(frame: number, fps: number): number {
  return Math.round((frame * SR) / fps);
}

/** 出力全体のフレーム数。末尾はフレーム境界まで最小限だけ延ばす */
export function totalFrames(outSamples: number, fps: number): number {
  return Math.max(1, Math.ceil((outSamples * fps) / SR - 1e-9));
}

export const secToSamples = (sec: number) => Math.round(sec * SR);
export const samplesToSec = (s: number) => s / SR;
export const msToSamples = (ms: number) => Math.round((ms * SR) / 1000);

export function formatTime(samples: number, withMs = true): string {
  const totalMs = Math.max(0, Math.round((samples / SR) * 1000));
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.floor(ms / 10)).padStart(2, '0')}` : base;
}
