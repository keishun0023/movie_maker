// 写真投稿の保存先。素材ライブラリ・フォーマット・企画・書き出しを、1つのフォルダ(素材ライブラリのフォルダ)にまとめる。
// このフォルダを Google ドライブ(パソコン版)の同期フォルダにすれば、全部が Drive に入り、
// ストリーミングの設定なら Mac には中身を残さずに済む。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { atomicWrite, HttpError } from '../store.js';

const SETTINGS_FILE = path.join(DATA_DIR, 'carousel-settings.json');
export const DEFAULT_LIBRARY_DIR = path.join(DATA_DIR, '写真投稿素材');
/** 前の版で企画を置いていたフォルダ */
const OLD_CAROUSELS_DIR = path.join(DATA_DIR, 'carousels');
export const CAROUSELS_DIR_NAME = '企画';
export const EXPORT_DIR_NAME = '書き出し';

interface Settings {
  libraryDir?: string;
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export function libraryDir(): string {
  return readSettings().libraryDir || DEFAULT_LIBRARY_DIR;
}

let migrated = false;

/** 企画を置くフォルダ(素材ライブラリのフォルダの「企画」) */
export function carouselsRoot(): string {
  const root = path.join(libraryDir(), CAROUSELS_DIR_NAME);
  if (!migrated) {
    migrated = true;
    // 前の版のデータフォルダにある企画を移す
    if (fs.existsSync(OLD_CAROUSELS_DIR)) {
      try {
        moveMergeSync(OLD_CAROUSELS_DIR, root);
      } catch (e) {
        console.error('写真投稿の企画を移せませんでした:', e);
      }
    }
  }
  return root;
}

/**
 * 保存先を変える。moveExisting なら、今のフォルダの中身(素材・フォーマット・企画・書き出し)を新しいフォルダへ移す。
 * 新しいフォルダに同じ名前のものがあれば、そちらを残す(素材の一覧 index.json はまとめる)。
 */
export async function setLibraryDir(dir: string | null, moveExisting = true): Promise<string> {
  const before = libraryDir();
  const s = readSettings();
  if (dir) {
    const abs = path.resolve(dir);
    // 親のフォルダがあれば、そこに作る(Drive の中に「写真投稿素材」を作るときなど)
    if (!fs.existsSync(path.dirname(abs))) throw new HttpError(400, `フォルダが見つかりません: ${path.dirname(abs)}`);
    if (abs === before) return before;
    if (abs.startsWith(before + path.sep)) throw new HttpError(400, '今のフォルダの中は選べません');
    await fsp.mkdir(abs, { recursive: true });
    s.libraryDir = abs;
  } else delete s.libraryDir;
  const after = s.libraryDir || DEFAULT_LIBRARY_DIR;
  if (moveExisting && after !== before && fs.existsSync(before)) {
    await mergeIndex(path.join(before, 'index.json'), path.join(after, 'index.json'));
    moveMergeSync(before, after);
  }
  await atomicWrite(SETTINGS_FILE, JSON.stringify(s, null, 1));
  return after;
}

/** 素材の一覧を、移す先の一覧にまとめる(同じファイルは移す先のものを残す) */
async function mergeIndex(from: string, to: string): Promise<void> {
  if (!fs.existsSync(from) || !fs.existsSync(to)) return;
  const read = (f: string) => (JSON.parse(fs.readFileSync(f, 'utf8')) as { items?: { file: string }[] }).items ?? [];
  try {
    const dst = read(to);
    const have = new Set(dst.map((x) => x.file));
    const merged = [...dst, ...read(from).filter((x) => !have.has(x.file))];
    await atomicWrite(to, JSON.stringify({ items: merged }, null, 1));
    fs.rmSync(from, { force: true });
  } catch {
    /* 読めなければ、移す先の一覧のままにする(画像は次に一覧を開いたときに取り込む) */
  }
}

/** フォルダの中身を移す(別のディスクや Drive へはコピーしてから消す)。同じ名前のファイルがあれば移さない */
export function moveMergeSync(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
      return;
    } catch {
      fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
  }
  if (fs.statSync(src).isDirectory() && fs.statSync(dst).isDirectory()) {
    for (const e of fs.readdirSync(src)) moveMergeSync(path.join(src, e), path.join(dst, e));
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  }
}
