// フォントの列挙と読み込み。TTF/OTF/TTC のテーブルを直接読み、
// ファミリー名・ウェイト・日本語グリフの有無・文字の収録範囲を調べる。
// ブラウザにはフォントIDで配信し(任意パスは受け付けない)、プレビューと書き出しで同じファイルを使う。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FontInfo } from '../shared/types.js';
import { BUNDLED_FONTS_DIR, FONT_CACHE_FILE } from './config.js';
import { atomicWrite } from './store.js';

interface TableRec {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

class Reader {
  constructor(private fh: fsp.FileHandle) {}
  async read(offset: number, length: number): Promise<Buffer> {
    const b = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(b, 0, length, offset);
    return b.subarray(0, bytesRead);
  }
}

async function tableDirectory(r: Reader, offset: number): Promise<TableRec[]> {
  const head = await r.read(offset, 12);
  const num = head.readUInt16BE(4);
  const dir = await r.read(offset + 12, num * 16);
  const out: TableRec[] = [];
  for (let i = 0; i < num; i++) {
    const o = i * 16;
    if (o + 16 > dir.length) break;
    out.push({ tag: dir.toString('latin1', o, o + 4), checksum: dir.readUInt32BE(o + 4), offset: dir.readUInt32BE(o + 8), length: dir.readUInt32BE(o + 12) });
  }
  return out;
}

async function faceOffsets(r: Reader): Promise<number[]> {
  const h = await r.read(0, 12);
  if (h.length < 12) throw new Error('フォントファイルが短すぎます');
  const tag = h.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const n = h.readUInt32BE(8);
    const offs = await r.read(12, n * 4);
    return Array.from({ length: n }, (_, i) => offs.readUInt32BE(i * 4));
  }
  const v = h.readUInt32BE(0);
  if (v === 0x00010000 || tag === 'OTTO' || tag === 'true') return [0];
  if (tag === 'wOFF' || tag === 'wOF2') throw new Error('WOFF形式は未対応です(TTF/OTFを使ってください)');
  throw new Error('フォントとして読み込めません');
}

function decodeName(buf: Buffer, platform: number, encoding: number): string | null {
  if (platform === 3 || platform === 0) {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  if (platform === 1 && encoding === 0) return buf.toString('latin1');
  return null;
}

interface ParsedFace {
  family: string;
  familyJa?: string;
  subfamily: string;
  fullName: string;
  weight: number;
  variable: boolean;
  weightRange?: [number, number];
  ranges: [number, number][];
}

async function parseFace(r: Reader, offset: number): Promise<ParsedFace> {
  const tables = await tableDirectory(r, offset);
  const t = (tag: string) => tables.find((x) => x.tag === tag);
  const nameT = t('name');
  if (!nameT) throw new Error('name テーブルがありません');
  const nb = await r.read(nameT.offset, nameT.length);
  const count = nb.readUInt16BE(2);
  const strOff = nb.readUInt16BE(4);
  const names: Record<number, { en?: string; ja?: string; any?: string }> = {};
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    if (o + 12 > nb.length) break;
    const platform = nb.readUInt16BE(o);
    const enc = nb.readUInt16BE(o + 2);
    const lang = nb.readUInt16BE(o + 4);
    const id = nb.readUInt16BE(o + 6);
    const len = nb.readUInt16BE(o + 8);
    const off = nb.readUInt16BE(o + 10);
    if (![1, 2, 4, 16, 17].includes(id)) continue;
    const s = decodeName(nb.subarray(strOff + off, strOff + off + len), platform, enc);
    if (!s) continue;
    const e = (names[id] ??= {});
    if (platform === 3 && lang === 0x0411) e.ja = s;
    else if ((platform === 3 && lang === 0x0409) || (platform === 1 && lang === 0)) e.en ??= s;
    e.any ??= s;
  }
  const pick = (id: number) => names[id]?.en ?? names[id]?.any;
  const family = pick(16) ?? pick(1) ?? 'Unknown';
  const familyJa = names[16]?.ja ?? names[1]?.ja;
  const subfamily = pick(17) ?? pick(2) ?? 'Regular';
  const fullName = pick(4) ?? `${family} ${subfamily}`;

  let weight = 400;
  const os2 = t('OS/2');
  if (os2) {
    const b = await r.read(os2.offset, 8);
    if (b.length >= 6) weight = b.readUInt16BE(4);
  }
  let variable = false;
  let weightRange: [number, number] | undefined;
  const fvar = t('fvar');
  if (fvar) {
    const b = await r.read(fvar.offset, Math.min(fvar.length, 4096));
    const axesOff = b.readUInt16BE(4);
    const axisCount = b.readUInt16BE(8);
    const axisSize = b.readUInt16BE(10);
    for (let i = 0; i < axisCount; i++) {
      const o = axesOff + i * axisSize;
      if (o + 20 > b.length) break;
      if (b.toString('latin1', o, o + 4) === 'wght') {
        variable = true;
        weightRange = [Math.round(b.readInt32BE(o + 4) / 65536), Math.round(b.readInt32BE(o + 12) / 65536)];
      }
    }
  }
  const ranges = await parseCmap(r, t('cmap'));
  const face: ParsedFace = { family, subfamily, fullName, weight, variable, ranges };
  if (familyJa && familyJa !== family) face.familyJa = familyJa;
  if (weightRange) face.weightRange = weightRange;
  return face;
}

async function parseCmap(r: Reader, cmap: TableRec | undefined): Promise<[number, number][]> {
  if (!cmap) return [];
  const b = await r.read(cmap.offset, cmap.length);
  const n = b.readUInt16BE(2);
  let best: { off: number; fmt: number; score: number } | null = null;
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 8;
    const pid = b.readUInt16BE(o);
    const eid = b.readUInt16BE(o + 2);
    const off = b.readUInt32BE(o + 4);
    if (off + 2 > b.length) continue;
    const fmt = b.readUInt16BE(off);
    let score = 0;
    if (fmt === 12 && (pid === 3 || pid === 0)) score = 3;
    else if (fmt === 4 && ((pid === 3 && eid === 1) || pid === 0)) score = 2;
    if (score && (!best || score > best.score)) best = { off, fmt, score };
  }
  if (!best) return [];
  const ranges: [number, number][] = [];
  const o = best.off;
  if (best.fmt === 12) {
    const groups = b.readUInt32BE(o + 12);
    for (let i = 0; i < groups; i++) {
      const g = o + 16 + i * 12;
      if (g + 12 > b.length) break;
      ranges.push([b.readUInt32BE(g), b.readUInt32BE(g + 4)]);
    }
  } else {
    const segX2 = b.readUInt16BE(o + 6);
    const seg = segX2 / 2;
    const endBase = o + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let i = 0; i < seg; i++) {
      const end = b.readUInt16BE(endBase + i * 2);
      const start = b.readUInt16BE(startBase + i * 2);
      const delta = b.readInt16BE(deltaBase + i * 2);
      const ro = b.readUInt16BE(rangeBase + i * 2);
      if (start === 0xffff) continue;
      if (ro === 0) {
        ranges.push([start, end]);
        void delta;
        continue;
      }
      // idRangeOffset がある場合はグリフ0(未収録)を除外する
      let runStart = -1;
      for (let c = start; c <= end; c++) {
        const addr = rangeBase + i * 2 + ro + (c - start) * 2;
        const gid = addr + 2 <= b.length ? b.readUInt16BE(addr) : 0;
        if (gid !== 0 && runStart < 0) runStart = c;
        if ((gid === 0 || c === end) && runStart >= 0) {
          ranges.push([runStart, gid === 0 ? c - 1 : c]);
          runStart = -1;
        }
      }
    }
  }
  ranges.sort((a, c) => a[0] - c[0]);
  const merged: [number, number][] = [];
  for (const rg of ranges) {
    const last = merged[merged.length - 1];
    if (last && rg[0] <= last[1] + 1) last[1] = Math.max(last[1], rg[1]);
    else merged.push([rg[0], rg[1]]);
  }
  return merged;
}

export function covers(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const r = ranges[m]!;
    if (cp < r[0]) hi = m - 1;
    else if (cp > r[1]) lo = m + 1;
    else return true;
  }
  return false;
}

// ---- レジストリ ----

interface FontEntry {
  info: FontInfo;
  file: string;
  faceOffset: number;
  isCollection: boolean;
  ranges: [number, number][];
}

const registry = new Map<string, FontEntry>();
let scanned = false;
let scanning: Promise<void> | null = null;

type CacheRec = { mtime: number; size: number; faces: (ParsedFace & { offset: number; collection: boolean })[] | { error: string } };
let diskCache: Record<string, CacheRec> = {};

async function parseFile(file: string): Promise<CacheRec> {
  const st = await fsp.stat(file);
  const hit = diskCache[file];
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
  let rec: CacheRec;
  const fh = await fsp.open(file, 'r');
  try {
    const r = new Reader(fh);
    const offs = await faceOffsets(r);
    const faces = [];
    for (const off of offs) faces.push({ ...(await parseFace(r, off)), offset: off, collection: offs.length > 1 || off !== 0 });
    rec = { mtime: st.mtimeMs, size: st.size, faces };
  } catch (e) {
    rec = { mtime: st.mtimeMs, size: st.size, faces: { error: e instanceof Error ? e.message : String(e) } };
  } finally {
    await fh.close();
  }
  diskCache[file] = rec;
  return rec;
}

function makeId(source: FontInfo['source'], file: string, idx: number): string {
  if (source === 'bundled') return `bundled:${path.basename(file)}${idx ? '#' + idx : ''}`;
  return `${source}:${crypto.createHash('sha1').update(file).digest('hex').slice(0, 12)}-${idx}`;
}

async function addFile(file: string, source: FontInfo['source'], license?: string): Promise<string[]> {
  const rec = await parseFile(file);
  const ids: string[] = [];
  if ('error' in rec.faces) {
    const id = makeId(source, file, 0);
    registry.set(id, {
      info: { id, family: path.basename(file), subfamily: '', fullName: path.basename(file), weight: 400, variable: false, hasJapanese: false, source, status: 'error', error: rec.faces.error },
      file, faceOffset: 0, isCollection: false, ranges: [],
    });
    return [id];
  }
  rec.faces.forEach((f, idx) => {
    const id = makeId(source, file, idx);
    const hasJapanese = covers(f.ranges, 0x3042) && covers(f.ranges, 0x30a2) && covers(f.ranges, 0x6f22);
    const info: FontInfo = { id, family: f.family, subfamily: f.subfamily, fullName: f.fullName, weight: f.weight, variable: f.variable, hasJapanese, source, status: 'ok' };
    if (f.familyJa) info.familyJa = f.familyJa;
    if (f.weightRange) info.weightRange = f.weightRange;
    if (license) info.license = license;
    registry.set(id, { info, file, faceOffset: f.offset, isCollection: f.collection, ranges: f.ranges });
    ids.push(id);
  });
  return ids;
}

function systemFontDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(home, 'Library/Fonts')];
  }
  if (process.platform === 'win32') return ['C:\\Windows\\Fonts'];
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local/share/fonts'), path.join(home, '.fonts')];
}

async function walk(dir: string, depth: number, out: string[]) {
  let ents: fs.Dirent[];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out);
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(p);
  }
}

export async function scanFonts(force = false): Promise<void> {
  if (scanned && !force) return;
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      diskCache = JSON.parse(await fsp.readFile(FONT_CACHE_FILE, 'utf8'));
    } catch {
      diskCache = {};
    }
    for (const [k, v] of [...registry]) if (v.info.source !== 'project') registry.delete(k);
    const bundled: string[] = [];
    await walk(BUNDLED_FONTS_DIR, 0, bundled);
    for (const f of bundled) await addFile(f, 'bundled', 'SIL Open Font License 1.1');
    const sys: string[] = [];
    for (const d of systemFontDirs()) await walk(d, 3, sys);
    for (const f of [...new Set(sys)]) {
      try {
        await addFile(f, 'system');
      } catch {
        /* 読めないファイルは飛ばす */
      }
    }
    await atomicWrite(FONT_CACHE_FILE, JSON.stringify(diskCache)).catch(() => undefined);
    scanned = true;
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

/** プロジェクトに追加したフォントを登録する */
export async function registerProjectFont(file: string): Promise<FontInfo[]> {
  const ids = await addFile(file, 'project');
  return ids.map((id) => registry.get(id)!.info);
}

export async function listFonts(): Promise<FontInfo[]> {
  await scanFonts();
  return [...registry.values()]
    .map((e) => e.info)
    .sort((a, b) => {
      const src = { bundled: 0, project: 1, system: 2 } as const;
      if (a.hasJapanese !== b.hasJapanese) return a.hasJapanese ? -1 : 1;
      if (a.source !== b.source) return src[a.source] - src[b.source];
      return (a.familyJa ?? a.family).localeCompare(b.familyJa ?? b.family) || a.weight - b.weight;
    });
}

export function fontEntry(id: string): FontEntry | null {
  return registry.get(id) ?? null;
}

/** 文字列のうちフォントに無い文字 */
export function missingChars(id: string, text: string): string[] {
  const e = registry.get(id);
  if (!e) return [];
  const miss = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || ch === '\n' || ch === ' ' || ch === '　') continue;
    if (!covers(e.ranges, cp)) miss.add(ch);
  }
  return [...miss];
}

/** 配信用のフォントバイト列。TTC は該当フェイスだけを単体のフォントとして切り出す */
export async function fontBytes(id: string): Promise<Buffer> {
  const e = registry.get(id);
  if (!e || e.info.status !== 'ok') throw new Error('フォントが見つかりません');
  const buf = await fsp.readFile(e.file);
  if (!e.isCollection) return buf;
  return extractFace(buf, e.faceOffset);
}

function extractFace(buf: Buffer, offset: number): Buffer {
  const sfntVersion = buf.readUInt32BE(offset);
  const num = buf.readUInt16BE(offset + 4);
  const recs: TableRec[] = [];
  for (let i = 0; i < num; i++) {
    const o = offset + 12 + i * 16;
    recs.push({ tag: buf.toString('latin1', o, o + 4), checksum: buf.readUInt32BE(o + 4), offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) });
  }
  const headerLen = 12 + num * 16;
  let cursor = headerLen;
  const placed = recs.map((r) => {
    const at = cursor;
    cursor += r.length + ((4 - (r.length % 4)) % 4);
    return { ...r, newOffset: at };
  });
  const out = Buffer.alloc(cursor);
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(num, 4);
  let es = 0;
  while (1 << (es + 1) <= num) es++;
  out.writeUInt16BE((1 << es) * 16, 6);
  out.writeUInt16BE(es, 8);
  out.writeUInt16BE(num * 16 - (1 << es) * 16, 10);
  placed.forEach((r, i) => {
    const o = 12 + i * 16;
    out.write(r.tag, o, 'latin1');
    out.writeUInt32BE(r.checksum, o + 4);
    out.writeUInt32BE(r.newOffset, o + 8);
    out.writeUInt32BE(r.length, o + 12);
    buf.copy(out, r.newOffset, r.offset, r.offset + r.length);
  });
  return out;
}
