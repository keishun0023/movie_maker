// 日本語テキストの小さなユーティリティ(文字種・禁則・表示用整形・改行)。

/** 行頭に来てはいけない文字 */
export const NO_LINE_START = new Set(
  Array.from('、。，．,.）)]｝}」』】〉》〕’”ー―～〜ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ！？!?・：；:;…‥ゝゞヽヾ々%％'),
);
/** 行末に来てはいけない文字 */
export const NO_LINE_END = new Set(Array.from('（([｛{「『【〈《〔‘“#＃$＄'));

export type CharClass = 'kanji' | 'hira' | 'kata' | 'latin' | 'digit' | 'punct' | 'space' | 'other';

export function charClass(ch: string): CharClass {
  const c = ch.codePointAt(0) ?? 0;
  if (ch === ' ' || ch === '　' || ch === '\n') return 'space';
  if ((c >= 0x3041 && c <= 0x309f)) return 'hira';
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) return 'kata';
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || ch === '々' || ch === '〆' || (c >= 0xf900 && c <= 0xfaff)) return 'kanji';
  if (/[0-9０-９]/.test(ch)) return 'digit';
  if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(ch)) return 'latin';
  if (/[、。，．,.!！?？・：；:;「」『』（）()【】〈〉《》…ー―～〜\-"'“”‘’]/.test(ch)) return 'punct';
  return 'other';
}

/** 表示幅の見積もり(全角=1) */
export function estimateWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch === '\n') continue;
    const c = ch.codePointAt(0) ?? 0;
    w += c < 0x2000 || (c >= 0xff61 && c <= 0xff9f) ? 0.55 : 1;
  }
  return w;
}

/** 認識原文から表示用テロップを作る(句点を外し、端の読点を外すだけ。言い換えはしない) */
export function displayFromRaw(raw: string): string {
  let t = raw.replace(/\s+/g, (m) => (m.includes('\n') ? '\n' : ' ')).trim();
  t = t.replace(/[。．]/g, ' ').replace(/ {2,}/g, ' ');
  t = t.replace(/^[、，,\s]+/, '').replace(/[、，,\s]+$/, '');
  // 日本語同士の間の半角スペースは詰める
  t = t.replace(/([^\x00-\x7f]) (?=[^\x00-\x7f])/g, '$1');
  return t.trim();
}

const PARTICLE_END = /(は|が|を|に|へ|と|も|で|の|や|か|ね|よ|な|て|ば|けど|から|ので|のに|たら|なら|けれど|ながら|って)$/;

/** 文字 i の直後で改行したときのペナルティ(小さいほど自然) */
export function breakPenalty(text: string, i: number): number {
  const chars = Array.from(text);
  const prev = chars[i - 1];
  const next = chars[i];
  if (prev === undefined || next === undefined) return 100;
  if (NO_LINE_START.has(next) || NO_LINE_END.has(prev)) return 1000;
  const pc = charClass(prev);
  const nc = charClass(next);
  if (pc === 'space' || nc === 'space') return 0;
  if ((pc === 'latin' || pc === 'digit') && (nc === 'latin' || nc === 'digit')) return 500;
  if (prev === '、' || prev === '，' || prev === '!' || prev === '！' || prev === '?' || prev === '？') return 0;
  const head = chars.slice(0, i).join('');
  if (PARTICLE_END.test(head) && nc !== 'hira') return 1;
  if (pc === 'hira' && (nc === 'kanji' || nc === 'kata')) return 2;
  if (pc === nc) return pc === 'hira' ? 6 : 12;
  if (pc === 'kanji' && nc === 'hira') return 10; // 送り仮名の手前
  return 5;
}

export type MeasureFn = (text: string) => number;

/**
 * 最大幅に収まるように禁則を守って改行する。
 * 手動改行(\n)は必ず尊重する。2行に収まる場合は行幅をそろえる。
 */
export function wrapText(text: string, maxWidth: number, measure: MeasureFn, maxLines = 2): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    const p = para.trim();
    if (p === '') {
      if (paragraphs.length > 1) lines.push('');
      continue;
    }
    lines.push(...wrapParagraph(p, maxWidth, measure, Math.max(1, maxLines - lines.length)));
  }
  return lines.length ? lines : [''];
}

function wrapParagraph(p: string, maxWidth: number, measure: MeasureFn, linesLeft: number): string[] {
  if (measure(p) <= maxWidth) return [p];
  const chars = Array.from(p);
  // 2行でそろえる
  if (linesLeft >= 2) {
    let best: { i: number; score: number } | null = null;
    for (let i = 1; i < chars.length; i++) {
      const a = chars.slice(0, i).join('').trimEnd();
      const b = chars.slice(i).join('').trimStart();
      const wa = measure(a);
      const wb = measure(b);
      if (wa > maxWidth || wb > maxWidth) continue;
      const pen = breakPenalty(p, i);
      if (pen >= 1000) continue;
      const score = pen * (maxWidth / 30) + Math.abs(wa - wb) * 0.6 + (wb > wa ? (wb - wa) * 0.2 : 0);
      if (!best || score < best.score) best = { i, score };
    }
    if (best) {
      return [chars.slice(0, best.i).join('').trimEnd(), chars.slice(best.i).join('').trimStart()];
    }
  }
  // 収まらない場合は貪欲に詰める(禁則は守る)
  const out: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start + 1;
    while (end < chars.length && measure(chars.slice(start, end + 1).join('')) <= maxWidth) end++;
    if (end < chars.length) {
      // 禁則: 行頭禁則文字の手前、行末禁則文字の直後では切らない
      let e = end;
      while (e > start + 1 && breakPenalty(p, e) >= 1000) e--;
      if (e > start + 1) end = e;
      // 近くに自然な切れ目があればそこで切る
      let bestE = end;
      let bestPen = breakPenalty(p, end);
      for (let k = end - 1; k > Math.max(start + 1, end - 4); k--) {
        const pen = breakPenalty(p, k);
        if (pen + (end - k) * 2 < bestPen) {
          bestPen = pen + (end - k) * 2;
          bestE = k;
        }
      }
      end = bestE;
    }
    out.push(chars.slice(start, end).join('').trim());
    start = end;
  }
  return out;
}
