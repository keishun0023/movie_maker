// マシン情報と依存ツールの検出。Apple Silicon と決めつけない。
import fs from 'node:fs';
import os from 'node:os';
import { DATA_DIR } from './config.js';
import { run, tools } from './proc.js';

export interface SystemInfo {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuKind: 'apple-silicon' | 'intel' | 'other';
  rosetta: boolean;
  cores: number;
  memGB: number;
  diskFreeGB: number | null;
  dataDir: string;
  tools: { ffmpeg: string | null; ffprobe: string | null; whisper: string | null };
  ffmpegVersion: string | null;
  ffmpegHasX264: boolean;
  nodeVersion: string;
}

let cache: { at: number; info: SystemInfo } | null = null;

export async function systemInfo(refresh = false): Promise<SystemInfo> {
  if (cache && !refresh && Date.now() - cache.at < 30_000) return cache.info;
  const t = tools(true);
  let cpuModel = os.cpus()[0]?.model ?? 'unknown';
  let rosetta = false;
  if (process.platform === 'darwin') {
    try {
      const r = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
      if (r.code === 0 && r.stdout.trim()) cpuModel = r.stdout.trim();
      const tr = await run('sysctl', ['-n', 'sysctl.proc_translated']);
      rosetta = tr.stdout.trim() === '1';
    } catch {
      /* sysctl が使えない環境 */
    }
  }
  const cpuKind: SystemInfo['cpuKind'] = /Apple/i.test(cpuModel) || (process.platform === 'darwin' && os.arch() === 'arm64')
    ? 'apple-silicon'
    : /Intel/i.test(cpuModel)
      ? 'intel'
      : 'other';
  let diskFreeGB: number | null = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const st = fs.statfsSync(DATA_DIR);
    diskFreeGB = Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    diskFreeGB = null;
  }
  let ffmpegVersion: string | null = null;
  let ffmpegHasX264 = false;
  if (t.ffmpeg) {
    try {
      const v = await run(t.ffmpeg, ['-hide_banner', '-version']);
      ffmpegVersion = v.stdout.split('\n')[0]?.replace(/^ffmpeg version\s*/, '').split(' ')[0] ?? null;
      const enc = await run(t.ffmpeg, ['-hide_banner', '-encoders']);
      ffmpegHasX264 = /libx264/.test(enc.stdout);
    } catch {
      /* 無視 */
    }
  }
  const info: SystemInfo = {
    platform: process.platform,
    arch: os.arch(),
    cpuModel,
    cpuKind,
    rosetta,
    cores: os.cpus().length,
    memGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    diskFreeGB,
    dataDir: DATA_DIR,
    tools: t,
    ffmpegVersion,
    ffmpegHasX264,
    nodeVersion: process.version,
  };
  cache = { at: Date.now(), info };
  return info;
}
