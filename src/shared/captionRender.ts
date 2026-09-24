// テロップ描画の共通関数。プレビューも書き出し用の透明PNGも、この関数だけで描く。
import type { Caption, CaptionStyle } from './types.js';
import { wrapText } from './jatext.js';

export const DEFAULT_STYLE: CaptionStyle = {
  fontId: 'bundled:NotoSansJP-VF.ttf',
  weight: 900,
  size: 76,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 6,
  shadow: false,
  shadowColor: '#000000',
  shadowBlur: 8,
  shadowOffsetY: 4,
  lineHeight: 1.25,
  align: 'center',
  maxWidth: 880,
  maxLines: 2,
  x: 0.5,
  y: 0.43,
  band: false,
  bandColor: '#000000',
  bandOpacity: 0.55,
  bandPadding: 18,
};

export function effectiveStyle(base: CaptionStyle, cap?: Pick<Caption, 'style'> | null): CaptionStyle {
  return cap?.style ? { ...base, ...cap.style } : base;
}

/** フォントIDからCanvas/FontFaceで使う専用のファミリー名(同名の別フォントに置き換わらないように) */
export function fontAlias(fontId: string): string {
  return 'TDM_' + fontId.replace(/[^A-Za-z0-9]/g, '_');
}

export interface RenderFont {
  family: string;
  /** 可変フォントなら style.weight、固定ウェイトならそのフェイスの値 */
  weight: number;
}

export interface CaptionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function fontCss(style: CaptionStyle, font: RenderFont): string {
  return `${Math.round(font.weight)} ${style.size}px "${font.family}"`;
}

export function layoutCaption(ctx: Ctx, text: string, style: CaptionStyle, font: RenderFont, W: number, H: number): CaptionBox {
  ctx.font = fontCss(style, font);
  const lines = wrapText(text, style.maxWidth, (t) => ctx.measureText(t).width, style.maxLines);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const adv = style.size * style.lineHeight;
  const blockH = style.size + adv * (lines.length - 1);
  const cx = style.x * W;
  const cy = style.y * H;
  const pad = style.strokeWidth + (style.band ? style.bandPadding : 0);
  return { x: cx - blockW / 2 - pad, y: cy - blockH / 2 - pad, w: blockW + pad * 2, h: blockH + pad * 2, lines };
}

export function drawCaption(ctx: Ctx, text: string, style: CaptionStyle, font: RenderFont, W: number, H: number): CaptionBox {
  const box = layoutCaption(ctx, text, style, font, W, H);
  const { lines } = box;
  ctx.save();
  ctx.font = fontCss(style, font);
  ctx.textBaseline = 'middle';
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const adv = style.size * style.lineHeight;
  const blockH = style.size + adv * (lines.length - 1);
  const cx = style.x * W;
  const top = style.y * H - blockH / 2;
  const left = cx - blockW / 2;

  if (style.band) {
    const p = style.bandPadding;
    ctx.globalAlpha = Math.max(0, Math.min(1, style.bandOpacity));
    ctx.fillStyle = style.bandColor;
    roundRect(ctx, left - p, top - p, blockW + p * 2, blockH + p * 2, Math.min(24, p));
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const xFor = (i: number) => {
    if (style.align === 'left') {
      ctx.textAlign = 'left';
      return left;
    }
    if (style.align === 'right') {
      ctx.textAlign = 'right';
      return left + blockW;
    }
    ctx.textAlign = 'center';
    void i;
    return cx;
  };

  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const x = xFor(i);
    const y = top + style.size / 2 + i * adv;
    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = style.shadowColor;
      ctx.shadowBlur = style.shadowBlur;
      ctx.shadowOffsetY = style.shadowOffsetY;
      if (style.strokeWidth > 0) {
        ctx.strokeStyle = style.strokeColor;
        ctx.lineWidth = style.strokeWidth * 2;
        ctx.strokeText(line, x, y);
      } else {
        ctx.fillStyle = style.color;
        ctx.fillText(line, x, y);
      }
      ctx.restore();
    }
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth * 2;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
  }
  ctx.restore();
  return box;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 1行あたりの全角文字数の目安(自動分割用) */
export function charsPerLineFor(style: CaptionStyle): number {
  return Math.max(4, Math.floor(style.maxWidth / (style.size * 1.02)));
}
