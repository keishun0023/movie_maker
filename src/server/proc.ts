// 子プロセスの起動。シェルを通さず引数配列で渡す(ファイル名や入力を文字列連結しない)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from './config.js';

export class CanceledError extends Error {
  constructor() {
    super('キャンセルされました');
    this.name = 'CanceledError';
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderrLine?: (line: string) => void;
  cwd?: string;
  /** stdout を文字列として集める(大きな出力では false に) */
  collectStdout?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opt: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opt.signal?.aborted) return reject(new CanceledError());
    const child = spawn(cmd, args, { cwd: opt.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out: Buffer[] = [];
    let err = '';
    let lineBuf = '';
    const onAbort = () => {
      child.kill('SIGKILL');
    };
    opt.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      if (opt.onStdout) opt.onStdout(c);
      if (opt.collectStdout !== false) out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      if (opt.onStderrLine) {
        lineBuf += s;
        const parts = lineBuf.split(/\r|\n/);
        lineBuf = parts.pop() ?? '';
        for (const p of parts) if (p) opt.onStderrLine(p);
      }
    });
    child.on('error', (e) => {
      opt.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      opt.signal?.removeEventListener('abort', onAbort);
      if (opt.signal?.aborted) return reject(new CanceledError());
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
  });
}

/** 失敗したら例外にする版 */
export async function runOk(cmd: string, args: string[], opt: RunOptions = {}): Promise<RunResult> {
  const r = await run(cmd, args, opt);
  if (r.code !== 0) {
    const tail = r.stderr.split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`${path.basename(cmd)} が失敗しました (code ${r.code})\n${tail}`);
  }
  return r;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** PATH と Homebrew の標準位置、同梱の .tools から実行ファイルを探す */
export function findExecutable(names: string[], envVar?: string): string | null {
  if (envVar && process.env[envVar] && isExecutable(process.env[envVar]!)) return process.env[envVar]!;
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(TOOLS_DIR, 'bin'),
    path.join(TOOLS_DIR, 'whisper.cpp', 'build', 'bin'),
  ].filter(Boolean);
  for (const name of names) {
    for (const d of dirs) {
      const p = path.join(d, name);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

export interface Tools {
  ffmpeg: string | null;
  ffprobe: string | null;
  whisper: string | null;
}

let cached: Tools | null = null;
export function tools(refresh = false): Tools {
  if (cached && !refresh) return cached;
  cached = {
    ffmpeg: findExecutable(['ffmpeg'], 'FFMPEG_PATH'),
    ffprobe: findExecutable(['ffprobe'], 'FFPROBE_PATH'),
    whisper: findExecutable(['whisper-cli', 'whisper-cpp'], 'WHISPER_CLI'),
  };
  return cached;
}

export function requireTool(name: keyof Tools): string {
  const t = tools()[name] ?? tools(true)[name];
  if (!t) {
    const hint =
      name === 'whisper'
        ? 'whisper.cpp が見つかりません。README の「セットアップ」を参照してください (brew install whisper-cpp)。'
        : `${name} が見つかりません。brew install ffmpeg でインストールしてください。`;
    throw new Error(hint);
  }
  return t;
}
