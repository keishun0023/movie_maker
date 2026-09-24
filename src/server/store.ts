// プロジェクトの保存。project.json を中心に、素材・中間ファイル・書き出しを分けて置く。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Asset, Project } from '../shared/types.js';
import { createProject, migrateProject } from '../shared/project.js';
import { PROJECTS_DIR } from './config.js';

const ID_RE = /^[a-zA-Z0-9_-]{3,80}$/;

export function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, '不正なIDです');
  return id;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function projectDir(id: string): string {
  return path.join(PROJECTS_DIR, assertId(id));
}

/** プロジェクト内のサブフォルダ */
export function sub(id: string, ...parts: string[]): string {
  const base = projectDir(id);
  const p = path.resolve(base, ...parts);
  if (!p.startsWith(base + path.sep) && p !== base) throw new HttpError(400, '不正なパスです');
  return p;
}

/** 一時ファイルに書いてから置き換える(書き込み途中で壊れない) */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

export async function listProjects(): Promise<{ id: string; name: string; updatedAt: string }[]> {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  const dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  const out: { id: string; name: string; updatedAt: string }[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !ID_RE.test(d.name)) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(PROJECTS_DIR, d.name, 'project.json'), 'utf8'));
      out.push({ id: d.name, name: j.name ?? d.name, updatedAt: j.updatedAt ?? '' });
    } catch {
      /* 壊れたプロジェクトは一覧に出さない */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function newProject(name: string): Promise<Project> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `p${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  const p = createProject(id, name.trim() || '新しい動画');
  for (const d of ['assets', 'work', 'cache', 'exports']) await fsp.mkdir(sub(id, d), { recursive: true });
  await saveProject(p);
  return p;
}

export async function loadProject(id: string): Promise<Project> {
  const file = sub(id, 'project.json');
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new HttpError(404, 'プロジェクトが見つかりません');
  }
  const j = JSON.parse(raw);
  return migrateProject({ ...j, id });
}

// 同じプロジェクトへの保存を直列化する
const saveChains = new Map<string, Promise<void>>();

export async function saveProject(p: Project): Promise<Project> {
  const id = assertId(p.id);
  const next: Project = { ...p, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(sanitizeForSave(next), null, 1);
  const prev = saveChains.get(id) ?? Promise.resolve();
  const job = prev.then(async () => {
    const file = sub(id, 'project.json');
    if (fs.existsSync(file)) await fsp.copyFile(file, file + '.bak').catch(() => undefined);
    await atomicWrite(file, json);
  });
  saveChains.set(id, job.catch(() => undefined));
  await job;
  return next;
}

/** 秘密情報になりうるキーは保存しない */
function sanitizeForSave(p: Project): Project {
  const clone = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  for (const k of Object.keys(clone)) if (/api.?key|token.?secret|password/i.test(k)) delete clone[k];
  return clone as unknown as Project;
}

export function assetFile(projectId: string, asset: Asset, which: 'file' | 'proxy' | 'thumb' = 'file'): string {
  const rel = which === 'file' ? asset.file : which === 'proxy' ? asset.proxy : asset.thumb;
  if (!rel) throw new HttpError(404, 'ファイルがありません');
  return sub(projectId, rel);
}

export function findAsset(p: Project, assetId: string): Asset {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a) throw new HttpError(404, '素材が見つかりません');
  return a;
}

export async function deleteProject(id: string): Promise<void> {
  await fsp.rm(projectDir(id), { recursive: true, force: true });
}
