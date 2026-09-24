// 素材を 9:16 の画面へ配置する計算。プレビューと書き出しで同じ関数を使う。
import type { BgPlacement, InsetPlacement } from './types.js';

export interface Placement {
  /** 出力画面上の左上位置(px, はみ出しで負になる) */
  x: number;
  y: number;
  /** 拡大縮小後のサイズ(px) */
  w: number;
  h: number;
}

export function placeBackground(
  srcW: number,
  srcH: number,
  W: number,
  H: number,
  bg: Pick<BgPlacement, 'fit' | 'zoom' | 'offsetX' | 'offsetY'>,
): Placement {
  const base = bg.fit === 'cover' ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH);
  const s = base * Math.max(0.1, bg.zoom);
  const w = srcW * s;
  const h = srcH * s;
  const ox = Math.max(-1, Math.min(1, bg.offsetX));
  const oy = Math.max(-1, Math.min(1, bg.offsetY));
  const x = (W - w) / 2 + (ox * Math.abs(W - w)) / 2;
  const y = (H - h) / 2 + (oy * Math.abs(H - h)) / 2;
  return { x, y, w, h };
}

/** FFmpeg 用: 表示範囲だけ切り出してから拡大する整数矩形 */
export interface CropScale {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  outW: number;
  outH: number;
  outX: number;
  outY: number;
}

export function cropScaleFor(srcW: number, srcH: number, W: number, H: number, p: Placement): CropScale | null {
  const vx0 = Math.max(0, p.x);
  const vy0 = Math.max(0, p.y);
  const vx1 = Math.min(W, p.x + p.w);
  const vy1 = Math.min(H, p.y + p.h);
  if (vx1 - vx0 < 1 || vy1 - vy0 < 1) return null;
  const s = p.w / srcW;
  let cropX = Math.floor((vx0 - p.x) / s);
  let cropY = Math.floor((vy0 - p.y) / s);
  let cropW = Math.ceil((vx1 - p.x) / s) - cropX;
  let cropH = Math.ceil((vy1 - p.y) / s) - cropY;
  cropX = Math.max(0, Math.min(srcW - 1, cropX));
  cropY = Math.max(0, Math.min(srcH - 1, cropY));
  cropW = Math.max(1, Math.min(srcW - cropX, cropW));
  cropH = Math.max(1, Math.min(srcH - cropY, cropH));
  const outX = Math.round(p.x + cropX * s);
  const outY = Math.round(p.y + cropY * s);
  const outW = Math.max(2, Math.round(cropW * s));
  const outH = Math.max(2, Math.round(cropH * s));
  return { cropX, cropY, cropW, cropH, outX, outY, outW, outH };
}

export function placeInset(srcW: number, srcH: number, W: number, H: number, inset: Pick<InsetPlacement, 'x' | 'y' | 'width'>): Placement {
  const w = Math.max(8, Math.round(W * inset.width));
  const h = Math.max(8, Math.round((w * srcH) / srcW));
  const x = Math.round(W * inset.x - w / 2);
  const y = Math.round(H * inset.y - h / 2);
  return { x, y, w, h };
}

/** ゆっくりズーム(任意機能)の倍率。シーン内の進み具合 0..1 */
export function kenBurnsScale(progress: number): number {
  return 1 + 0.08 * Math.max(0, Math.min(1, progress));
}
