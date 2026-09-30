// 無音で区切った「音声片」の作成と、音声片ごとの文章からトークンを作る処理。
// クラウドの音声認識(Gemini など)は語ごとの時刻を返さないため、
// 時刻は音声片の区切り(音量解析)で決め、音声片の中だけ文字量で配分する。
import { SR, type AnalysisData, type Token } from './types.js';
import { detectSilences } from './silence.js';
import { msToSamples } from './timemap.js';

export interface SpeechChunk {
  start: number;
  end: number;
}

export interface ChunkOptions {
  /** この長さ以上の無音で区切る */
  minGapMs: number;
  /** 音声片の前後に付ける余白 */
  padMs: number;
  /** 1つの音声片の最大長(超えたら中の一番静かな所で分ける) */
  maxSec: number;
  /** これより短い音声片は捨てる(クリック音など) */
  minSpeechMs: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { minGapMs: 180, padMs: 80, maxSec: 12, minSpeechMs: 120 };

/** 発話のある区間(音声片)を求める */
export function speechChunks(a: AnalysisData, sensitivityDb = 0, opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS): SpeechChunk[] {
  const dur = a.durationSamples;
  const gaps = detectSilences(a, sensitivityDb, opt.minGapMs);
  const raw: SpeechChunk[] = [];
  let cur = 0;
  for (const g of gaps) {
    if (g.start > cur) raw.push({ start: cur, end: g.start });
    cur = g.end;
  }
  if (cur < dur) raw.push({ start: cur, end: dur });
  const pad = msToSamples(opt.padMs);
  const out: SpeechChunk[] = [];
  for (const c of raw) {
    if (c.end - c.start < msToSamples(opt.minSpeechMs)) continue;
    for (const piece of splitLong(a, c, opt.maxSec * SR)) {
      out.push({ start: Math.max(0, piece.start - pad), end: Math.min(dur, piece.end + pad) });
    }
  }
  // 余白で重なった場合は境界を中間にそろえる
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1]!;
    const c = out[i]!;
    if (c.start < p.end) {
      const mid = Math.round((c.start + p.end) / 2);
      p.end = mid;
      c.start = mid;
    }
  }
  return out;
}

function splitLong(a: AnalysisData, c: SpeechChunk, maxLen: number): SpeechChunk[] {
  if (c.end - c.start <= maxLen) return [c];
  // 中央付近(30〜70%)で最も静かなフレームで分ける
  const fs = a.frameSamples;
  const f0 = Math.floor((c.start + (c.end - c.start) * 0.3) / fs);
  const f1 = Math.floor((c.start + (c.end - c.start) * 0.7) / fs);
  let best = f0;
  for (let f = f0; f <= f1 && f < a.db.length; f++) if (a.db[f]! < a.db[best]!) best = f;
  const cut = best * fs;
  return [...splitLong(a, { start: c.start, end: cut }, maxLen), ...splitLong(a, { start: cut, end: c.end }, maxLen)];
}

/** 文章を語の単位に分ける。辞書ベースの Intl.Segmenter(日本語)を使い、使えなければ文字種で分ける */
export function splitJaText(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  let words: string[];
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    words = [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(t)].map((x) => x.segment);
  } else {
    const re = /[A-Za-z0-9０-９Ａ-Ｚａ-ｚ.,%％+＋\-]+|[一-龯々〆ヵヶ]+|[ァ-ヴー]+|[ぁ-ゖー]{1,3}|[^\s]| /gu;
    words = t.match(re) ?? [t];
  }
  // 句読点・閉じ括弧は前の語に付け、開き括弧は次の語に付ける
  const out: string[] = [];
  let open = '';
  for (const w of words) {
    if (w === ' ') continue;
    if (/^[、。！？!?」』）),.]+$/.test(w) && out.length) out[out.length - 1] += w;
    else if (/^[「『（(]+$/.test(w)) open += w;
    else {
      out.push(open + w);
      open = '';
    }
  }
  if (open) out.push(open);
  return out;
}

/** 読み上げにかかる長さの目安(数字は読みが長いので重め) */
export function speakWeight(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/[、。！？!?」』）)「『（(\s]/.test(ch)) w += 0.2;
    else if (/[0-9０-９]/.test(ch)) w += 1.6;
    else if (/[一-龯々]/.test(ch)) w += 1.5;
    else if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(ch)) w += 0.6;
    else w += 1;
  }
  return Math.max(0.2, w);
}

/**
 * 音声片ごとの文章からトークンを作る。
 * 音声片の開始・終了は実際の音量から決まった時刻、中の語は文字量で配分した推定時刻(timing='chunk')。
 */
export function tokensFromChunks(chunks: SpeechChunk[], texts: string[], idPrefix = 'g'): Token[] {
  const tokens: Token[] = [];
  chunks.forEach((c, ci) => {
    const text = (texts[ci] ?? '').trim();
    if (!text) return;
    const pieces = splitJaText(text);
    const weights = pieces.map(speakWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    pieces.forEach((p, pi) => {
      const s = c.start + Math.round(((c.end - c.start) * acc) / total);
      acc += weights[pi]!;
      const e = c.start + Math.round(((c.end - c.start) * acc) / total);
      tokens.push({ id: `${idPrefix}${ci}-${pi}`, text: p, start: s, end: Math.max(e, s + 1), p: 0.9, seg: ci, timing: 'chunk' });
    });
  });
  return tokens;
}
