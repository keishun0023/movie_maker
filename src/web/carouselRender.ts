// 写真投稿のページを Canvas に描く。プレビューも書き出し(1080×1920 の PNG)もこの関数だけで描く。
import { CAROUSEL_H, CAROUSEL_W, type BackgroundPreset, type Carousel, type CarouselImage, type ComparePage, type CompareSide, type CoverPage, type ProductPage } from '../shared/carousel.js';
import { wrapText } from '../shared/jatext.js';
import { fontAlias } from '../shared/captionRender.js';

export const TEXT_FONT_ID = 'bundled:NotoSansJP-VF.ttf';
export const HEAD_FONT_ID = 'bundled:DelaGothicOne-Regular.ttf';
const EMOJI = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";
const textFont = (size: number, weight = 900) => `${weight} ${size}px ${fontAlias(TEXT_FONT_ID)}, ${EMOJI}, sans-serif`;
const headFont = (size: number) => `400 ${size}px ${fontAlias(HEAD_FONT_ID)}, ${fontAlias(TEXT_FONT_ID)}, ${EMOJI}, sans-serif`;

/** 画像の読み込み(同じ画像は使い回す)。読み込めたら onLoad を呼ぶ */
const cache = new Map<string, HTMLImageElement>();
let onLoad: (() => void) | null = null;
export function setImageLoadedCallback(fn: () => void) {
  onLoad = fn;
}

export function imageUrl(carouselId: string, im: CarouselImage): string {
  return `/api/carousels/${carouselId}/files/images/${encodeURIComponent(im.file.replace(/^images\//, ''))}`;
}

function img(carouselId: string, im: CarouselImage | undefined): HTMLImageElement | null {
  if (!im) return null;
  const url = imageUrl(carouselId, im);
  let el = cache.get(url);
  if (!el) {
    el = new Image();
    el.onload = () => onLoad?.();
    el.src = url;
    cache.set(url, el);
  }
  return el.complete && el.naturalWidth > 0 ? el : null;
}

/** 使う画像がすべて読み込まれるまで待つ(書き出しの前に) */
export async function waitImages(c: Carousel): Promise<void> {
  const list: CarouselImage[] = [];
  for (const p of c.pages) {
    if (p.kind !== 'compare') {
      if (p.image) list.push(p.image);
    } else for (const s of [p.left, p.right]) if (s.image) list.push(s.image);
  }
  for (const im of [c.style.backgroundImage, c.style.leftCharacter, c.style.rightCharacter]) if (im) list.push(im);
  await Promise.all(
    list.map((im) => {
      img(c.id, im);
      const el = cache.get(imageUrl(c.id, im))!;
      if (el.complete) return Promise.resolve();
      return new Promise<void>((r) => {
        el.addEventListener('load', () => r(), { once: true });
        el.addEventListener('error', () => r(), { once: true });
      });
    }),
  );
}

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** 枠いっぱいに切り抜いて描く(cover)か、枠に収める(contain) */
function drawImageFit(ctx: Ctx, el: HTMLImageElement, x: number, y: number, w: number, h: number, mode: 'cover' | 'contain', radius = 0, alignBottom = false) {
  const iw = el.naturalWidth;
  const ih = el.naturalHeight;
  const s = mode === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  const dx = x + (w - dw) / 2;
  // 顔の写真は上の方が大事なので、縦に切るときは上寄りにする
  const dy = mode === 'cover' ? y + (h - dh) * 0.3 : alignBottom ? y + h - dh : y + (h - dh) / 2;
  ctx.save();
  if (radius > 0 || mode === 'cover') {
    roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
  }
  ctx.drawImage(el, dx, dy, dw, dh);
  ctx.restore();
}

/** 決まった乱数(同じ投稿はいつも同じ背景になるように) */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const GRADIENTS: Record<BackgroundPreset, [string, string, string]> = {
  lavender: ['#d8cff2', '#f1d4ea', '#e6c3df'],
  'pink-water': ['#c79fa8', '#d9b6bb', '#c8a0a8'],
  pink: ['#fff4f5', '#ffd6db', '#ffb9c2'],
  mint: ['#d4efe6', '#eef7e4', '#d9efe8'],
  cream: ['#f6eee2', '#f6e0d6', '#efd6cc'],
};

let water: HTMLCanvasElement | null = null;

/** 水面のゆらめき(光の網目)。セルの境目ほど明るくする(F2 - F1)。小さく作って引き伸ばす */
function waterTexture(): HTMLCanvasElement {
  if (water) return water;
  const w = 270;
  const h = 480;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const im = ctx.createImageData(w, h);
  const r = rng(11);
  // 横長につぶれたセル(水面は斜めから見ているので)
  const pts = Array.from({ length: 140 }, () => [r() * w, r() * h] as const);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 座標をゆがませて、網目を波打たせる
      const wx = x + 7 * Math.sin(y / 19 + 1.3) + 4 * Math.sin((x + y) / 13);
      const wy = y + 6 * Math.sin(x / 17) + 3 * Math.sin((x - y) / 11 + 0.7);
      let f1 = 1e9;
      let f2 = 1e9;
      for (const [px, py] of pts) {
        let dx = Math.abs((((wx % w) + w) % w) - px);
        let dy = Math.abs((((wy % h) + h) % h) - py);
        dx = Math.min(dx, w - dx);
        dy = Math.min(dy, h - dy) * 1.5;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
      const edge = Math.exp(-(f2 - f1) / 1.6);
      const a = (y * w + x) * 4;
      im.data[a] = 255;
      im.data[a + 1] = 255;
      im.data[a + 2] = 255;
      im.data[a + 3] = Math.round(255 * Math.min(1, edge * 0.7 * (0.55 + 0.45 * Math.sin(x / 31 + y / 47) ** 2)));
    }
  }
  ctx.putImageData(im, 0, 0);
  // 少しぼかして柔らかくする
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const o = out.getContext('2d')!;
  o.filter = 'blur(0.8px)';
  o.drawImage(cv, 0, 0);
  water = out;
  return out;
}

function drawBackground(ctx: Ctx, c: Carousel) {
  const W = CAROUSEL_W;
  const H = CAROUSEL_H;
  const bg = img(c.id, c.style.backgroundImage);
  if (bg) {
    drawImageFit(ctx, bg, 0, 0, W, H, 'cover');
    return;
  }
  const [a, b, d] = GRADIENTS[c.style.background] ?? GRADIENTS.lavender;
  const g = c.style.background === 'pink' ? ctx.createLinearGradient(0, 0, W, 0) : ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, a);
  g.addColorStop(0.55, b);
  g.addColorStop(1, d);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (c.style.background === 'pink-water') ctx.drawImage(waterTexture(), 0, 0, W, H);
  else {
    // ふんわりした光
    const r = rng(3);
    for (let i = 0; i < 5; i++) {
      const x = r() * W;
      const y = r() * H;
      const rad = 250 + r() * 350;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, 'rgba(255,255,255,0.35)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }
  }
}

/** 幅に収まるまで文字を小さくして折り返す。少し小さくして1行に収まるなら、折り返さない */
function fitLines(ctx: Ctx, text: string, maxWidth: number, size: number, minSize: number, maxLines: number, font: (s: number) => string): { lines: string[]; size: number } {
  const attempt = (lineLimit: number, floor: number) => {
    for (let s = size; ; s -= 2) {
      ctx.font = font(s);
      const lines = wrapText(text, maxWidth, (t) => ctx.measureText(t).width, lineLimit);
      const ok = lines.length <= lineLimit && lines.every((l) => ctx.measureText(l).width <= maxWidth + 1);
      if (ok) return { lines, size: s };
      if (s <= floor) return null;
    }
  };
  if (maxLines > 1 && !text.includes('\n')) {
    const one = attempt(1, Math.max(minSize, Math.round(size * 0.78)));
    if (one) return one;
  }
  const r = attempt(maxLines, minSize);
  if (r) return r;
  ctx.font = font(minSize);
  return { lines: wrapText(text, maxWidth, (t) => ctx.measureText(t).width, maxLines).slice(0, maxLines), size: minSize };
}

function drawLines(ctx: Ctx, lines: string[], cx: number, top: number, size: number, lineHeight = 1.22): number {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, cx, top + size * lineHeight * (i + 0.5)));
  return top + size * lineHeight * lines.length;
}

/** 文字の入った角丸の箱。返り値は箱の下端 */
function textBox(ctx: Ctx, text: string, cx: number, top: number, opt: { size: number; minSize?: number; maxWidth: number; color: string; box: string; padX?: number; padY?: number; radius?: number; maxLines?: number }): number {
  const padX = opt.padX ?? 34;
  const padY = opt.padY ?? 18;
  const { lines, size } = fitLines(ctx, text, opt.maxWidth - padX * 2, opt.size, opt.minSize ?? 36, opt.maxLines ?? 2, (s) => textFont(s));
  ctx.font = textFont(size);
  const w = Math.min(opt.maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2);
  const h = size * 1.22 * lines.length + padY * 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.12)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = opt.box;
  roundRect(ctx, cx - w / 2, top, w, h, opt.radius ?? 18);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = opt.color;
  drawLines(ctx, lines, cx, top + padY, size);
  return top + h;
}

function drawCover(ctx: Ctx, c: Carousel, p: CoverPage) {
  const W = CAROUSEL_W;
  const H = CAROUSEL_H;
  const photo = img(c.id, p.image);
  if (photo) drawImageFit(ctx, photo, 0, 0, W, H, 'cover');
  else drawBackground(ctx, c);
  let y = H * Math.max(0.05, Math.min(0.85, p.titleY ?? 0.46));
  if (p.kicker) {
    const { lines, size } = fitLines(ctx, `＼${p.kicker}／`, W - 140, 52, 32, 1, (s) => textFont(s));
    ctx.save();
    ctx.font = textFont(size);
    // 明るい写真でも読めるよう、うすい黒の帯を敷く
    const w = ctx.measureText(lines[0] ?? '').width + 56;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    roundRect(ctx, W / 2 - w / 2, y - 6, w, size * 1.22 + 12, (size * 1.22 + 12) / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    y = drawLines(ctx, lines, W / 2, y, size) + 20;
    ctx.restore();
  }
  const bottom = textBox(ctx, p.title || 'タイトル', W / 2, y, { size: 74, minSize: 44, maxWidth: W - 120, color: '#111111', box: '#ffffff', radius: 14, padY: 16 });
  // ▶▶(次へ)
  const s = 54;
  const x0 = W - 60 - s * 2 - 10;
  for (let i = 0; i < 2; i++) {
    const x = x0 + i * (s + 10);
    const yy = bottom + 22;
    const g = ctx.createLinearGradient(0, yy, 0, yy + s);
    g.addColorStop(0, '#8fc4f2');
    g.addColorStop(1, '#3f86d6');
    ctx.fillStyle = g;
    roundRect(ctx, x, yy, s, s, 10);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x + s * 0.34, yy + s * 0.25);
    ctx.lineTo(x + s * 0.34, yy + s * 0.75);
    ctx.lineTo(x + s * 0.76, yy + s * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}

function drawCross(ctx: Ctx, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.strokeStyle = '#1d5fa0';
  ctx.lineWidth = r * 0.42;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.7, cy - r * 0.7);
  ctx.lineTo(cx + r * 0.7, cy + r * 0.7);
  ctx.moveTo(cx + r * 0.7, cy - r * 0.7);
  ctx.lineTo(cx - r * 0.7, cy + r * 0.7);
  ctx.stroke();
  ctx.restore();
}

function drawCircle(ctx: Ctx, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.strokeStyle = '#e3202b';
  ctx.lineWidth = r * 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

interface SideText {
  text: { lines: string[]; size: number } | null;
  note: { lines: string[]; size: number } | null;
  height: number;
}

function layoutSide(ctx: Ctx, side: CompareSide, w: number): SideText {
  const text = side.text ? fitLines(ctx, side.text, w - 20, 62, 34, 2, (s) => textFont(s)) : null;
  const note = side.note ? fitLines(ctx, side.note, w - 20, 38, 26, 2, (s) => textFont(s, 800)) : null;
  const height = (text ? text.size * 1.22 * text.lines.length + 6 : 0) + (note ? note.size * 1.22 * note.lines.length : 0);
  return { text, note, height };
}

function drawSide(ctx: Ctx, c: Carousel, side: CompareSide, lay: SideText, x: number, w: number, top: number, imgH: number): void {
  const cx = x + w / 2;
  const photo = img(c.id, side.image);
  const pad = 14;
  if (photo) drawImageFit(ctx, photo, x + pad, top, w - pad * 2, imgH, 'cover', 16);
  else {
    ctx.save();
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3;
    roundRect(ctx, x + pad, top, w - pad * 2, imgH, 16);
    ctx.stroke();
    ctx.restore();
  }
  let y = top + imgH + 20;
  if (lay.text) {
    ctx.font = textFont(lay.text.size);
    ctx.fillStyle = '#141414';
    y = drawLines(ctx, lay.text.lines, cx, y, lay.text.size) + 6;
  }
  if (lay.note) {
    ctx.font = textFont(lay.note.size, 800);
    ctx.fillStyle = '#333333';
    drawLines(ctx, lay.note.lines, cx, y, lay.note.size);
  }
}

function drawCompare(ctx: Ctx, c: Carousel, p: ComparePage) {
  const W = CAROUSEL_W;
  drawBackground(ctx, c);
  // お題
  let y = 300;
  if (p.label) {
    // ラベル付き: ピンクの箱に「ラベル(小) + お題(大)」
    ctx.font = textFont(40);
    const tl = fitLines(ctx, p.title, W - 300, 84, 48, 1, (s) => textFont(s));
    ctx.font = textFont(tl.size);
    const w = Math.min(W - 160, Math.max(ctx.measureText(tl.lines[0] ?? '').width, 300) + 110);
    const h = 40 * 1.3 + tl.size * 1.25 + 44;
    ctx.fillStyle = 'rgba(233, 170, 236, 0.92)';
    roundRect(ctx, W / 2 - w / 2, y, w, h, 34);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = textFont(40, 800);
    drawLines(ctx, [p.label], W / 2, y + 18, 40, 1.3);
    ctx.font = textFont(tl.size);
    drawLines(ctx, tl.lines, W / 2, y + 18 + 40 * 1.3, tl.size, 1.25);
    y += h + 18;
  } else {
    y = textBox(ctx, p.title || 'お題', W / 2, y, { size: 80, minSize: 46, maxWidth: W - 120, color: '#111111', box: '#ffffff', radius: 16, maxLines: 2 }) + 16;
  }
  if (p.subtitle) y = textBox(ctx, p.subtitle, W / 2, y, { size: 46, minSize: 30, maxWidth: W - 140, color: '#111111', box: 'rgba(255,255,255,0.95)', padY: 10, radius: 16, maxLines: 2 }) + 12;

  // 比較の枠。下のキャラクターは枠の下端に少し重ね、言葉には重ならないようにする
  const top = Math.max(y + 16, 560);
  const panelX = 120;
  const panelW = W - panelX * 2;
  const colW = panelW / 2;
  const hasChars = !!(c.style.leftCharacter || c.style.rightCharacter);
  const charH = 420;
  // キャラクターは下の端に寄せて(TikTok の本文が重なるあたり)、画像の場所を広くとる
  const charBottom = CAROUSEL_H - 70;
  const charTop = charBottom - charH;
  const bottom = hasChars ? charTop + charH * 0.42 : CAROUSEL_H - 360;
  const contentEnd = (hasChars ? charTop : bottom) - 24;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  roundRect(ctx, panelX, top, panelW, bottom - top, 6);
  ctx.fill();
  // 仕切り線
  ctx.save();
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 10]);
  ctx.beginPath();
  ctx.moveTo(W / 2, top + 30);
  ctx.lineTo(W / 2, bottom - 30);
  ctx.stroke();
  ctx.restore();
  // 左右の見出し
  const headY = top + 80;
  if (c.style.heads === 'marks') {
    drawCross(ctx, panelX + colW / 2, headY, 46);
    drawCircle(ctx, panelX + colW + colW / 2, headY, 46);
  } else {
    for (const [i, word] of [c.style.leftWord, c.style.rightWord].entries()) {
      const t = fitLines(ctx, word, colW - 30, 104, 50, 1, headFont);
      ctx.font = headFont(t.size);
      const color = (i === 0 ? c.style.leftColor : c.style.rightColor) || '#111111';
      if (color !== '#111111') {
        // 色付きの見出しは、白いふちを付けて背景から浮かせる
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 14;
        ctx.strokeStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        t.lines.forEach((l, k) => ctx.strokeText(l, panelX + colW * i + colW / 2, headY - t.size * 0.6 + t.size * 1.2 * (k + 0.5)));
        ctx.restore();
      }
      ctx.fillStyle = color;
      drawLines(ctx, t.lines, panelX + colW * i + colW / 2, headY - t.size * 0.6, t.size, 1.2);
    }
  }
  // 画像と言葉(言葉の高さを先に測り、残りを画像にする)
  const left = layoutSide(ctx, p.left, colW);
  const right = layoutSide(ctx, p.right, colW);
  const imgTop = headY + 70;
  const imgH = Math.max(200, Math.min(520, contentEnd - imgTop - 20 - Math.max(left.height, right.height)));
  drawSide(ctx, c, p.left, left, panelX, colW, imgTop, imgH);
  drawSide(ctx, c, p.right, right, panelX + colW, colW, imgTop, imgH);
  // 下のキャラクター
  [c.style.leftCharacter, c.style.rightCharacter].forEach((im, i) => {
    const el = img(c.id, im);
    if (!el) return;
    const cw = 400;
    const x = i === 0 ? W / 2 - cw - 6 : W / 2 + 6;
    drawImageFit(ctx, el, x, charTop, cw, charH, 'contain', 0, true);
  });
}

/** 商品ページ: 見出し・紹介文・商品の画像・値段(打ち消し線と赤字の一言) */
function drawProduct(ctx: Ctx, c: Carousel, p: ProductPage) {
  const W = CAROUSEL_W;
  drawBackground(ctx, c);
  // 見出し(下線つき)
  const t = fitLines(ctx, p.title || '見出し', W - 200, 76, 44, 2, (s) => textFont(s));
  ctx.font = textFont(t.size);
  ctx.fillStyle = '#111111';
  let y = drawLines(ctx, t.lines, W / 2, 300, t.size, 1.25) + 18;
  ctx.fillRect(170, y, W - 340, 5);
  y += 50;
  // 紹介文(白い角丸の箱)
  if (p.body.trim()) {
    const b = fitLines(ctx, p.body, W - 260, 38, 26, 8, (s) => textFont(s, 800));
    ctx.font = textFont(b.size, 800);
    const h = b.size * 1.5 * b.lines.length + 50;
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    roundRect(ctx, 110, y, W - 220, h, 26);
    ctx.fill();
    ctx.fillStyle = '#222222';
    drawLines(ctx, b.lines, W / 2, y + 25, b.size, 1.5);
    y += h + 30;
  }
  // 値段の高さを先に測って、残りに商品の画像
  const priceH = (p.priceBefore ? 80 : 0) + (p.priceAfter ? 160 : 0);
  const imgBottom = CAROUSEL_H - 300 - priceH;
  const el = img(c.id, p.image);
  if (el) drawImageFit(ctx, el, 160, y, W - 320, Math.max(200, imgBottom - y), 'contain');
  let py = imgBottom + 20;
  if (p.priceBefore) {
    const pb = fitLines(ctx, p.priceBefore, W - 200, 56, 34, 1, (s) => textFont(s));
    ctx.font = textFont(pb.size);
    ctx.fillStyle = '#222222';
    drawLines(ctx, pb.lines, W / 2, py, pb.size, 1.2);
    const w = ctx.measureText(pb.lines[0] ?? '').width;
    ctx.fillRect(W / 2 - w / 2 - 10, py + pb.size * 0.62, w + 20, 6);
    py += 80;
  }
  if (p.priceAfter) {
    const pa = fitLines(ctx, p.priceAfter, W - 140, 72, 40, 2, (s) => textFont(s));
    ctx.font = textFont(pa.size);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    pa.lines.forEach((l, k) => ctx.strokeText(l, W / 2, py + pa.size * 1.2 * (k + 0.5)));
    ctx.restore();
    ctx.fillStyle = '#e0303a';
    drawLines(ctx, pa.lines, W / 2, py, pa.size, 1.2);
  }
}

/** 1ページを描く。canvas の大きさは自由(1080×1920 を縮小して描く) */
export function drawCarouselPage(canvas: HTMLCanvasElement, c: Carousel, index: number) {
  const ctx = canvas.getContext('2d')!;
  const p = c.pages[index];
  ctx.save();
  ctx.setTransform(canvas.width / CAROUSEL_W, 0, 0, canvas.height / CAROUSEL_H, 0, 0);
  ctx.clearRect(0, 0, CAROUSEL_W, CAROUSEL_H);
  if (p?.kind === 'cover') drawCover(ctx, c, p);
  else if (p?.kind === 'product') drawProduct(ctx, c, p);
  else if (p) drawCompare(ctx, c, p);
  ctx.restore();
}
