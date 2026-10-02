// 素材の取り込み。元ファイルは上書きせず、プロジェクト内へコピーして扱う。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Asset } from '../shared/types.js';
import { registerProjectFont } from './fonts.js';
import { allowedExt, describeMedia, FONT_EXT, IMAGE_EXT, makePreviewFiles, probe, proxyPath, thumbPath } from './media.js';
import { requireTool, runOk } from './proc.js';
import { HttpError, sub } from './store.js';

/** JPEG の EXIF Orientation (1〜8)。無ければ 1 */
export async function jpegOrientation(file: string): Promise<number> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.readUInt16BE(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 < b.length) {
      const marker = b.readUInt16BE(off);
      const len = b.readUInt16BE(off + 2);
      if (marker === 0xffe1 && b.toString('ascii', off + 4, off + 10) === 'Exif\0\0') {
        const t = off + 10;
        const le = b.toString('ascii', t, t + 2) === 'II';
        const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > b.length) break;
          if (u16(e) === 0x0112) return u16(e + 8);
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + len;
    }
    return 1;
  } catch {
    return 1;
  } finally {
    await fh.close();
  }
}

const ORIENT_FILTER: Record<number, string> = {
  2: 'hflip',
  3: 'hflip,vflip',
  4: 'vflip',
  5: 'transpose=0',
  6: 'transpose=1',
  7: 'transpose=3',
  8: 'transpose=2',
};

/**
 * 画像を向きをそろえた PNG に変換する(プレビューと書き出しで同じ画素を使うため)。
 * FFmpeg が EXIF の向きを自動適用しない場合に備え、JPEG の向きは自前で適用する。
 */
async function normalizeImage(projectId: string, asset: Asset, src: string): Promise<void> {
  const ffmpeg = requireTool('ffmpeg');
  const out = proxyPath(projectId, asset.id, '.png');
  const ext = path.extname(src).toLowerCase();
  const orient = ext === '.jpg' || ext === '.jpeg' ? await jpegOrientation(src) : 1;
  const filters: string[] = [];
  const pr0 = await probe(src);
  const v0 = pr0.streams.find((s) => s.codec_type === 'video');
  const rawW = v0?.width ?? 0;
  const rawH = v0?.height ?? 0;
  if (ORIENT_FILTER[orient]) filters.push(ORIENT_FILTER[orient]!);
  // 大きすぎる画像は長辺 4096px までに縮める
  filters.push("scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease");
  filters.push('format=rgba');
  await runOk(ffmpeg, ['-y', '-v', 'error', '-noautorotate', '-i', src, '-frames:v', '1', '-vf', filters.join(','), out]);
  const pr = await probe(out);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('画像の大きさを取得できませんでした');
  asset.width = v.width;
  asset.height = v.height;
  asset.proxy = path.relative(sub(projectId), out);
  if (orient > 1 && rawW && rawH) asset.warnings.push('写真の向き情報(EXIF)を適用しました。');
  await runOk(ffmpeg, ['-y', '-v', 'error', '-i', out, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumbPath(projectId, asset.id)]);
  asset.thumb = path.relative(sub(projectId), thumbPath(projectId, asset.id));
}

/** アップロードされたファイルを保存して素材情報を作る */
export async function importUpload(projectId: string, req: IncomingMessage): Promise<{ asset: Asset; needsPreview: boolean }> {
  const rawName = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
  const name = path.basename(rawName).slice(0, 200) || 'file';
  const ext = allowedExt(name);
  if (!ext) throw new HttpError(415, `対応していない形式です: ${name}(音声 MP3/WAV/M4A、動画 MP4/MOV、画像、フォント TTF/OTF に対応)`);
  const id = 'a' + crypto.randomBytes(6).toString('hex');
  const rel = path.join('assets', `${id}${ext}`);
  const dest = sub(projectId, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha1');
  let size = 0;
  const tmp = dest + '.part';
  const limit = 16 * 1024 ** 3;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > limit) return cb(new HttpError(413, 'ファイルが大きすぎます'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  await fsp.rename(tmp, dest);
  const base: Asset = {
    id,
    kind: 'audio',
    name,
    file: rel,
    size,
    hash: hash.digest('hex'),
    importedAt: new Date().toISOString(),
    status: 'ok',
    warnings: [],
  };
  if (size === 0) {
    await fsp.rm(dest, { force: true });
    return { asset: { ...base, status: 'error', error: '空のファイルです。' }, needsPreview: false };
  }
  if (FONT_EXT.includes(ext)) {
    const infos = await registerProjectFont(dest);
    const ok = infos.filter((f) => f.status === 'ok');
    const asset: Asset = { ...base, kind: 'font', fontIds: infos.map((f) => f.id) };
    if (ok.length === 0) {
      asset.status = 'error';
      asset.error = infos[0]?.error ?? 'フォントを読み込めませんでした';
    } else if (!ok.some((f) => f.hasJapanese)) {
      asset.warnings.push('このフォントには日本語の文字が含まれていません。日本語テロップには使えません。');
    }
    return { asset, needsPreview: false };
  }
  try {
    const pr = await probe(dest);
    const info = describeMedia(pr, ext);
    const asset: Asset = { ...base, ...info, warnings: [...info.warnings] };
    if (asset.kind === 'image' || IMAGE_EXT.includes(ext)) {
      asset.kind = 'image';
      delete asset.durationSec;
      delete asset.audioStreams;
      await normalizeImage(projectId, asset, dest);
      return { asset, needsPreview: false };
    }
    if (asset.kind === 'video') {
      asset.thumb = path.relative(sub(projectId), thumbPath(projectId, id));
      asset.proxy = path.relative(sub(projectId), proxyPath(projectId, id));
    }
    return { asset, needsPreview: asset.kind === 'video' };
  } catch (e) {
    return {
      asset: { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) },
      needsPreview: false,
    };
  }
}

export async function buildPreview(projectId: string, asset: Asset, signal: AbortSignal, progress: (p: number, m?: string) => void) {
  progress(0.01, `${asset.name} のプレビューを作成中`);
  await makePreviewFiles(projectId, asset, signal, (p) => progress(p, `${asset.name} のプレビューを作成中`));
}

export async function removeAssetFiles(projectId: string, asset: Asset): Promise<void> {
  for (const rel of [asset.file, asset.proxy, asset.thumb]) {
    if (!rel) continue;
    await fsp.rm(sub(projectId, rel), { force: true }).catch(() => undefined);
  }
}

/** サーバー側で作ったファイル(CapCut から読み込んだ音声など)を素材として取り込む。元のファイルは移動する */
export async function adoptLocalFile(projectId: string, srcFile: string, name: string): Promise<Asset> {
  const ext = path.extname(name).toLowerCase() || path.extname(srcFile).toLowerCase();
  const id = 'a' + crypto.randomBytes(6).toString('hex');
  const rel = path.join('assets', `${id}${ext}`);
  const dest = sub(projectId, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(srcFile, dest);
  await fsp.rm(srcFile, { force: true }).catch(() => undefined);
  const buf = await fsp.readFile(dest);
  const base: Asset = {
    id,
    kind: 'audio',
    name,
    file: rel,
    size: buf.length,
    hash: crypto.createHash('sha1').update(buf).digest('hex'),
    importedAt: new Date().toISOString(),
    status: 'ok',
    warnings: [],
  };
  const info = describeMedia(await probe(dest), ext);
  return { ...base, ...info, warnings: [...info.warnings] };
}
