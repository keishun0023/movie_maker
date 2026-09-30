// APIキーの保存。project.json やログには書かず、データフォルダの secrets.json(本人のみ読み書き可)に置く。
// 環境変数 GEMINI_API_KEY があればそちらを優先する。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'secrets.json');

interface Secrets {
  geminiApiKey?: string;
  anthropicApiKey?: string;
}

function readSecrets(): Secrets {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Secrets;
  } catch {
    return {};
  }
}

export function geminiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || readSecrets().geminiApiKey || null;
}

export function geminiKeySource(): 'env' | 'file' | null {
  if (process.env.GEMINI_API_KEY?.trim()) return 'env';
  return readSecrets().geminiApiKey ? 'file' : null;
}

export async function setGeminiKey(key: string | null): Promise<void> {
  const s = readSecrets();
  if (key) s.geminiApiKey = key;
  else delete s.geminiApiKey;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await fsp.rename(tmp, FILE);
  await fsp.chmod(FILE, 0o600).catch(() => undefined);
}

export function anthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || readSecrets().anthropicApiKey || null;
}

export function anthropicKeySource(): 'env' | 'file' | null {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return 'env';
  return readSecrets().anthropicApiKey ? 'file' : null;
}

export async function setAnthropicKey(key: string | null): Promise<void> {
  const s = readSecrets();
  if (key) s.anthropicApiKey = key;
  else delete s.anthropicApiKey;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await fsp.rename(tmp, FILE);
  await fsp.chmod(FILE, 0o600).catch(() => undefined);
}
