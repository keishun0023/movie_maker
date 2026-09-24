// whisper.cpp 用モデルの管理(一覧・推奨・ダウンロード)。
// 英語専用(.en)モデルは使わない。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MODELS_DIR } from './config.js';
import type { SystemInfo } from './system.js';

export interface ModelDef {
  id: string;
  file: string;
  label: string;
  sizeMB: number;
  /** whisper-cli の --dtw プリセット名 */
  dtw: string;
  note: string;
}

export const MODELS: ModelDef[] = [
  { id: 'small-q5_1', file: 'ggml-small-q5_1.bin', label: 'small (速度重視)', sizeMB: 190, dtw: 'small', note: '軽くて速い。固有名詞や聞き取りにくい箇所は誤りが増えます。' },
  { id: 'medium-q5_0', file: 'ggml-medium-q5_0.bin', label: 'medium', sizeMB: 539, dtw: 'medium', note: '速度と精度の中間。' },
  { id: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', label: 'large-v3-turbo (精度重視)', sizeMB: 574, dtw: 'large.v3.turbo', note: '日本語の精度が高い多言語モデル。Apple Silicon なら実用的な速度です。' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', label: 'large-v3-turbo (非量子化)', sizeMB: 1624, dtw: 'large.v3.turbo', note: '量子化なし。メモリ16GB以上向け。' },
];

const BASE_URL = process.env.TDM_MODEL_BASE_URL ?? 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export function modelPath(def: ModelDef): string {
  return path.join(MODELS_DIR, def.file);
}

export function modelDef(id: string): ModelDef | null {
  return MODELS.find((m) => m.id === id) ?? null;
}

export function isInstalled(def: ModelDef): boolean {
  try {
    return fs.statSync(modelPath(def)).size > 1_000_000;
  } catch {
    return false;
  }
}

/** マシンの性能から推奨モデルを選ぶ */
export function recommend(sys: SystemInfo): { speed: string; accuracy: string; defaultQuality: 'speed' | 'accuracy'; reason: string } {
  if (sys.cpuKind === 'apple-silicon' && sys.memGB >= 8) {
    return { speed: 'small-q5_1', accuracy: 'large-v3-turbo-q5_0', defaultQuality: 'accuracy', reason: 'Apple Silicon・メモリ8GB以上のため精度重視モデルを推奨します。' };
  }
  if (sys.memGB >= 8 && sys.cores >= 8) {
    return { speed: 'small-q5_1', accuracy: 'large-v3-turbo-q5_0', defaultQuality: 'speed', reason: 'GPU加速が使えない可能性があるため速度重視を初期値にしています(精度重視は時間がかかります)。' };
  }
  return { speed: 'small-q5_1', accuracy: 'medium-q5_0', defaultQuality: 'speed', reason: 'メモリ・CPUが控えめなため軽いモデルを推奨します。' };
}

export function listModels() {
  return MODELS.map((m) => ({ ...m, installed: isInstalled(m), path: modelPath(m) }));
}

/** 途中から再開できるダウンロード。進捗を返す */
export async function downloadModel(def: ModelDef, signal: AbortSignal, progress: (p: number, msg: string) => void): Promise<string> {
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const dest = modelPath(def);
  if (isInstalled(def)) return dest;
  const part = dest + '.part';
  let have = 0;
  try {
    have = (await fsp.stat(part)).size;
  } catch {
    have = 0;
  }
  const headers: Record<string, string> = {};
  if (have > 0) headers.Range = `bytes=${have}-`;
  const res = await fetch(BASE_URL + def.file, { headers, signal, redirect: 'follow' });
  if (!(res.ok || res.status === 206)) throw new Error(`ダウンロードに失敗しました (HTTP ${res.status})。ネットワーク接続を確認して再試行してください。`);
  if (res.status === 200 && have > 0) have = 0; // Range 非対応なら最初から
  const len = Number(res.headers.get('content-length') ?? 0);
  const total = len ? have + len : def.sizeMB * 1024 * 1024;
  const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
  let got = have;
  let lastReport = 0;
  try {
    if (!res.body) throw new Error('ダウンロードの応答が空です');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - lastReport > 300) {
        lastReport = Date.now();
        progress(got / total, `${(got / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`);
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  // ggml モデルの先頭を簡易確認
  const fh = await fsp.open(part, 'r');
  const magic = Buffer.alloc(4);
  await fh.read(magic, 0, 4, 0);
  await fh.close();
  if (magic.readUInt32LE(0) !== 0x67676d6c) {
    await fsp.rm(part, { force: true });
    throw new Error('ダウンロードしたファイルがモデルの形式ではありません。再試行してください。');
  }
  await fsp.rename(part, dest);
  return dest;
}
