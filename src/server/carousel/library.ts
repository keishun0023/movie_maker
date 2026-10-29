// 写真投稿の素材ライブラリ。1つのフォルダ(初期値はデータフォルダの中、Google ドライブの同期フォルダも可)に、
// 分類ごとのサブフォルダで画像を置き、index.json に名前・タグなどを持つ。
// フォルダに直接入れた画像も、一覧を開いたときに取り込む(Drive に一括で上げた素材をそのまま使える)。
// フォーマット(formats.json)と書き出し(書き出し/)も同じフォルダに置くので、Drive で別の Mac とも共有できる。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIBRARY_CATEGORIES, type CarouselFormat, type CarouselImage, type LibraryCategory, type LibraryItem } from '../../shared/carousel.js';
import { atomicWrite, HttpError } from '../store.js';
import { CAROUSELS_DIR_NAME, EXPORT_DIR_NAME, libraryDir } from './paths.js';
import { IMAGE_EXT, saveImage } from './store.js';

export { DEFAULT_LIBRARY_DIR, libraryDir, setLibraryDir } from './paths.js';

/** Google ドライブ(パソコン版)の同期フォルダの候補(Mac) */
export async function driveFolderCandidates(): Promise<string[]> {
  const base = path.join(os.homedir(), 'Library', 'CloudStorage');
  const out: string[] = [];
  for (const d of await fsp.readdir(base).catch(() => [] as string[])) {
    if (!d.startsWith('GoogleDrive')) continue;
    for (const sub of ['マイドライブ', 'My Drive']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

const indexFile = () => path.join(libraryDir(), 'index.json');
const formatsFile = () => path.join(libraryDir(), 'formats.json');

let chain: Promise<unknown> = Promise.resolve();
/** index.json の読み書きは順番に行う */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = chain.then(fn);
  chain = job.catch(() => undefined);
  return job;
}

async function readIndex(): Promise<LibraryItem[]> {
  try {
    const j = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as { items?: LibraryItem[] };
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

async function writeIndex(items: LibraryItem[]): Promise<void> {
  await atomicWrite(indexFile(), JSON.stringify({ items }, null, 1));
}

export function itemPath(it: Pick<LibraryItem, 'file'>): string {
  const root = libraryDir();
  const p = path.resolve(root, it.file);
  if (!p.startsWith(root + path.sep)) throw new HttpError(400, '不正なパスです');
  return p;
}

const hashOf = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

/** ファイル名から名前とタグを作る(例: 泣き顔_メガネ.png → 名前「泣き顔_メガネ」、タグ「泣き顔」「メガネ」) */
export function namesFromFile(file: string): { name: string; tags: string[] } {
  const name = path.basename(file, path.extname(file)).normalize('NFC');
  const tags = name
    .split(/[\s_\-、,()（）[\]]+/)
    .map((t) => t.trim())
    .filter((t) => t && !/^\d+$/.test(t) && !/^[0-9a-f]{6,}$/i.test(t));
  return { name, tags: [...new Set(tags)].slice(0, 10) };
}

function categoryOf(rel: string): LibraryCategory {
  const top = rel.split(/[\\/]/)[0]?.normalize('NFC') ?? '';
  return (LIBRARY_CATEGORIES as readonly string[]).includes(top) ? (top as LibraryCategory) : 'その他';
}

/** フォルダの画像を index.json と突き合わせる(新しく置かれた画像を加え、消えた画像を外す) */
export async function scanLibrary(): Promise<LibraryItem[]> {
  return serial(async () => {
    const root = libraryDir();
    await fsp.mkdir(root, { recursive: true });
    for (const c of LIBRARY_CATEGORIES) await fsp.mkdir(path.join(root, c), { recursive: true });
    const items = await readIndex();
    const known = new Set(items.map((x) => x.file.normalize('NFC')));
    const found = new Set<string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).split(path.sep).join('/').normalize('NFC');
        if (e.isDirectory()) {
          if (depth < 3 && rel !== EXPORT_DIR_NAME && rel !== CAROUSELS_DIR_NAME) await walk(abs, depth + 1);
        } else if (IMAGE_EXT.includes(path.extname(e.name).toLowerCase())) found.add(rel);
      }
    };
    await walk(root, 0);
    let changed = false;
    const kept = items.filter((x) => found.has(x.file.normalize('NFC')));
    if (kept.length !== items.length) changed = true;
    for (const rel of found) {
      if (known.has(rel)) continue;
      // Drive の同期フォルダでは、読むと中身のダウンロードが始まることがあるので、中身は読まずに大きさと日時で見分ける
      const st = await fsp.stat(path.join(root, rel)).catch(() => null);
      if (!st) continue;
      const { name, tags } = namesFromFile(rel);
      kept.push({ id: 'A' + crypto.randomBytes(6).toString('hex'), name, category: categoryOf(rel), file: rel, tags, source: 'upload', hash: `stat:${st.size}:${Math.round(st.mtimeMs)}`, addedAt: new Date().toISOString() });
      changed = true;
    }
    if (changed) await writeIndex(kept);
    return kept;
  });
}

export async function libraryItems(): Promise<LibraryItem[]> {
  return scanLibrary();
}

export async function libraryItem(id: string): Promise<LibraryItem> {
  const it = (await readIndex()).find((x) => x.id === id);
  if (!it) throw new HttpError(404, '素材が見つかりません');
  return it;
}

export interface AddMeta {
  name: string;
  category: LibraryCategory;
  tags?: string[];
  source: CarouselImage['source'];
  credit?: string;
  pageUrl?: string;
  prompt?: string;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 40) || '素材';

/** 画像をライブラリに加える(同じ内容の画像があれば、それを返す) */
export async function addToLibrary(buf: Buffer, ext: string, meta: AddMeta): Promise<LibraryItem> {
  const e = ext.toLowerCase() === '.jpeg' ? '.jpg' : ext.toLowerCase();
  if (!IMAGE_EXT.includes(e)) throw new HttpError(415, `使えない画像の形式です(${ext || '不明'})`);
  const hash = hashOf(buf);
  return serial(async () => {
    const items = await readIndex();
    const same = items.find((x) => x.hash === hash);
    if (same) return same;
    const category = (LIBRARY_CATEGORIES as readonly string[]).includes(meta.category) ? meta.category : 'その他';
    const rel = `${category}/${safeName(meta.name)}_${hash.slice(0, 8)}${e}`;
    await atomicWrite(path.join(libraryDir(), rel), buf);
    const it: LibraryItem = {
      id: 'A' + crypto.randomBytes(6).toString('hex'),
      name: meta.name.slice(0, 80) || '素材',
      category,
      file: rel,
      tags: [...new Set((meta.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 20),
      source: meta.source,
      hash,
      addedAt: new Date().toISOString(),
      ...(meta.credit ? { credit: meta.credit } : {}),
      ...(meta.pageUrl ? { pageUrl: meta.pageUrl } : {}),
      ...(meta.prompt ? { prompt: meta.prompt.slice(0, 2000) } : {}),
    };
    items.push(it);
    await writeIndex(items);
    return it;
  });
}

export async function updateLibraryItem(id: string, patch: { name?: string; tags?: string[]; category?: LibraryCategory }): Promise<LibraryItem> {
  return serial(async () => {
    const items = await readIndex();
    const it = items.find((x) => x.id === id);
    if (!it) throw new HttpError(404, '素材が見つかりません');
    if (typeof patch.name === 'string' && patch.name.trim()) it.name = patch.name.trim().slice(0, 80);
    if (Array.isArray(patch.tags)) it.tags = [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
    if (patch.category && patch.category !== it.category && (LIBRARY_CATEGORIES as readonly string[]).includes(patch.category)) {
      // 分類を変えたら、ファイルもその分類のフォルダへ移す
      const rel = `${patch.category}/${path.basename(it.file)}`;
      await fsp.mkdir(path.join(libraryDir(), patch.category), { recursive: true });
      await fsp.rename(itemPath(it), path.join(libraryDir(), rel));
      it.file = rel;
      it.category = patch.category;
    }
    await writeIndex(items);
    return it;
  });
}

export async function removeLibraryItem(id: string): Promise<void> {
  await serial(async () => {
    const items = await readIndex();
    const it = items.find((x) => x.id === id);
    if (!it) return;
    await fsp.rm(itemPath(it), { force: true });
    await writeIndex(items.filter((x) => x.id !== id));
  });
}

/** ライブラリの素材を企画に入れる(企画のフォルダにコピーする) */
export async function libraryToCarousel(carouselId: string, id: string): Promise<CarouselImage> {
  const it = await libraryItem(id);
  const buf = await fsp.readFile(itemPath(it)).catch(() => {
    throw new HttpError(404, `素材のファイルがありません(${it.file})。Drive の同期が終わっているか確認してください`);
  });
  return saveImage(carouselId, buf, path.extname(it.file), {
    source: it.source === 'upload' ? 'library' : it.source,
    libraryId: it.id,
    ...(it.credit ? { credit: it.credit } : {}),
    ...(it.pageUrl ? { pageUrl: it.pageUrl } : {}),
  });
}

/** 画像を企画に保存し、ライブラリにも登録する */
export async function saveAndRegister(carouselId: string, buf: Buffer, ext: string, meta: AddMeta): Promise<CarouselImage> {
  const item = await addToLibrary(buf, ext, meta).catch(() => null);
  return saveImage(carouselId, buf, ext, {
    source: meta.source,
    ...(item ? { libraryId: item.id } : {}),
    ...(meta.credit ? { credit: meta.credit } : {}),
    ...(meta.pageUrl ? { pageUrl: meta.pageUrl } : {}),
  });
}

// ---- フォーマット ----

export async function listFormats(): Promise<CarouselFormat[]> {
  try {
    const j = JSON.parse(await fsp.readFile(formatsFile(), 'utf8')) as { formats?: CarouselFormat[] };
    if (Array.isArray(j.formats)) return j.formats;
  } catch {
    /* はじめは見本を入れる */
  }
  return DEFAULT_FORMATS;
}

export async function saveFormats(list: CarouselFormat[]): Promise<CarouselFormat[]> {
  const clean = list.slice(0, 100).map((f) => ({ ...f, id: String(f.id || 'F' + crypto.randomBytes(4).toString('hex')), name: String(f.name || '名前なし').slice(0, 40) }));
  await fsp.mkdir(libraryDir(), { recursive: true });
  await atomicWrite(formatsFile(), JSON.stringify({ formats: clean }, null, 1));
  return clean;
}

export const DEFAULT_FORMATS: CarouselFormat[] = [
  {
    id: 'F-dobusu',
    name: 'ドブス/爆美女',
    heads: 'words',
    leftWord: 'ドブス',
    rightWord: '爆美女',
    background: 'pink-water',
    pageCount: 5,
    instructions: '左はあるあると笑えるダメな習慣、右は真似したくなる習慣。最後のページはコメントを促す問いかけにする',
    imagePolicy: 'ai-anime',
  },
  {
    id: 'F-marks',
    name: '✖/〇 比較',
    heads: 'marks',
    leftWord: '',
    rightWord: '',
    background: 'lavender',
    pageCount: 5,
    instructions: '左はやりがちなNG、右はおすすめのやり方。やさしい口調',
    imagePolicy: 'stock-photo',
  },
];

// ---- 書き出しを Drive にも置く ----

/** 書き出した画像を、ライブラリのフォルダの「書き出し/<名前>」にも置く */
export async function copyExportToLibrary(name: string, files: { name: string; data: Buffer }[]): Promise<string> {
  const dir = path.join(libraryDir(), EXPORT_DIR_NAME, safeName(name));
  for (const f of files) await atomicWrite(path.join(dir, f.name), f.data);
  return dir;
}
