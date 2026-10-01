import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** リポジトリのルート(dist/server から2つ上) */
export const APP_ROOT = path.resolve(here, '..', '..');

function defaultDataDir(): string {
  if (process.env.TDM_DATA_DIR) return path.resolve(process.env.TDM_DATA_DIR);
  return path.join(os.homedir(), 'TateDougaMaker');
}

export const DATA_DIR = defaultDataDir();
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const MODELS_DIR = process.env.TDM_MODELS_DIR ? path.resolve(process.env.TDM_MODELS_DIR) : path.join(DATA_DIR, 'models');
export const PRESETS_FILE = path.join(DATA_DIR, 'style-presets.json');
export const FONT_CACHE_FILE = path.join(DATA_DIR, 'font-cache.json');
export const BUNDLED_FONTS_DIR = path.join(APP_ROOT, 'assets', 'fonts');
export const WEB_STATIC_DIR = path.join(APP_ROOT, 'src', 'web', 'static');
export const WEB_JS_DIR = path.join(APP_ROOT, 'dist', 'web');
export const SHARED_JS_DIR = path.join(APP_ROOT, 'dist', 'shared');
export const TOOLS_DIR = path.join(APP_ROOT, '.tools');

export const HOST = process.env.TDM_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? process.env.TDM_PORT ?? 5178);

/** どの版で動いているか。Mac アプリ版は build-info.json を同梱する。なければ開発版(ターミナルから起動) */
export interface BuildInfo {
  kind: 'app' | 'dev';
  version: string;
  commit?: string;
  date?: string;
  arch?: string;
}

function readBuildInfo(): BuildInfo {
  let version = '0.0.0';
  try {
    version = (JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    // そのまま
  }
  try {
    const b = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    return { kind: 'app', version, commit: b.commit, date: b.date, arch: b.arch };
  } catch {
    return { kind: 'dev', version };
  }
}

export const BUILD_INFO = readBuildInfo();
