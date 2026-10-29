// 写真投稿(比較カルーセル)の保存。動画のプロジェクトとは別のフォルダ(carousels/<id>)に、
// carousel.json・使う画像(images)・書き出した画像(exports)を置く。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { createCarousel, type Carousel, type CarouselImage } from '../../shared/carousel.js';
import { carouselsRoot } from './paths.js';
import { assertId, atomicWrite, HttpError } from '../store.js';



/** 画面に表示できる画像の拡張子 */
export const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
/** 1枚の画像の上限 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function carouselDir(id: string): string {
  return path.join(carouselsRoot(), assertId(id));
}

/** カルーセルのフォルダ内のファイル(images / exports の中だけ) */
export function carouselFile(id: string, dir: 'images' | 'exports', name: string): string {
  const base = path.join(carouselDir(id), dir);
  const p = path.resolve(base, path.basename(name));
  if (!p.startsWith(base + path.sep)) throw new HttpError(400, '不正なパスです');
  return p;
}

export interface CarouselSummary {
  id: string;
  name: string;
  theme: string;
  status: Carousel['status'];
  formatId?: string;
  imagePolicy: Carousel['imagePolicy'];
  scheduledOn?: string;
  memo: string;
  pages: number;
  /** 表紙の画像(一覧の縮小表示用) */
  cover?: CarouselImage;
  updatedAt: string;
}

export async function listCarousels(): Promise<CarouselSummary[]> {
  const root = carouselsRoot();
  await fsp.mkdir(root, { recursive: true });
  const out: CarouselSummary[] = [];
  for (const d of await fsp.readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const j = await loadCarousel(d.name);
      const cover = j.pages[0]?.kind === 'cover' ? j.pages[0].image : undefined;
      out.push({
        id: j.id,
        name: j.name,
        theme: j.theme,
        status: j.status,
        imagePolicy: j.imagePolicy,
        memo: j.memo,
        pages: j.pages.length,
        updatedAt: j.updatedAt,
        ...(j.formatId ? { formatId: j.formatId } : {}),
        ...(j.scheduledOn ? { scheduledOn: j.scheduledOn } : {}),
        ...(cover ? { cover } : {}),
      });
    } catch {
      /* 壊れたものは一覧に出さない */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function newCarousel(name: string): Promise<Carousel> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `c${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  const c = createCarousel(id, name.trim() || '新しい写真投稿');
  for (const d of ['images', 'exports']) await fsp.mkdir(path.join(carouselDir(id), d), { recursive: true });
  await saveCarousel(c);
  return c;
}

export async function loadCarousel(id: string): Promise<Carousel> {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(carouselDir(id), 'carousel.json'), 'utf8')) as Carousel;
    // 古い保存形式でも開けるよう、足りない項目は初期値で埋める
    const base = createCarousel(id, j.name ?? '');
    return { ...base, ...j, id, style: { ...base.style, ...j.style } };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, '写真投稿が見つかりません');
  }
}

const chains = new Map<string, Promise<void>>();

export async function saveCarousel(c: Carousel): Promise<Carousel> {
  const id = assertId(c.id);
  const next: Carousel = { ...c, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(next, null, 1);
  const job = (chains.get(id) ?? Promise.resolve()).then(() => atomicWrite(path.join(carouselDir(id), 'carousel.json'), json));
  chains.set(id, job.catch(() => undefined));
  await job;
  return next;
}

export async function deleteCarousel(id: string): Promise<void> {
  await fsp.rm(carouselDir(id), { recursive: true, force: true });
}

/** 画像のバイト列を images に保存する(同じ内容なら同じファイル名) */
export async function saveImage(id: string, buf: Buffer, ext: string, meta: Omit<CarouselImage, 'file'>): Promise<CarouselImage> {
  const e = ext.toLowerCase() === '.jpeg' ? '.jpg' : ext.toLowerCase();
  if (!IMAGE_EXT.includes(e)) throw new HttpError(415, `使えない画像の形式です(${ext || '不明'})。JPEG・PNG・WebP・GIF に対応しています`);
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24) + e;
  const file = carouselFile(id, 'images', name);
  if (!fs.existsSync(file)) await atomicWrite(file, buf);
  return { file: `images/${name}`, ...meta };
}

/** ブラウザから送られた画像(x-filename ヘッダー付き)を読む */
export async function readUpload(req: IncomingMessage): Promise<{ buf: Buffer; name: string; ext: string }> {
  const name = path.basename(decodeURIComponent(String(req.headers['x-filename'] ?? 'image')));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_IMAGE_BYTES) throw new HttpError(413, '画像が大きすぎます(25MBまで)');
    chunks.push(c as Buffer);
  }
  if (size === 0) throw new HttpError(400, '空のファイルです');
  return { buf: Buffer.concat(chunks), name, ext: path.extname(name) };
}
