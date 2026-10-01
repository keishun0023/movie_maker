// 素材の指定(参考): スプレッドシートからコピーした「台本 / 使う素材」の表を読み、
// カットごとにどの行(=どの素材の指定)に当たるかを決める。

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
