// 写真投稿メーカーのローカルAPIの呼び出し。
import type { Carousel, CarouselFormat, CarouselImage, ImageQuery, LibraryCategory, LibraryItem } from '../shared/carousel.js';
import type { JobInfo } from '../shared/types.js';
import { call } from './api.js';

export type KeySource = 'env' | 'file' | null;
export type Provider = 'pixabay' | 'pexels';

export interface Settings {
  anthropicKeySource: KeySource;
  geminiKeySource: KeySource;
  pixabayKeySource: KeySource;
  pexelsKeySource: KeySource;
}

export interface StockHit {
  provider: Provider;
  id: string;
  thumb: string;
  full: string;
  width: number;
  height: number;
  credit: string;
  pageUrl: string;
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
  cover?: CarouselImage;
  updatedAt: string;
}

export interface LibraryInfo {
  dir: string;
  defaultDir: string;
  driveCandidates: string[];
  items: LibraryItem[];
}

export interface AiRequest {
  subject: string;
  style: 'anime' | 'photo';
  transparent: boolean;
  aspectRatio: '3:4' | '9:16' | '1:1' | '4:3';
  name?: string;
  category?: LibraryCategory;
  tags?: string[];
}

export type FilledImage = { pageId: string; slot: 'cover' | 'left' | 'right'; image: CarouselImage };

const uploadHeaders = (file: File, extra: Record<string, string> = {}) => ({ 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream', ...extra });

export const capi = {
  list: () => call<CarouselSummary[]>('GET', '/api/carousels'),
  create: (body: { name: string; theme?: string; formatId?: string }) => call<Carousel>('POST', '/api/carousels', body),
  get: (id: string) => call<Carousel>('GET', `/api/carousels/${id}`),
  save: (c: Carousel) => call<{ updatedAt: string }>('PUT', `/api/carousels/${c.id}`, c),
  remove: (id: string) => call<{ ok: boolean }>('DELETE', `/api/carousels/${id}`, {}),
  generate: (c: Carousel) => call<JobInfo>('POST', `/api/carousels/${c.id}/generate`, { carousel: c }),
  fillImages: (c: Carousel) => call<JobInfo>('POST', `/api/carousels/${c.id}/fill-images`, { carousel: c }),
  applyFormat: (c: Carousel, formatId: string) => call<Carousel>('POST', `/api/carousels/${c.id}/apply-format`, { carousel: c, formatId }),
  upload: (id: string, file: File) => call<CarouselImage>('POST', `/api/carousels/${id}/images`, undefined, file, uploadHeaders(file)),
  pickStock: (id: string, hit: StockHit, tags: string[]) => call<CarouselImage>('POST', `/api/carousels/${id}/stock`, { ...hit, tags }),
  fromLibrary: (id: string, itemId: string) => call<CarouselImage>('POST', `/api/carousels/${id}/from-library`, { itemId }),
  aiImage: (id: string, req: AiRequest) => call<CarouselImage>('POST', `/api/carousels/${id}/ai-image`, req),
  search: (provider: Provider, q: ImageQuery) => call<StockHit[]>('GET', `/api/stock/search?provider=${provider}&kind=${q.kind}&q=${encodeURIComponent(q.q)}`),
  export: (id: string, pngs: string[]) => call<{ zip: string; files: string[]; libraryPath: string | null }>('POST', `/api/carousels/${id}/export`, { pngs }),
  reveal: (id: string) => call<{ path: string }>('POST', `/api/carousels/${id}/reveal`, {}),
  settings: () => call<Settings>('GET', '/api/settings'),
  setAnthropicKey: (key: string | null) => call<unknown>('PUT', '/api/settings/anthropic-key', { key }),
  setGeminiKey: (key: string | null) => call<unknown>('PUT', '/api/settings/gemini-key', { key }),
  setStockKey: (provider: Provider, key: string | null) => call<unknown>('PUT', '/api/settings/stock-key', { provider, key }),
  library: () => call<LibraryInfo>('GET', '/api/carousel-library'),
  libraryUpload: (file: File, category: LibraryCategory, tags = '') =>
    call<LibraryItem>('POST', '/api/carousel-library', undefined, file, uploadHeaders(file, { 'x-category': encodeURIComponent(category), 'x-tags': encodeURIComponent(tags) })),
  libraryAi: (req: AiRequest) => call<LibraryItem>('POST', '/api/carousel-library/ai', req),
  libraryUpdate: (id: string, patch: { name?: string; tags?: string[]; category?: LibraryCategory }) => call<LibraryItem>('PUT', `/api/carousel-library/${id}`, patch),
  libraryRemove: (id: string) => call<{ ok: boolean }>('DELETE', `/api/carousel-library/${id}`, {}),
  setLibraryDir: (dir: string | null) => call<{ dir: string }>('PUT', '/api/carousel-library-dir', { dir }),
  pickLibraryDir: () => call<{ dir: string; canceled?: boolean }>('POST', '/api/carousel-library-dir/pick', {}),
  revealLibrary: () => call<{ path: string }>('POST', '/api/carousel-library-dir/reveal', {}),
  formats: () => call<CarouselFormat[]>('GET', '/api/carousel-formats'),
  saveFormats: (list: CarouselFormat[]) => call<CarouselFormat[]>('PUT', '/api/carousel-formats', list),
};

export const libraryUrl = (id: string) => `/api/carousel-library/${encodeURIComponent(id)}/file`;
