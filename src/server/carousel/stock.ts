// 素材サイト(Pixabay・Pexels)の画像検索とダウンロード。
// どちらも無料で商用利用できる画像だけを扱う(ウェブ上の任意の画像は使わない)。
// 画面は外部の画像を直接表示しない(CSP)ので、縮小画像もこのサーバーを通して渡す。
import path from 'node:path';
import type { ImageQuery } from '../../shared/carousel.js';
import { stockKey, type StockProvider } from '../secrets.js';
import { HttpError } from '../store.js';
import { MAX_IMAGE_BYTES } from './store.js';

export interface StockHit {
  provider: StockProvider;
  id: string;
  /** 一覧用の縮小画像 */
  thumb: string;
  /** 投稿に使う大きい画像 */
  full: string;
  width: number;
  height: number;
  credit: string;
  pageUrl: string;
}

/** ダウンロードしてよいホスト(素材サイトの画像配信) */
const IMAGE_HOSTS = ['pixabay.com', 'cdn.pixabay.com', 'images.pexels.com'];

export function allowedImageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, '画像のURLが正しくありません');
  }
  if (u.protocol !== 'https:' || !IMAGE_HOSTS.includes(u.hostname)) throw new HttpError(400, '素材サイト以外の画像は取得できません');
  return u;
}

interface PixabayResp {
  hits?: { id: number; pageURL: string; previewURL: string; webformatURL: string; largeImageURL: string; imageWidth: number; imageHeight: number; user: string }[];
}

interface PexelsResp {
  photos?: { id: number; url: string; width: number; height: number; photographer: string; src: { medium: string; large: string; large2x: string } }[];
}

export function parsePixabay(j: PixabayResp): StockHit[] {
  return (j.hits ?? []).map((x) => ({
    provider: 'pixabay',
    id: String(x.id),
    thumb: x.webformatURL || x.previewURL,
    full: x.largeImageURL || x.webformatURL,
    width: x.imageWidth,
    height: x.imageHeight,
    credit: x.user,
    pageUrl: x.pageURL,
  }));
}

export function parsePexels(j: PexelsResp): StockHit[] {
  return (j.photos ?? []).map((x) => ({
    provider: 'pexels',
    id: String(x.id),
    thumb: x.src.medium,
    full: x.src.large2x || x.src.large,
    width: x.width,
    height: x.height,
    credit: x.photographer,
    pageUrl: x.url,
  }));
}

/** 使える素材サイト(APIキーが設定されているもの)。イラストは Pixabay にしかない */
export function providersFor(kind: ImageQuery['kind']): StockProvider[] {
  const order: StockProvider[] = kind === 'illustration' ? ['pixabay', 'pexels'] : ['pexels', 'pixabay'];
  return order.filter((p) => !!stockKey(p));
}

export async function searchStock(provider: StockProvider, q: ImageQuery, signal?: AbortSignal): Promise<StockHit[]> {
  const key = stockKey(provider);
  if (!key) throw new HttpError(400, `${provider === 'pixabay' ? 'Pixabay' : 'Pexels'} の APIキーが設定されていません`);
  const text = q.q.trim().slice(0, 100);
  if (!text) return [];
  let res: Response;
  try {
    if (provider === 'pixabay') {
      const u = new URL('https://pixabay.com/api/');
      u.search = new URLSearchParams({ key, q: text, image_type: q.kind, safesearch: 'true', per_page: '30', lang: /[^\x00-\x7f]/.test(text) ? 'ja' : 'en' }).toString();
      res = await fetch(u, { signal });
    } else {
      const u = new URL('https://api.pexels.com/v1/search');
      u.search = new URLSearchParams({ query: text, per_page: '30', locale: /[^\x00-\x7f]/.test(text) ? 'ja-JP' : 'en-US' }).toString();
      res = await fetch(u, { headers: { Authorization: key }, signal });
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new HttpError(502, `素材サイトに接続できませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403 || (provider === 'pixabay' && res.status === 400 && (await res.clone().text()).includes('key'))) {
    throw new HttpError(400, `${provider === 'pixabay' ? 'Pixabay' : 'Pexels'} の APIキーが正しくありません`);
  }
  if (res.status === 429) throw new HttpError(429, '素材サイトの検索回数の上限に達しました。少し待ってから再試行してください');
  if (!res.ok) throw new HttpError(502, `素材サイトの検索に失敗しました (${res.status})`);
  const j = (await res.json()) as PixabayResp & PexelsResp;
  return provider === 'pixabay' ? parsePixabay(j) : parsePexels(j);
}

/** 素材サイトの画像を取得する(許可したホストだけ・大きさの上限つき) */
export async function fetchStockImage(raw: string, signal?: AbortSignal): Promise<{ buf: Buffer; ext: string; type: string }> {
  const u = allowedImageUrl(raw);
  let res: Response;
  try {
    res = await fetch(u, { signal, redirect: 'manual' });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new HttpError(502, '素材サイトから画像を取得できませんでした');
  }
  // 転送先も素材サイトの中だけに限る
  for (let i = 0; i < 3 && res.status >= 300 && res.status < 400; i++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    res = await fetch(allowedImageUrl(new URL(loc, u).toString()), { signal, redirect: 'manual' });
  }
  if (!res.ok) throw new HttpError(502, `素材サイトから画像を取得できませんでした (${res.status})`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[type] ?? path.extname(u.pathname).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) throw new HttpError(415, '画像ではないファイルでした');
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_IMAGE_BYTES) throw new HttpError(413, '画像が大きすぎます');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, '画像が大きすぎます');
  return { buf, ext, type: type || 'image/jpeg' };
}
