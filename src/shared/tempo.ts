// 話す速さの緩急: カットごとに速さを変えて、速い所と遅い所を作る。
// - 早回し音声の研究では 1.25〜1.5 倍程度までは理解度がほとんど落ちないとされるため、最大は 1.3〜1.4 倍を目安にする
// - 単調な速さより変化がある方が注意が続きやすいとされるため、近いカットで同じ速さが続かないようにする
// - 要点(数字・商品名・「！」・最後の呼びかけ)はゆっくり、つなぎや説明は速くする

export type TempoMode = 'off' | 'script' | 'wave' | 'pulse';

export interface TempoSettings {
  mode: TempoMode;
  /** いちばん速いカットの速さ(1.1〜1.6) */
  max: number;
  /** いちばん遅いカットの速さ(0.9〜1.2) */
  min: number;
}

export const DEFAULT_TEMPO: TempoSettings = { mode: 'off', max: 1.3, min: 1.0 };

const NUMBER = /[0-9０-９一二三四五六七八九十百千万億]+(%|％|倍|円|個|種|日|年|回|位|時間|分|秒|kg|g|mg|ml)|[0-9０-９]/;
const CTA = /(チェック|今すぐ|いますぐ|リンク|プロフ|見てみて|試してみて|ぜひ|限定|無料|最強|絶対|おすすめ|オススメ|必見|保存|フォロー|コメント|使ってみて|買って)/;
const EXCLAIM = /[！!]|ッ$|って感じ$/;
const CONNECTIVE_END = /(けど|けれど|から|ので|のに|たら|なら|ながら|とか|って|ても|でも|て|で|し|が|、|，|,)$/;
const KATAKANA_WORD = /[ァ-ヴー]{4,}/;

/** カットの文章の「大事さ」(0〜1)。大事なほどゆっくり読ませる */
export function emphasisOf(text: string, index: number, count: number): number {
  const t = text.replace(/\s+/g, '').replace(/\n/g, '');
  if (!t) return 0.3;
  let e = 0.35;
  if (NUMBER.test(t)) e += 0.3;
  if (CTA.test(t)) e += 0.3;
  if (EXCLAIM.test(t)) e += 0.25;
  if (KATAKANA_WORD.test(t)) e += 0.1; // 商品名・成分名など
  if (/[「『]/.test(t)) e += 0.1;
  if (CONNECTIVE_END.test(t)) e -= 0.3; // 話の途中(つなぎ)は速く
  const n = Array.from(t).length;
  if (n <= 6) e += 0.1; // 短い決め台詞
  if (n >= 20) e -= 0.15; // 長い説明
  if (count > 2 && index === count - 1) e += 0.25; // 最後(呼びかけ・まとめ)
  return Math.max(0, Math.min(1, e));
}

const round = (v: number) => Math.round(v * 20) / 20;

/**
 * カットごとの速さを決める。texts はカットの文章、durs はカットの元の長さ(秒)。
 * 戻り値は 0.05 刻みの速さ。
 */
export function tempoSpeeds(texts: string[], durs: number[], s: TempoSettings): number[] {
  const n = texts.length;
  const max = Math.max(s.min, s.max);
  const min = Math.min(s.min, s.max);
  const span = max - min;
  if (s.mode === 'off' || n === 0) return texts.map(() => 1);
  let v: number[];
  if (s.mode === 'wave') {
    // 時間に沿った波(約8秒で1周。冒頭は速く入る)。速い所と遅い所が交互に来る
    let t = 0;
    v = durs.map((d) => {
      const mid = t + d / 2;
      t += d;
      return min + span * (0.5 + 0.5 * Math.cos((2 * Math.PI * mid) / 8));
    });
  } else if (s.mode === 'pulse') {
    // ふだんは少しだけ速く、3カットに1回ぐっと速く。最後はゆっくり
    v = texts.map((_, i) => (i % 3 === 1 ? max : min + span * 0.3));
    if (n > 2) v[n - 1] = min;
  } else {
    // 台本から: 大事なカットはゆっくり、つなぎ・説明は速く
    const raw = texts.map((t, i) => emphasisOf(t, i, n));
    // 動画の中での相対的な大事さにする(いちばん大事なカットが最低、いちばん軽いカットが最高の速さ)
    const lo = Math.min(...raw);
    const hi = Math.max(...raw);
    const e = hi - lo > 0.05 ? raw.map((x) => (x - lo) / (hi - lo)) : raw;
    v = e.map((x) => max - x * span);
    // 同じ速さが3つ続いたら、真ん中を少し動かして変化をつける
    for (let i = 1; i < n - 1; i++) {
      if (Math.abs(v[i - 1]! - v[i]!) < 0.04 && Math.abs(v[i + 1]! - v[i]!) < 0.04) v[i] = v[i]! > min + span / 2 ? v[i]! - span * 0.35 : v[i]! + span * 0.35;
    }
  }
  // 隣のカットで急に変わりすぎない(差は 0.25 倍まで)
  for (let i = 1; i < n; i++) {
    const d = v[i]! - v[i - 1]!;
    if (Math.abs(d) > 0.25) v[i] = v[i - 1]! + Math.sign(d) * 0.25;
  }
  return v.map((x) => round(Math.max(min, Math.min(max, x))));
}
