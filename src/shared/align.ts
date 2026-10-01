// クラウド認識(Gemini)の文字を、ローカル認識(whisper)の時刻に合わせる。
// Gemini は文字は正確だが語ごとの時刻を返さないため、音声片の中の時刻は文字量からの推定になり、
// 話す速さが変わると 0.5 秒以上ずれることがある。whisper は文字の誤りが多いが時刻は正確なので、
// 両者の文字列を音声片ごとに対応づけ、一致した文字の時刻を使う。
import { SR, type Token } from './types.js';
import { speakWeight } from './chunks.js';

/** 読み上げ量(speakWeight)の1秒あたりの上限。早口でも 10 前後 */
const MAX_RATE = 28;

interface TimedChar {
  ch: string;
  t0: number;
  t1: number;
}

/** 比較用に文字をそろえる(記号は無視、カタカナはひらがなに、全角英数は半角に) */
export function normChar(ch: string): string | null {
  const n = ch.normalize('NFKC').toLowerCase();
  if (n.trim() === '' || /^[、。，．,.!！?？「」『』（）()［］\[\]・…‥ー〜~"'`\-―:：;；]$/.test(n)) return null;
  const c = n.codePointAt(0)!;
  if (c >= 0x30a1 && c <= 0x30f6) return String.fromCodePoint(c - 0x60);
  return n;
}

function timedChars(tokens: Token[]): TimedChar[] {
  const out: TimedChar[] = [];
  for (const t of tokens) {
    if (t.timing === 'segment' || t.timing === 'chunk' || t.flags?.includes('hallucination')) continue;
    const cs = Array.from(t.text).map(normChar).filter((c): c is string => c !== null);
    const n = cs.length;
    cs.forEach((ch, i) => {
      out.push({ ch, t0: Math.round(t.start + ((t.end - t.start) * i) / n), t1: Math.round(t.start + ((t.end - t.start) * (i + 1)) / n) });
    });
  }
  return out;
}

/** 2つの文字列の対応(一致した文字の組)を求める。一致 +2 / 不一致 -1 / 飛ばし -1 */
export function alignPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1=斜め 2=上(a を飛ばす) 3=左(b を飛ばす)
  for (let i = 1; i <= n; i++) {
    score[i * W] = -i;
    move[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = -j;
    move[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = score[(i - 1) * W + j - 1]! + (a[i - 1] === b[j - 1] ? 2 : -1);
      const u = score[(i - 1) * W + j]! - 1;
      const l = score[i * W + j - 1]! - 1;
      const k = i * W + j;
      if (d >= u && d >= l) {
        score[k] = d;
        move[k] = 1;
      } else if (u >= l) {
        score[k] = u;
        move[k] = 2;
      } else {
        score[k] = l;
        move[k] = 3;
      }
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (mv === 1) {
      if (a[i - 1] === b[j - 1]) pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (mv === 2) i--;
    else j--;
  }
  return pairs.reverse();
}

export interface AlignStats {
  groups: number;
  aligned: number;
  /** 一致した文字の割合 */
  matchRate: number;
}

/**
 * timing='chunk' のトークン(音声片ごと)の時刻を、時刻付きのトークン列(whisper)に合わせる。
 * 一致した文字が少ない音声片は元の推定のまま残す。
 */
export function alignChunkTokens(tokens: Token[], timed: Token[]): { tokens: Token[]; stats: AlignStats } {
  const wc = timedChars(timed);
  const out = tokens.slice();
  let groups = 0;
  let aligned = 0;
  let total = 0;
  let matched = 0;
  let i = 0;
  while (i < out.length) {
    if (out[i]!.timing !== 'chunk') {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < out.length && out[j + 1]!.timing === 'chunk' && out[j + 1]!.seg === out[i]!.seg) j++;
    groups++;
    const r = alignGroup(out.slice(i, j + 1), wc);
    total += r.chars;
    matched += r.matched;
    if (r.tokens) {
      aligned++;
      r.tokens.forEach((t, k) => (out[i + k] = t));
    }
    i = j + 1;
  }
  return { tokens: out, stats: { groups, aligned, matchRate: total ? matched / total : 0 } };
}

function alignGroup(g: Token[], wc: TimedChar[]): { tokens: Token[] | null; chars: number; matched: number } {
  const s0 = g[0]!.start;
  const s1 = g[g.length - 1]!.end;
  // 文字ごとに、どのトークンの何文字目か
  const chars: { ch: string; tok: number; w: number }[] = [];
  const firstChar: number[] = [];
  g.forEach((t, k) => {
    firstChar.push(chars.length);
    for (const raw of Array.from(t.text)) {
      const ch = normChar(raw);
      if (ch !== null) chars.push({ ch, tok: k, w: speakWeight(raw) });
    }
  });
  const n = chars.length;
  if (n === 0) return { tokens: null, chars: 0, matched: 0 };
  const margin = Math.round(SR * 0.4);
  const w = wc.filter((c) => c.t1 > s0 - margin && c.t0 < s1 + margin);
  if (w.length === 0) return { tokens: null, chars: n, matched: 0 };
  const pairs = alignPairs(
    chars.map((c) => c.ch),
    w.map((c) => c.ch),
  );
  // ひらがな1文字だけの一致は偶然のことが多いので、連続して一致した所か漢字・カタカナ・英数だけ使う
  const pairSet = new Set(pairs.map(([a, b]) => `${a}:${b}`));
  const good = pairs.filter(([a, b]) => pairSet.has(`${a - 1}:${b - 1}`) || pairSet.has(`${a + 1}:${b + 1}`) || !/^[ぁ-ゖ]$/.test(chars[a]!.ch));
  if (good.length < Math.max(2, n * 0.12)) return { tokens: null, chars: n, matched: good.length };
  // 文字の境目(0..n)ごとの時刻の手がかり
  const anchors = new Map<number, number>();
  for (const [a, b] of good) {
    anchors.set(a, Math.min(anchors.get(a) ?? Infinity, w[b]!.t0));
    if (!anchors.has(a + 1)) anchors.set(a + 1, w[b]!.t1);
  }
  if (!anchors.has(0)) anchors.set(0, Math.min(s0, anchors.get(Math.min(...anchors.keys()))!));
  if (!anchors.has(n)) anchors.set(n, Math.max(s1, anchors.get(Math.max(...anchors.keys()))!));
  const cum: number[] = [0];
  for (const c of chars) cum.push(cum[cum.length - 1]! + c.w);
  // 時刻が逆行する手がかりや、ありえない速さ(普通の3倍以上)になる手がかりは捨てる
  const pts: [number, number][] = [];
  for (const [k, t] of [...anchors.entries()].sort((x, y) => x[0] - y[0])) {
    const last = pts[pts.length - 1];
    if (last) {
      if (t < last[1]) continue;
      const dw = cum[k]! - cum[last[0]]!;
      if (dw > 2 && dw / Math.max(1e-6, (t - last[1]) / SR) > MAX_RATE) continue;
    }
    pts.push([k, t]);
  }
  const timeAt = (k: number): number => {
    let lo = pts[0]!;
    let hi = pts[pts.length - 1]!;
    for (const p of pts) {
      if (p[0] <= k && p[0] >= lo[0]) lo = p;
      if (p[0] >= k && p[0] <= hi[0]) {
        hi = p;
        break;
      }
    }
    if (hi[0] === lo[0]) return lo[1];
    return lo[1] + ((hi[1] - lo[1]) * (cum[k]! - cum[lo[0]]!)) / Math.max(1e-9, cum[hi[0]]! - cum[lo[0]]!);
  };
  const tokens = g.map((t, k) => {
    const a = firstChar[k]!;
    const b = k + 1 < g.length ? firstChar[k + 1]! : n;
    const start = Math.round(timeAt(a));
    const end = Math.round(timeAt(b));
    return { ...t, start, end: Math.max(end, start + 1), timing: 'aligned' as const };
  });
  return { tokens, chars: n, matched: good.length };
}
