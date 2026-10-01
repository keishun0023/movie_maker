// 台本(任意)の利用: 固有名詞・数字の認識ヒントと、表記の確認候補。
// 台本の文章を字幕へ自動挿入することはしない。

/** 認識ヒント用に台本から語句を抜き出す(カタカナ語・英数字・漢字の複合語) */
export function hintTerms(script: string, maxChars = 120): string[] {
  const terms = new Map<string, number>();
  const add = (t: string) => {
    const k = t.trim();
    if (k.length < 2) return;
    terms.set(k, (terms.get(k) ?? 0) + 1);
  };
  for (const m of script.matchAll(/[ァ-ヶー]{3,}/g)) add(m[0]);
  for (const m of script.matchAll(/[A-Za-z][A-Za-z0-9.+\-]{1,}/g)) add(m[0]);
  for (const m of script.matchAll(/[0-9０-９][0-9０-９,.]*[%％円万億千個人本件年月日時分秒倍回]?/g)) add(m[0]);
  for (const m of script.matchAll(/[一-龯々]{2,}/g)) add(m[0]);
  const sorted = [...terms.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([t]) => t);
  const out: string[] = [];
  let len = 0;
  for (const t of sorted) {
    if (len + t.length + 1 > maxChars) break;
    out.push(t);
    len += t.length + 1;
  }
  return out;
}

function normalize(s: string): string {
  return s.replace(/[\s、。，．,.!！?？「」『』（）()]/g, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const cs = Array.from(s);
  for (let i = 0; i < cs.length - 1; i++) {
    const g = cs[i]! + cs[i + 1]!;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [k, v] of a) inter += Math.min(v, b.get(k) ?? 0);
  return na + nb === 0 ? 0 : (2 * inter) / (na + nb);
}

/**
 * 認識原文に最も近い台本の箇所を探す。利用者が確認して適用するための候補。
 * 似ていなければ null。
 */
export function suggestFromScript(raw: string, script: string): { text: string; similarity: number } | null {
  const target = normalize(raw);
  if (target.length < 2 || !script.trim()) return null;
  const src = Array.from(script.replace(/\s+/g, ''));
  const tb = bigrams(target);
  const L = Array.from(target).length;
  let best: { text: string; similarity: number } | null = null;
  for (let len = Math.max(2, Math.floor(L * 0.7)); len <= Math.ceil(L * 1.3) + 2; len++) {
    for (let i = 0; i + len <= src.length; i++) {
      const cand = src.slice(i, i + len).join('');
      const sim = dice(tb, bigrams(normalize(cand)));
      if (!best || sim > best.similarity) best = { text: cand, similarity: sim };
    }
  }
  if (!best || best.similarity < 0.5) return null;
  if (normalize(best.text) === target) return null;
  best.text = best.text.replace(/^[、。，．,.]+|[、。，．,.]+$/g, '');
  return best;
}

/** 直しを文章に当てはめる(長い語から順に、すべての出現を置き換える) */
export function applyTextFixes(text: string, fixes: { from: string; to: string }[] | undefined): string {
  if (!fixes?.length) return text;
  let out = text;
  for (const f of [...fixes].filter((x) => x.from).sort((a, b) => b.from.length - a.from.length)) out = out.split(f.from).join(f.to);
  return out;
}

/** 認識ヒント: 直した語を優先し、台本から抜き出した語を続ける */
export function mergeHints(first: string[] | undefined, rest: string[], maxChars = 120): string[] {
  const out: string[] = [];
  let len = 0;
  for (const t of [...(first ?? []), ...rest]) {
    const k = t.trim();
    if (k.length < 2 || out.includes(k)) continue;
    if (len + k.length + 1 > maxChars) break;
    out.push(k);
    len += k.length + 1;
  }
  return out;
}
