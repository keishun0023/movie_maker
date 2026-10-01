// 素材の指定(参考): スプレッドシートからコピーした「台本 / 使う素材」の表を読み、
// カットごとにどの行(=どの素材の指定)に当たるかを決める。
import { SR, type Token } from './types.js';
import { normChar } from './align.js';

export interface ReferenceRow {
  /** 台本の文 */
  line: string;
  /** 使う素材の指定(例: 「サナ」「商品アップ」「飲んでいる」)。空のこともある */
  hint: string;
}

/**
 * タブ区切り(スプレッドシートからのコピー)を読む。
 * セル内の改行はダブルクォートで囲まれて来るので、その中の改行・タブはセルの一部として扱う。
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      atCellStart = true;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
      continue;
    }
    cell += ch;
    atCellStart = false;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 「台本 / 素材の指定」の表を読む。先頭が番号だけの列は飛ばし、3列目以降は指定に足す */
export function parseReferenceTable(text: string): ReferenceRow[] {
  const out: ReferenceRow[] = [];
  for (const raw of parseTsv(text)) {
    let cells = raw.map(clean);
    if (cells.length > 1 && /^\d{1,3}$/.test(cells[0]!)) cells = cells.slice(1);
    const line = cells[0] ?? '';
    const hint = cells.slice(1).filter(Boolean).join(' / ');
    if (!line && !hint) continue;
    // 見出し行(「台本」「素材」など)は飛ばす
    if (out.length === 0 && /^(台本|セリフ|テロップ|ナレーション|文章)$/.test(line) && /^(素材|映像|画像|背景|動画)/.test(hint)) continue;
    out.push({ line, hint });
  }
  return out;
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s、。,.!！?？「」『』（）()【】・…ー〜~"'`\-]/g, '');
}

function bigrams(s: string): string[] {
  const c = Array.from(norm(s));
  if (c.length < 2) return c;
  const out: string[] = [];
  for (let i = 0; i < c.length - 1; i++) out.push(c[i]! + c[i + 1]!);
  return out;
}

/** カットの文が台本の行にどれだけ含まれているか(0..1) */
function overlap(cut: string, line: string): number {
  const a = bigrams(cut);
  if (a.length === 0) return 0;
  const b = new Map<string, number>();
  for (const g of bigrams(line)) b.set(g, (b.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of a) {
    const n = b.get(g) ?? 0;
    if (n > 0) {
      hit++;
      b.set(g, n - 1);
    }
  }
  // 「から」「でも」のような短いありふれた語だけで一致したことにならないよう、2組以上の一致を求める
  return hit >= 2 ? hit / a.length : (hit / a.length) * 0.4;
}

/**
 * カットを台本の行に順番どおりに対応づける(-1 は対応なし)。
 * カットは話の順に並ぶので、行の番号が戻らないようにしながら、文字の重なりが最大になる組み合わせを選ぶ。
 */
export function alignCutsToReference(cutTexts: string[], rows: ReferenceRow[]): number[] {
  const n = cutTexts.length;
  const m = rows.length;
  if (n === 0 || m === 0) return cutTexts.map(() => -1);
  const sim = cutTexts.map((t) => rows.map((r) => overlap(t, r.line)));
  // dp[i][j]: カット i を行 j に当てたときの、カット 0..i の合計の良さ
  const dp: number[][] = Array.from({ length: n }, () => new Array(m).fill(-Infinity));
  const from: number[][] = Array.from({ length: n }, () => new Array(m).fill(-1));
  for (let j = 0; j < m; j++) dp[0]![j] = sim[0]![j]! - j * 0.001;
  for (let i = 1; i < n; i++) {
    let best = -Infinity;
    let bestJ = -1;
    for (let j = 0; j < m; j++) {
      if (dp[i - 1]![j]! > best) {
        best = dp[i - 1]![j]!;
        bestJ = j;
      }
      // 行を飛ばすほど少しだけ損(同じ行に留まるのが自然)
      dp[i]![j] = best + sim[i]![j]! - (j - bestJ) * 0.001;
      from[i]![j] = bestJ;
    }
  }
  let j = 0;
  for (let k = 1; k < m; k++) if (dp[n - 1]![k]! > dp[n - 1]![j]!) j = k;
  const out = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = j;
    j = from[i]![j]!;
  }
  // 文字がほとんど一致しないカットは「対応なし」にする(テロップなしのカットなど)
  return out.map((r, i) => (sim[i]![r]! >= 0.2 ? r : -1));
}

/**
 * 台本の文字 a と文字起こしの文字 b を対応づける(一致した文字の組を返す)。
 * 続けて一致するほど得にし(偶然の1文字一致に引っぱられないように)、
 * 台本にないアドリブ(文字起こし側の飛ばし)は安く、話していない台本(台本側の飛ばし)は高くする。
 */
function alignScript(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  // 1=一致 2=不一致(斜め) 3=台本を飛ばす 4=文字起こしを飛ばす
  const move = new Uint8Array((n + 1) * W);
  const SKIP_A = 1;
  const SKIP_B = 0.3;
  for (let i = 1; i <= n; i++) {
    score[i * W] = -i * SKIP_A;
    move[i * W] = 3;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = -j * SKIP_B;
    move[j] = 4;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const dk = (i - 1) * W + j - 1;
      const same = a[i - 1] === b[j - 1];
      const d = score[dk]! + (same ? (move[dk] === 1 ? 4 : 2) : -1);
      const u = score[(i - 1) * W + j]! - SKIP_A;
      const l = score[i * W + j - 1]! - SKIP_B;
      const k = i * W + j;
      if (d >= u && d >= l) {
        score[k] = d;
        move[k] = same ? 1 : 2;
      } else if (u >= l) {
        score[k] = u;
        move[k] = 3;
      } else {
        score[k] = l;
        move[k] = 4;
      }
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (mv === 1 || mv === 2) {
      if (mv === 1) pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (mv === 3) i--;
    else j--;
  }
  return pairs.reverse();
}

/** 表の行の切れ目(元音声の時刻)。cut[k] は行 rows[k] と次の行の間 */
export interface ReferenceSplit {
  /** カットの切れ目(元音声のサンプル位置、昇順) */
  breaks: number[];
  /** 切れ目で分けた区間ごとに、どの行が入っているか */
  rowsOf: number[][];
}

/** 文字単位の対応づけを行う上限(台本の文字数 × 文字起こしの文字数) */
const MAX_CELLS = 25e6;

/**
 * 台本の表の行の切れ目が、文字起こしのどこに当たるかを文字単位で求める。
 * 表の行どおりにカットを割るために使う。対応づけできなければ null。
 */
export function splitByReference(tokens: Token[], rows: ReferenceRow[]): ReferenceSplit | null {
  const toks = tokens.filter((t) => t.text.trim() !== '' && !t.flags?.includes('silence') && !t.flags?.includes('hallucination'));
  if (rows.length === 0 || toks.length === 0) return null;
  // 文字起こしの文字(どのトークンの文字か)
  const tc: { ch: string; tok: number }[] = [];
  toks.forEach((t, k) => {
    for (const raw of Array.from(t.text)) {
      const ch = normChar(raw);
      if (ch !== null) tc.push({ ch, tok: k });
    }
  });
  // 台本の文字(どの行の文字か)
  const sc: { ch: string; row: number }[] = [];
  rows.forEach((r, k) => {
    for (const raw of Array.from(r.line)) {
      const ch = normChar(raw);
      if (ch !== null) sc.push({ ch, row: k });
    }
  });
  if (tc.length === 0 || sc.length === 0 || tc.length * sc.length > MAX_CELLS) return null;
  const pairs = alignScript(
    sc.map((c) => c.ch),
    tc.map((c) => c.ch),
  );
  // 行ごとに、一致した最初と最後の文字起こしの文字
  // ひらがな1文字だけの離れた一致は偶然のことが多いので、続けて一致した所か漢字・カタカナ・英数だけ使う
  const pairSet = new Set(pairs.map(([a, b]) => a * 1e6 + b));
  const good = pairs.filter(([a, b]) => pairSet.has((a - 1) * 1e6 + b - 1) || pairSet.has((a + 1) * 1e6 + b + 1) || !/^[ぁ-ゖ]$/.test(sc[a]!.ch));
  const hits: number[][] = rows.map(() => []);
  for (const [a, b] of good) hits[sc[a]!.row]!.push(b);
  // 行ごとに、一致した文字が最も集まっている所(行の長さの2倍ほどの幅)を、その行を話した所とする
  const first = new Array<number>(rows.length).fill(-1);
  const last = new Array<number>(rows.length).fill(-1);
  const found = rows.map((r, k) => {
    const n = Array.from(r.line)
      .map(normChar)
      .filter((c) => c !== null).length;
    const h = hits[k]!;
    let best = 0;
    for (let i = 0, j = 0; j < h.length; j++) {
      while (h[j]! - h[i]! > n * 2 + 4) i++;
      if (j - i + 1 > best) {
        best = j - i + 1;
        first[k] = h[i]!;
        last[k] = h[j]!;
      }
    }
    // 一致した文字が少ない行や、「から」のようなひらがなだけで一致した行は、偶然の一致とみなす(前の行とまとめる)
    const kanaOnly = (ch: string) => /^[ぁ-ゖ]$/.test(ch);
    const needsKanji = Array.from(r.line).some((c) => {
      const x = normChar(c);
      return x !== null && !kanaOnly(x);
    });
    const hasKanji = h.some((b) => b >= first[k]! && b <= last[k]! && !kanaOnly(tc[b]!.ch));
    return best >= Math.max(2, Math.ceil(n * 0.3)) && (!needsKanji || hasKanji);
  });
  if (!found.some(Boolean)) return null;
  const breaks: number[] = [];
  const rowsOf: number[][] = [[]];
  let prevLast = -1;
  for (let k = 0; k < rows.length; k++) {
    if (!found[k] || prevLast < 0) {
      rowsOf[rowsOf.length - 1]!.push(k);
      if (found[k]) prevLast = last[k]!;
      continue;
    }
    // 前の行の最後の文字の次から、この行の最初の文字までの間で、トークンの切れ目のうち一番間の空いた所で切る
    // (この行の頭が少し認識違いでも拾えるよう、最初に一致した文字の数語前まで)
    const firstTok = tc[first[k]!]!.tok;
    const fromTok = Math.max(tc[prevLast]!.tok + 1, firstTok - 3);
    const toTok = Math.max(fromTok, firstTok);
    let best = -1;
    let bestGap = -Infinity;
    for (let t = fromTok; t <= toTok && t < toks.length; t++) {
      // 間が空いている所ほど、また最初に一致した文字に近いほど良い
      const gap = toks[t]!.start - toks[t - 1]!.end - (toTok - t) * 0.08 * SR;
      if (gap > bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    const at = best < 0 ? -1 : toks[best]!.start <= toks[best - 1]!.end ? toks[best]!.start : Math.round((toks[best - 1]!.end + toks[best]!.start) / 2);
    if (at < 0 || (breaks.length && at <= breaks[breaks.length - 1]!)) {
      rowsOf[rowsOf.length - 1]!.push(k);
    } else {
      breaks.push(at);
      rowsOf.push([k]);
    }
    prevLast = Math.max(prevLast, last[k]!);
  }
  return { breaks, rowsOf };
}
