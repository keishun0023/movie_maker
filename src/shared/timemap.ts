// 元音声 → 編集後音声 の時間対応表。
// すべて整数サンプル(48kHz)で計算し、表示用の丸め値は計算に使わない。
import { SR, type KeepSegment, type PauseInsert, type SpeedRange, type Timeline } from './types.js';

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

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

export function clampSpeed(v: number | undefined): number {
  if (!v || !isFinite(v)) return 1;
  return Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, v)) * 1000) / 1000;
}

/** 速さ設定を比較用の文字列にする(1倍の範囲は含めない) */
export function speedKeyOf(speeds: SpeedRange[]): string {
  return speeds
    .filter((r) => (clampSpeed(r.speed) !== 1 || voiceOf(r).gainDb || voiceOf(r).pitch) && r.end > r.start)
    .map((r) => {
      const v = voiceOf(r);
      return `${Math.round(r.start)}-${Math.round(r.end)}@${clampSpeed(r.speed)}${v.gainDb ? `v${v.gainDb}` : ''}${v.pitch ? `p${v.pitch}` : ''}`;
    })
    .join(',');
}

/** 声の大きさ(-24〜+12dB)・高さ(-6〜+6半音)をそろえる(0.5 刻み) */
export function voiceOf(r: { gainDb?: number; pitch?: number }): { gainDb: number; pitch: number } {
  const q = (v: number | undefined, lo: number, hi: number) => (v && isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v)) * 2) / 2 : 0);
  return { gainDb: q(r.gainDb, -24, 12), pitch: q(r.pitch, -6, 6) };
}

/** 足す間を比較用の文字列にする */
export function pauseKeyOf(pauses: PauseInsert[]): string {
  const ps = pauses.filter((x) => x.samples > 0);
  return ps.length ? '|' + ps.map((x) => `${Math.round(x.at)}+${Math.round(x.samples)}`).join(',') : '';
}

/**
 * 削除する範囲から保持区間の対応表を作る。
 * speeds を指定すると、その範囲の出力の長さを 元の長さ / speed にする(音程は変えずに速さを変える前提)。
 */
export function buildTimeline(srcSamples: number, removeRanges: Range[], fadeMs = 0, speeds: SpeedRange[] = [], xfadeMs = 0, pauses: PauseInsert[] = []): Timeline {
  const total = Math.max(0, Math.round(srcSamples));
  const removes = normalizeRanges(removeRanges, 0, total);
  const sp = speeds
    .map((r) => ({ start: Math.max(0, Math.round(r.start)), end: Math.min(total, Math.round(r.end)), speed: clampSpeed(r.speed), ...voiceOf(r) }))
    .filter((r) => r.end > r.start && (r.speed !== 1 || r.gainDb !== 0 || r.pitch !== 0))
    .sort((a, b) => a.start - b.start);
  const rangeAt = (x: number) => sp.find((r) => x >= r.start && x < r.end);
  const speedAt = (x: number) => rangeAt(x)?.speed ?? 1;
  const cuts = new Set<number>();
  for (const r of sp) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  // 足す間: 話している途中なら、その位置で区間を分けて間を入れる。削った所(無音)なら、その直前の保持区間の終わりに入れる
  const keeps: Range[] = [];
  {
    let c = 0;
    for (const r of removes) {
      if (r.start > c) keeps.push({ start: c, end: r.start });
      c = r.end;
    }
    if (total > c) keeps.push({ start: c, end: total });
  }
  const gaps = new Map<number, number>();
  for (const pz of pauses) {
    const len = Math.round(pz.samples);
    if (!(len > 0) || keeps.length === 0) continue;
    const x = Math.max(0, Math.min(total, Math.round(pz.at)));
    const inside = keeps.find((k) => x > k.start && x < k.end);
    let anchor: number;
    if (inside) {
      anchor = x;
      cuts.add(x);
    } else {
      const before = keeps.filter((k) => k.end <= x);
      anchor = before.length ? before[before.length - 1]!.end : keeps[0]!.start;
    }
    gaps.set(anchor, (gaps.get(anchor) ?? 0) + len);
  }
  const segments: KeepSegment[] = [];
  let out = 0;
  const pushGap = (at: number) => {
    const len = gaps.get(at);
    if (!len) return;
    gaps.delete(at);
    segments.push({ srcStart: at, srcEnd: at, outStart: out, outEnd: out + len, gap: true });
    out += len;
  };
  const pushOne = (a: number, b: number) => {
    if (b <= a) return;
    // 先頭の保持区間より前に入れる間(冒頭)
    if (segments.length === 0) pushGap(a);
    const speed = speedAt(a);
    const len = speed === 1 ? b - a : Math.max(1, Math.round((b - a) / speed));
    const seg: KeepSegment = { srcStart: a, srcEnd: b, outStart: out, outEnd: out + len };
    if (speed !== 1) seg.speed = speed;
    const rv = rangeAt(a);
    if (rv?.gainDb) seg.gainDb = rv.gainDb;
    if (rv?.pitch) seg.pitch = rv.pitch;
    segments.push(seg);
    out += len;
    pushGap(b);
  };
  // 速さの境目で保持区間を分ける
  const push = (a: number, b: number) => {
    const inner = [...cuts].filter((c) => c > a && c < b).sort((x, y) => x - y);
    let cur = a;
    for (const c of inner) {
      pushOne(cur, c);
      cur = c;
    }
    pushOne(cur, b);
  };
  let cursor = 0;
  for (const r of removes) {
    push(cursor, r.start);
    cursor = r.end;
  }
  push(cursor, total);
  const tl: Timeline = { segments, outSamples: out, srcSamples: total, fadeMs, hash: hashSegments(segments, fadeMs, xfadeMs) };
  if (xfadeMs > 0) tl.xfadeMs = xfadeMs;
  const key = speedKeyOf(sp) + pauseKeyOf(pauses);
  if (key) tl.speedKey = key;
  return tl;
}

/** 区間内の位置の変換(速さを考慮。区間ごとに計算するので誤差は累積しない) */
function srcOffsetToOut(seg: KeepSegment, d: number): number {
  const srcLen = seg.srcEnd - seg.srcStart;
  const outLen = seg.outEnd - seg.outStart;
  return srcLen === outLen ? d : Math.round((d * outLen) / srcLen);
}

function outOffsetToSrc(seg: KeepSegment, d: number): number {
  const srcLen = seg.srcEnd - seg.srcStart;
  const outLen = seg.outEnd - seg.outStart;
  return srcLen === outLen ? d : Math.round((d * srcLen) / outLen);
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
  if (s < seg.srcEnd) return seg.outStart + srcOffsetToOut(seg, Math.round(s) - seg.srcStart);
  return seg.outEnd;
}

/** 出力位置 → 元音声の位置。削除点ちょうどの場合は後ろの保持区間の先頭を返す */
export function outToSrc(tl: Timeline, o: number): number {
  const segs = tl.segments;
  if (segs.length === 0) return 0;
  if (o >= tl.outSamples) return segs[segs.length - 1]!.srcEnd;
  const i = Math.max(0, findSegByOut(segs, o));
  const seg = segs[i]!;
  return seg.srcStart + outOffsetToSrc(seg, Math.max(seg.outStart, Math.round(o)) - seg.outStart);
}

/** 出力範囲に対応する元音声の断片(元動画と同期モードで使う) */
export function sourcePiecesForOutput(tl: Timeline, o0: number, o1: number): KeepSegment[] {
  const pieces: KeepSegment[] = [];
  for (const seg of tl.segments) {
    const a = Math.max(o0, seg.outStart);
    const b = Math.min(o1, seg.outEnd);
    if (b > a) {
      const piece: KeepSegment = {
        outStart: a,
        outEnd: b,
        srcStart: seg.srcStart + outOffsetToSrc(seg, a - seg.outStart),
        srcEnd: seg.srcStart + outOffsetToSrc(seg, b - seg.outStart),
      };
      if (seg.speed) piece.speed = seg.speed;
      if (seg.gap) piece.gap = true;
      pieces.push(piece);
    }
  }
  return pieces;
}

/** 出力位置が削除点(カット)にあたるか。カット点の一覧 */
export function cutPoints(tl: Timeline): number[] {
  return tl.segments.slice(1).map((s) => s.outStart);
}

export function hashSegments(segments: KeepSegment[], fadeMs: number, xfadeMs = 0): string {
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
  if (xfadeMs) feed(-xfadeMs);
  for (const s of segments) {
    feed(s.srcStart);
    feed(s.srcEnd);
    if (s.gap) feed(-(s.outEnd - s.outStart));
    if (s.gainDb) feed(1e9 + Math.round(s.gainDb * 10));
    if (s.pitch) feed(2e9 + Math.round(s.pitch * 10));
    if (s.speed) feed(Math.round(s.speed * 1000));
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
