// 素材ライブラリ: 一度取り込んだ素材を、どのプロジェクトからも使えるようにする。
// - 取り込んだファイルはライブラリに1つだけ保存する(同じ内容のファイルは2回保存しない)
// - CapCut の素材やフォルダの素材は、コピーせず元の場所のまま使う
// - プロジェクトや CapCut の下書きは、ライブラリのファイルをそのまま参照する(コピーしない)
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Asset } from '../shared/types.js';
import { DATA_DIR } from './config.js';
import { normalizeImage, saveUploadTo } from './assets.js';
import { allowedExt, AUDIO_EXT, describeMedia, FONT_EXT, IMAGE_EXT, makePreviewFiles, probe, type PreviewTargets } from './media.js';
import { allowExternalFiles, atomicWrite, HttpError } from './store.js';

export const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const FILES_DIR = path.join(LIBRARY_DIR, 'files');
const CACHE_DIR = path.join(LIBRARY_DIR, 'cache');
const INDEX_FILE = path.join(LIBRARY_DIR, 'index.json');

let items: Asset[] = loadIndex();

function loadIndex(): Asset[] {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as { assets?: Asset[] };
    const list = Array.isArray(j.assets) ? j.assets : [];
    for (const a of list) allowExternalFiles([a.file, a.proxy, a.thumb]);
    return list;
  } catch {
    return [];
  }
}

async function saveIndex(): Promise<void> {
  await atomicWrite(INDEX_FILE, JSON.stringify({ assets: items }, null, 1));
}

export function libraryItems(): Asset[] {
  return items;
}

export function libraryAsset(id: string): Asset | undefined {
  return items.find((a) => a.id === id);
}

const targetsFor = (id: string): PreviewTargets => ({
  thumb: path.join(CACHE_DIR, `thumb-${id}.jpg`),
  proxy: (ext = '.mp4') => path.join(CACHE_DIR, `proxy-${id}${ext}`),
});

/** ファイルの情報を調べて、ライブラリの素材を作る(プレビューが必要かも返す) */
async function describe(id: string, name: string, file: string, size: number, hash: string, linked: boolean): Promise<{ asset: Asset; needsPreview: boolean }> {
  const ext = path.extname(file).toLowerCase();
  const base: Asset = { id, kind: 'audio', name, file, size, hash, importedAt: new Date().toISOString(), status: 'ok', warnings: [], library: true, ...(linked ? { linked: true } : {}) };
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  allowExternalFiles([file]);
  try {
    const info = describeMedia(await probe(file), ext);
    const asset: Asset = { ...base, ...info, warnings: [...info.warnings], library: true };
    const t = targetsFor(id);
    if (asset.kind === 'image' || IMAGE_EXT.includes(ext)) {
      asset.kind = 'image';
      delete asset.durationSec;
      delete asset.audioStreams;
      await normalizeImage('library', asset, file, t);
      allowExternalFiles([asset.proxy, asset.thumb]);
      return { asset, needsPreview: false };
    }
    if (asset.kind === 'video') {
      asset.thumb = t.thumb;
      asset.proxy = t.proxy();
      allowExternalFiles([asset.thumb, asset.proxy]);
    }
    return { asset, needsPreview: asset.kind === 'video' };
  } catch (e) {
    return { asset: { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }, needsPreview: false };
  }
}

async function add(asset: Asset): Promise<void> {
  items = [asset, ...items.filter((a) => a.id !== asset.id)];
  await saveIndex();
}

/** プレビュー(軽い動画・サムネイル)を作る */
export async function buildLibraryPreview(asset: Asset, signal: AbortSignal, progress: (p: number, m?: string) => void): Promise<void> {
  progress(0.01, `${asset.name} のプレビューを作成中`);
  await makePreviewFiles('library', asset, signal, (p) => progress(p, `${asset.name} のプレビューを作成中`), targetsFor(asset.id));
}

/** ブラウザから受け取ったファイルをライブラリに保存する(同じ内容のファイルがあれば、それを使う) */
export async function uploadToLibrary(req: IncomingMessage): Promise<{ asset: Asset; needsPreview: boolean; existing: boolean }> {
  const rawName = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
  const name = path.basename(rawName).slice(0, 200) || 'file';
  const ext = allowedExt(name);
  if (!ext || FONT_EXT.includes(ext)) throw new HttpError(415, `素材ライブラリに入れられない形式です: ${name}(音声・動画・画像に対応)`);
  const id = 'L' + crypto.randomBytes(6).toString('hex');
  const dest = path.join(FILES_DIR, `${id}${ext}`);
  const { size, hash } = await saveUploadTo(req, dest);
  if (size === 0) {
    await fsp.rm(dest, { force: true });
    throw new HttpError(400, '空のファイルです');
  }
  const same = items.find((a) => a.hash === hash && a.size === size && a.status === 'ok' && fs.existsSync(a.file));
  if (same) {
    await fsp.rm(dest, { force: true });
    return { asset: same, needsPreview: false, existing: true };
  }
  const r = await describe(id, name, dest, size, hash, false);
  await add(r.asset);
  return { ...r, existing: false };
}

/** 元の場所のファイルを、コピーせずにライブラリに加える */
export async function linkToLibrary(files: string[]): Promise<{ asset: Asset; needsPreview: boolean; existing: boolean }[]> {
  const out: { asset: Asset; needsPreview: boolean; existing: boolean }[] = [];
  for (const f of files) {
    const file = path.resolve(f);
    const ext = path.extname(file).toLowerCase();
    if (!allowedExt(file) || FONT_EXT.includes(ext)) continue;
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    const same = items.find((a) => a.file === file);
    if (same) {
      out.push({ asset: same, needsPreview: false, existing: true });
      continue;
    }
    // 中身の同一判定は、先頭と大きさで簡易に行う(大きな動画を全部読まない)
    const fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(Math.min(st.size, 1024 * 1024));
    await fh.read(head, 0, head.length, 0);
    await fh.close();
    const hash = 'h' + crypto.createHash('sha1').update(head).update(String(st.size)).digest('hex');
    const dup = items.find((a) => a.hash === hash && a.size === st.size && a.status === 'ok' && fs.existsSync(a.file));
    if (dup) {
      out.push({ asset: dup, needsPreview: false, existing: true });
      continue;
    }
    const id = 'L' + crypto.randomBytes(6).toString('hex');
    const r = await describe(id, path.basename(file), file, st.size, hash, true);
    await add(r.asset);
    out.push({ ...r, existing: false });
  }
  return out;
}

/** フォルダの中の素材ファイル(2階層まで) */
export async function mediaFilesIn(dir: string, depth = 2): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, left: number) => {
    let ents: fs.Dirent[] = [];
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) await walk(p, left - 1);
      else if (e.isFile() && allowedExt(e.name) && !FONT_EXT.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  await walk(dir, depth);
  return out.slice(0, 2000);
}

/** ライブラリから消す(取り込んでコピーしたファイルとプレビューは消す。元の場所のファイルは消さない) */
export async function removeFromLibrary(id: string): Promise<void> {
  const a = libraryAsset(id);
  if (!a) return;
  items = items.filter((x) => x.id !== id);
  await saveIndex();
  const del = [a.proxy, a.thumb, ...(a.linked ? [] : [a.file])].filter((f): f is string => !!f && f.startsWith(LIBRARY_DIR + path.sep));
  for (const f of del) await fsp.rm(f, { force: true }).catch(() => undefined);
  allowExternalFiles([a.file, a.proxy, a.thumb], false);
}

export const isAudioFile = (f: string) => AUDIO_EXT.includes(path.extname(f).toLowerCase());

/**
 * プロジェクトにコピーしてある素材を、ライブラリに移す(容量を減らす)。
 * 同じ内容の素材がライブラリにあれば、プロジェクトのコピーを消してそれを使う。
 * 戻り値は「元の素材ID → ライブラリの素材」。
 */
export async function moveProjectAssetsToLibrary(projectId: string, assets: Asset[], resolve: (rel: string) => string): Promise<{ map: Record<string, Asset>; freedBytes: number }> {
  const map: Record<string, Asset> = {};
  let freed = 0;
  for (const a of assets) {
    if (a.library || a.status !== 'ok' || (a.kind !== 'video' && a.kind !== 'image' && a.kind !== 'audio')) continue;
    let src: string;
    try {
      src = resolve(a.file);
    } catch {
      continue;
    }
    if (!fs.existsSync(src)) continue;
    const same = items.find((x) => x.hash === a.hash && x.size === a.size && x.status === 'ok' && fs.existsSync(x.file));
    const projFiles = [a.proxy, a.thumb].map((r) => {
      try {
        return r ? resolve(r) : null;
      } catch {
        return null;
      }
    });
    if (same) {
      map[a.id] = same;
      for (const f of [src, ...projFiles]) if (f && fs.existsSync(f)) {
        freed += fs.statSync(f).size;
        await fsp.rm(f, { force: true });
      }
      continue;
    }
    const id = 'L' + crypto.randomBytes(6).toString('hex');
    const dest = path.join(FILES_DIR, `${id}${path.extname(src).toLowerCase()}`);
    await fsp.mkdir(FILES_DIR, { recursive: true });
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.rename(src, dest).catch(async () => {
      await fsp.copyFile(src, dest);
      await fsp.rm(src, { force: true });
    });
    const t = targetsFor(id);
    const moved: Asset = { ...a, id, file: dest, library: true };
    delete moved.linked;
    const [proxy, thumb] = projFiles;
    if (proxy && fs.existsSync(proxy)) {
      const to = t.proxy(path.extname(proxy));
      await fsp.rename(proxy, to);
      moved.proxy = to;
    } else delete moved.proxy;
    if (thumb && fs.existsSync(thumb)) {
      await fsp.rename(thumb, t.thumb);
      moved.thumb = t.thumb;
    } else delete moved.thumb;
    allowExternalFiles([moved.file, moved.proxy, moved.thumb]);
    items = [moved, ...items];
    map[a.id] = moved;
  }
  await saveIndex();
  void projectId;
  return { map, freedBytes: freed };
}
