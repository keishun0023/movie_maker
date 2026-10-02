// 無音候補の検出と、削る区間の決定。
// 音量だけで判断せず、認識結果(トークン)で発話の可能性がある箇所は保護する。
import { SR, type AnalysisData, type CutParams, type CutPresetId, type SilenceCandidate, type Token, type TokenFlag } from './types.js';
import { msToSamples, normalizeRanges, type Range } from './timemap.js';

export const CUT_PRESETS: Record<Exclude<CutPresetId, 'custom'>, { label: string; params: CutParams }> = {
  // 無音をなくし、語尾・語頭に少し食い込んでクロスフェードで重ねる(つらつら喋る感じ)
  tsuratsura: {
    label: 'つらつら(被せ)',
    params: { minSilenceMs: 50, keepMs: 0, padBeforeMs: 15, padAfterMs: 15, headMs: 0, tailMs: 0, sensitivityDb: 0, fadeMs: 4, overlapMs: 80 },
  },
  // 無音が来たら即カット。語頭・語尾を傷つけない最小限の余白だけ残す
  jumpcut: {
    label: '即カット',
    params: { minSilenceMs: 100, keepMs: 0, padBeforeMs: 30, padAfterMs: 40, headMs: 0, tailMs: 0, sensitivityDb: 0, fadeMs: 4, overlapMs: 0 },
  },
  tempo: {
    label: 'テンポよく',
    params: { minSilenceMs: 250, keepMs: 100, padBeforeMs: 40, padAfterMs: 60, headMs: 50, tailMs: 100, sensitivityDb: 0, fadeMs: 5, overlapMs: 0 },
  },
  natural: {
    label: '自然',
    params: { minSilenceMs: 350, keepMs: 180, padBeforeMs: 60, padAfterMs: 90, headMs: 150, tailMs: 250, sensitivityDb: 0, fadeMs: 6, overlapMs: 0 },
  },
};

export const DEFAULT_CUT_PRESET: CutPresetId = 'jumpcut';

/** 解析フレーム(10ms) */
export const FRAME_SAMPLES = 480;

/** PCM(モノラル, -1..1)から音量エンベロープを作る */
export function computeAnalysis(mono: Float32Array, frameSamples = FRAME_SAMPLES): AnalysisData {
  const n = Math.ceil(mono.length / frameSamples);
  const db: number[] = new Array(n);
  const peak: number[] = new Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * frameSamples;
    const b = Math.min(mono.length, a + frameSamples);
    let sum = 0;
    let pk = 0;
    for (let i = a; i < b; i++) {
      const v = mono[i]!;
      sum += v * v;
      const av = v < 0 ? -v : v;
      if (av > pk) pk = av;
    }
    const rms = Math.sqrt(sum / Math.max(1, b - a));
    db[f] = Math.round(Math.max(-100, 20 * Math.log10(rms + 1e-12)) * 10) / 10;
    peak[f] = Math.round(Math.min(1, pk) * 1000) / 1000;
  }
  return { frameSamples, db, peak, durationSamples: mono.length };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -100;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export interface LevelStats {
  floor: number;
  speech: number;
  threshold: number;
}

/** 雑音床と発話レベルから無音しきい値を自動で決める */
export function levelStats(a: AnalysisData, sensitivityDb = 0): LevelStats {
  const floor = Math.max(-100, percentile(a.db, 0.1));
  const speech = percentile(a.db, 0.95);
  const span = Math.max(0, speech - floor);
  let thr = floor + span * 0.35;
  thr = Math.max(thr, floor + 6);
  thr = Math.min(thr, speech - 12);
  thr = Math.min(Math.max(thr, -80), -20);
  return { floor, speech, threshold: thr + sensitivityDb };
}

/** しきい値を下回る連続区間(無音候補)を検出する */
export function detectSilences(a: AnalysisData, sensitivityDb = 0, minMs = 50): SilenceCandidate[] {
  const { threshold } = levelStats(a, sensitivityDb);
  const minFrames = Math.max(1, Math.round((minMs * SR) / 1000 / a.frameSamples));
  const out: SilenceCandidate[] = [];
  let runStart = -1;
  const n = a.db.length;
  for (let f = 0; f <= n; f++) {
    const silent = f < n && a.db[f]! < threshold;
    if (silent && runStart < 0) runStart = f;
    if (!silent && runStart >= 0) {
      if (f - runStart >= minFrames) {
        const start = runStart * a.frameSamples;
        const end = Math.min(a.durationSamples, f * a.frameSamples);
        out.push({ id: `sil-${start}`, start, end, protectedBySpeech: false });
      }
      runStart = -1;
    }
  }
  return out;
}

function meanDb(a: AnalysisData, s0: number, s1: number): number {
  const f0 = Math.max(0, Math.floor(s0 / a.frameSamples));
  const f1 = Math.min(a.db.length, Math.max(f0 + 1, Math.ceil(s1 / a.frameSamples)));
  let sum = 0;
  let n = 0;
  for (let f = f0; f < f1; f++) {
    sum += Math.pow(10, a.db[f]! / 10);
    n++;
  }
  return n ? 10 * Math.log10(sum / n + 1e-12) : -100;
}

/** 区間のうち無音フレームの割合 */
export function silentRatio(a: AnalysisData, s0: number, s1: number, threshold: number): number {
  const f0 = Math.max(0, Math.floor(s0 / a.frameSamples));
  const f1 = Math.min(a.db.length, Math.max(f0 + 1, Math.ceil(s1 / a.frameSamples)));
  let silent = 0;
  for (let f = f0; f < f1; f++) if (a.db[f]! < threshold) silent++;
  return f1 > f0 ? silent / (f1 - f0) : 1;
}

const HALLUCINATION_RE = /(ご視聴ありがとうございました|チャンネル登録|高評価|字幕|最後までご覧|お疲れ様でした)/;

/**
 * 無音区間に出てきたトークンに印を付ける(幻覚の可能性)。
 * トークン自体は消さず、テロップ生成時に除外し、確認対象として示す。
 */
export function flagTokens(tokens: Token[], a: AnalysisData, sensitivityDb = 0): Token[] {
  const st = levelStats(a, sensitivityDb);
  return tokens.map((t) => {
    const flags = new Set<TokenFlag>(t.flags?.filter((f) => f !== 'silence' && f !== 'hallucination'));
    const ratio = silentRatio(a, t.start, Math.max(t.end, t.start + a.frameSamples), st.threshold);
    const level = meanDb(a, t.start, Math.max(t.end, t.start + a.frameSamples));
    const nearFloor = level < st.floor + 6;
    // 時刻を文字量から推定した語(Gemini・読み上げの台本)は、文字は正しく時刻だけがずれていることが多いので、無音の印で消さない
    if (ratio > 0.9 && nearFloor && t.timing !== 'chunk') flags.add('silence');
    if (t.p < 0.25) flags.add('lowConf');
    return { ...t, flags: [...flags] };
  }).map((t, i, arr) => {
    // 無音中に出る定番の幻覚フレーズ
    if (!t.flags?.includes('silence')) return t;
    const around = arr.slice(Math.max(0, i - 6), i + 7).map((x) => x.text).join('');
    if (HALLUCINATION_RE.test(around)) return { ...t, flags: [...(t.flags ?? []), 'hallucination' as const] };
    return t;
  });
}

/** 認識トークンで発話がありそうな無音候補を保護する */
/** 区間のうち、指定の音量を超えるフレームの割合 */
function loudFraction(a: AnalysisData, s0: number, s1: number, minDb: number): number {
  const f0 = Math.max(0, Math.floor(s0 / a.frameSamples));
  const f1 = Math.min(a.db.length, Math.ceil(s1 / a.frameSamples));
  if (f1 <= f0) return 0;
  let n = 0;
  for (let f = f0; f < f1; f++) if (a.db[f]! > minDb) n++;
  return n / (f1 - f0);
}

export function protectBySpeech(cands: SilenceCandidate[], tokens: Token[], a: AnalysisData, sensitivityDb = 0): SilenceCandidate[] {
  const st = levelStats(a, sensitivityDb);
  // 小声の発話とみなす音量: 雑音床より 10dB 以上大きく、ふだんの声から 30dB 以内。
  // (間に入る息・部屋の雑音は、ふだんの声より 30dB 以上小さいことが多いので含めない)
  const minDb = Math.max(st.floor + 10, st.speech - 30, -60);
  const fs = a.frameSamples;
  // 語ごとの正確な時刻があるトークンだけで判断する。
  // 文字量から推定した時刻(Gemini の chunk)や区間単位の時刻では、無音の中に語があるように見えてしまうため使わない
  const usable = tokens.filter(
    (t) => (t.timing === 'token' || t.timing === 'dtw' || t.timing === 'aligned') && !t.flags?.includes('silence') && !t.flags?.includes('hallucination') && t.p >= 0.2 && t.text.trim() !== '',
  );
  const out: SilenceCandidate[] = [];
  for (const c of cands) {
    // 発話の可能性がある所(保護する範囲)
    const prot: { start: number; end: number }[] = [];
    for (const t of usable) {
      if (t.end <= c.start || t.start >= c.end) continue;
      // 語の大部分がこの間の中にあるときだけ(前後の語の時刻が間に食い込んでいるだけのものは除く)
      const inner = Math.min(t.end, c.end) - Math.max(t.start, c.start);
      if (inner < (t.end - t.start) * 0.7) continue;
      const center = (t.start + t.end) / 2;
      if (!(center > c.start + msToSamples(20) && center < c.end - msToSamples(20))) continue;
      // 雑音床より明らかに音がある所が続いているなら、小声の発話とみなして削らない。
      // 無音の端(前後の語の余韻)は除き、聞こえないほど小さい音(-60dB 未満)は発話とみなさない。
      // (無音が完全な 0 の音声では雑音床が -100dB になり、わずかな余韻でも「音がある」と判断されていた)
      const s0 = Math.max(c.start + msToSamples(30), t.start);
      const s1 = Math.min(c.end - msToSamples(30), t.end);
      if (s1 <= s0) continue;
      if (loudFraction(a, s0, s1, minDb) < 0.3) continue;
      // 守るのは音がある所(と前後少し)だけ。残りの無音は詰める
      const f0 = Math.floor(s0 / fs);
      const f1 = Math.ceil(s1 / fs);
      let lo = -1;
      let hi = -1;
      for (let f = f0; f < f1 && f < a.db.length; f++) {
        if (a.db[f]! > minDb) {
          if (lo < 0) lo = f;
          hi = f;
        }
      }
      if (lo < 0) continue;
      const pad = msToSamples(40);
      prot.push({ start: Math.max(c.start, lo * fs - pad), end: Math.min(c.end, (hi + 1) * fs + pad) });
    }
    if (!prot.length) {
      out.push({ ...c, protectedBySpeech: false });
      continue;
    }
    // 間を「守る所」と「詰めてよい所」に分ける
    prot.sort((x, y) => x.start - y.start);
    const merged: { start: number; end: number }[] = [];
    for (const r of prot) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    const minPiece = msToSamples(50);
    let cur = c.start;
    const pushPiece = (s0: number, s1: number, protectedBySpeech: boolean) => {
      if (s1 <= s0) return;
      // 短すぎる詰めてよい所は、守る所に含める
      if (!protectedBySpeech && s1 - s0 < minPiece && !(s0 === c.start && c.start === 0) && !(s1 === c.end && c.end === a.durationSamples)) protectedBySpeech = true;
      const last = out[out.length - 1];
      if (last && last.end === s0 && last.protectedBySpeech && protectedBySpeech && last.id.startsWith(c.id)) {
        last.end = s1;
        return;
      }
      out.push({ id: s0 === c.start ? c.id : `${c.id}-${s0}`, start: s0, end: s1, protectedBySpeech });
    };
    for (const r of merged) {
      pushPiece(cur, r.start, false);
      pushPiece(Math.max(cur, r.start), r.end, true);
      cur = Math.max(cur, r.end);
    }
    pushPiece(cur, c.end, false);
  }
  return out;
}

export interface CutDecision {
  candidateId: string;
  start: number;
  end: number;
  reason: 'head' | 'tail' | 'gap';
}

/** 無音候補とパラメーターから、削る範囲を決める */
export function decideCuts(
  cands: SilenceCandidate[],
  params: CutParams,
  durationSamples: number,
  keepRanges: Range[] = [],
): CutDecision[] {
  const padB = msToSamples(params.padBeforeMs);
  const padA = msToSamples(params.padAfterMs);
  const keep = Math.max(msToSamples(params.keepMs), padA + padB);
  const minLen = msToSamples(params.minSilenceMs);
  const out: CutDecision[] = [];
  for (const c of cands) {
    if (c.protectedBySpeech) continue;
    if (keepRanges.some((k) => k.start < c.end && k.end > c.start)) continue;
    const isHead = c.start <= 0;
    const isTail = c.end >= durationSamples;
    if (isHead && isTail) continue; // 全体が無音
    if (isHead) {
      const e = c.end - padB - msToSamples(params.headMs);
      if (e > 0) out.push({ candidateId: c.id, start: 0, end: e, reason: 'head' });
      continue;
    }
    if (isTail) {
      const s = c.start + padA + msToSamples(params.tailMs);
      if (s < durationSamples) out.push({ candidateId: c.id, start: s, end: durationSamples, reason: 'tail' });
      continue;
    }
    const len = c.end - c.start;
    const ov = msToSamples(params.overlapMs ?? 0);
    if (ov > 0) {
      // 被せ: 保護余白を残した位置からさらに前後の発話へ ov/2 ずつ食い込む
      if (len < minLen) continue;
      const s = c.start + padA - Math.floor(ov / 2);
      const e = c.end - padB + (ov - Math.floor(ov / 2));
      if (e > s) out.push({ candidateId: c.id, start: Math.max(0, s), end: Math.min(durationSamples, e), reason: 'gap' });
      continue;
    }
    if (len < minLen || len <= keep) continue;
    const extra = keep - padA - padB;
    const s = c.start + padA + Math.floor(extra / 2);
    const e = c.end - padB - (extra - Math.floor(extra / 2));
    if (e > s) out.push({ candidateId: c.id, start: s, end: e, reason: 'gap' });
  }
  return out;
}

export function removeRangesFromCuts(cuts: CutDecision[], durationSamples: number): Range[] {
  return normalizeRanges(cuts, 0, durationSamples);
}
