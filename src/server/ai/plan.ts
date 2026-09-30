// 素材の割り当て計画: 動画を場面(ショット)に分けることと、
// Claude の候補から「同じ場面が近いカットで重ならない」ように選ぶこと。

export interface Shot {
  /** Claude に見せるID(例: V2-7。画像は I3) */
  id: string;
  assetId: string;
  /** 動画内の開始・終了(秒)。画像は 0 */
  start: number;
  end: number;
  /** 同じ長い場面を分けたものは同じ group(近いカットで続けて使わない) */
  group: string;
  image: boolean;
}

/** 場面の切り替わり(秒)から場面の区間を作る。短すぎる場面は隣とまとめ、長い場面は分ける */
export function shotsFromCuts(duration: number, cuts: number[], opt = { minLen: 0.6, maxLen: 6, pieceLen: 3.5 }): { start: number; end: number; group: number }[] {
  if (!(duration > 0)) return [];
  const pts = [0, ...cuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b), duration];
  let raw: { start: number; end: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1]! - pts[i]! > 1e-3) raw.push({ start: pts[i]!, end: pts[i + 1]! });
  // 短い場面は、短い方の隣とまとめる
  for (;;) {
    const i = raw.findIndex((s) => s.end - s.start < opt.minLen);
    if (i < 0 || raw.length === 1) break;
    const prev = raw[i - 1];
    const next = raw[i + 1];
    const into = !prev ? i + 1 : !next ? i - 1 : prev.end - prev.start <= next.end - next.start ? i - 1 : i + 1;
    const a = Math.min(i, into);
    raw = [...raw.slice(0, a), { start: raw[a]!.start, end: raw[a + 1]!.end }, ...raw.slice(a + 2)];
  }
  const out: { start: number; end: number; group: number }[] = [];
  raw.forEach((s, g) => {
    const len = s.end - s.start;
    if (len <= opt.maxLen) {
      out.push({ ...s, group: g });
      return;
    }
    // 長い場面(カメラが動き続ける映像など)は数秒ずつに分ける
    const n = Math.max(2, Math.round(len / opt.pieceLen));
    for (let k = 0; k < n; k++) out.push({ start: s.start + (len * k) / n, end: s.start + (len * (k + 1)) / n, group: g });
  });
  return out;
}

export interface PlanCut {
  durationSec: number;
  /** Claude が選んだ候補(良い順)。場面ID */
  choices: string[];
}

export interface PlanOptions {
  /** 同じ場面をもう一度使うまでに空けるカット数 */
  minGap: number;
  /** 同じ長い場面を分けたもの同士を使うまでに空けるカット数 */
  groupGap: number;
}

/**
 * カットごとに場面を決める。Claude の候補を良い順に見て、近いカットで同じ場面(同じ長い場面の一部も)を
 * 使わないものを選ぶ。候補がすべて使えないときは、ほかのカットの候補(= Claude が使えると判断した場面)から、
 * それもなければ全場面から、使った回数が少なく長さが足りるものを選ぶ。
 */
export function planAssignments(cuts: PlanCut[], shots: Shot[], opt: PlanOptions): { shot: Shot; fromChoices: boolean }[] {
  const byId = new Map(shots.map((s) => [s.id, s]));
  const lastUse = new Map<string, number>();
  const lastGroup = new Map<string, number>();
  const uses = new Map<string, number>();
  // Claude がどこかのカットで候補に挙げた場面(使える場面)
  const suggested = new Set(cuts.flatMap((c) => c.choices).filter((id) => byId.has(id)));
  const fits = (s: Shot, dur: number) => s.image || s.end - s.start >= dur * 0.8;
  const free = (s: Shot, i: number, gap: number, ggap: number) => {
    const u = lastUse.get(s.id);
    const g = lastGroup.get(s.group);
    return (u === undefined || i - u > gap) && (g === undefined || i - g > ggap);
  };
  const out: { shot: Shot; fromChoices: boolean }[] = [];
  cuts.forEach((c, i) => {
    const choices = c.choices.map((id) => byId.get(id)).filter((s): s is Shot => !!s);
    let pick: Shot | undefined;
    let fromChoices = true;
    // 1. Claude の候補から: 未使用で長さの足りるもの → 未使用 → 間が空いているもの
    pick =
      choices.find((s) => !uses.get(s.id) && free(s, i, opt.minGap, opt.groupGap) && fits(s, c.durationSec)) ??
      choices.find((s) => !uses.get(s.id) && free(s, i, opt.minGap, opt.groupGap)) ??
      choices.find((s) => free(s, i, opt.minGap, opt.groupGap));
    if (!pick) {
      fromChoices = false;
      // 2. ほかのカットの候補 → 3. 全場面。使った回数が少なく、最後に使ってから長いものを優先
      const rank = (pool: Shot[], gap: number, ggap: number) =>
        pool
          .filter((s) => free(s, i, gap, ggap))
          .sort(
            (a, b) =>
              (uses.get(a.id) ?? 0) - (uses.get(b.id) ?? 0) ||
              Number(fits(b, c.durationSec)) - Number(fits(a, c.durationSec)) ||
              (lastUse.get(a.id) ?? -1e9) - (lastUse.get(b.id) ?? -1e9),
          )[0];
      const pool = shots.filter((s) => suggested.has(s.id));
      pick =
        rank(pool, opt.minGap, opt.groupGap) ??
        rank(shots, opt.minGap, opt.groupGap) ??
        // 場面が少なすぎて間を空けられないとき: 間を縮めても、直前と同じ場面(同じ長い場面の一部も)にはしない
        rank(shots, Math.min(1, opt.minGap), Math.min(1, opt.groupGap)) ??
        rank(shots, Math.min(1, opt.minGap), 0) ??
        rank(shots, 0, 0);
    }
    const s = pick!;
    out.push({ shot: s, fromChoices });
    lastUse.set(s.id, i);
    lastGroup.set(s.group, i);
    uses.set(s.id, (uses.get(s.id) ?? 0) + 1);
  });
  return out;
}

/**
 * 間を空けるカット数(場面が少ないときは縮める)。
 * 「i - 前回 > gap」を満たすときだけ使えるので、gap=1 で連続禁止、gap=8 なら間に8カット以上
 */
export function gapFor(nShots: number, nGroups: number): PlanOptions {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    minGap: nShots >= 2 ? clamp(Math.floor(nShots / 2), 1, 8) : 0,
    groupGap: nGroups >= 2 ? clamp(Math.floor(nGroups / 2), 1, 2) : 0,
  };
}
