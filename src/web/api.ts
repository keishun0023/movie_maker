// ローカルAPIの呼び出し。
import type { AnalysisData, Asset, FontInfo, JobInfo, Project, StylePreset, Timeline } from '../shared/types.js';

async function call<T>(method: string, url: string, body?: unknown, raw?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { 'X-TDM': '1', ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data ? String((data as { error: string }).error) : '') || `エラー (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export interface ModelStatus {
  id: string;
  file: string;
  label: string;
  sizeMB: number;
  note: string;
  installed: boolean;
  path: string;
}

export interface BuildInfo {
  kind: 'app' | 'dev';
  version: string;
  commit?: string;
  date?: string;
  arch?: string;
}

export interface SystemResp {
  build?: BuildInfo;
  system: {
    platform: string;
    arch: string;
    cpuModel: string;
    cpuKind: string;
    rosetta: boolean;
    cores: number;
    memGB: number;
    diskFreeGB: number | null;
    dataDir: string;
    tools: { ffmpeg: string | null; ffprobe: string | null; whisper: string | null };
    ffmpegVersion: string | null;
    ffmpegHasX264: boolean;
  };
  recommend: { speed: string; accuracy: string; defaultQuality: 'speed' | 'accuracy'; reason: string };
  models: ModelStatus[];
  asrAvailable: boolean;
}

export const api = {
  system: () => call<SystemResp>('GET', '/api/system'),
  downloadModel: (id: string) => call<JobInfo>('POST', `/api/models/${encodeURIComponent(id)}/download`, {}),
  fonts: (rescan = false) => call<FontInfo[]>('GET', '/api/fonts' + (rescan ? '?rescan=1' : '')),
  missingGlyphs: (items: { fontId: string; text: string }[]) => call<{ fontId: string; known: boolean; missing: string[] }[]>('POST', '/api/fonts/missing', { items }),
  presets: () => call<StylePreset[]>('GET', '/api/presets'),
  savePresets: (list: StylePreset[]) => call<StylePreset[]>('PUT', '/api/presets', list),
  projects: () => call<{ id: string; name: string; updatedAt: string }[]>('GET', '/api/projects'),
  createProject: (name: string) => call<Project>('POST', '/api/projects', { name }),
  deleteProject: (id: string) => call<{ ok: boolean }>('DELETE', `/api/projects/${id}`, {}),
  project: (id: string) => call<Project>('GET', `/api/projects/${id}`),
  saveProject: (p: Project) => call<{ updatedAt: string }>('PUT', `/api/projects/${p.id}`, p),
  upload: (projectId: string, file: File) =>
    call<{ asset: Asset; jobId: string | null }>('POST', `/api/projects/${projectId}/assets`, undefined, file, {
      'x-filename': encodeURIComponent(file.name),
      'Content-Type': 'application/octet-stream',
    }),
  deleteAsset: (projectId: string, asset: Asset) => call<{ ok: boolean }>('DELETE', `/api/projects/${projectId}/assets/${asset.id}`, { asset }),
  prepareNarration: (projectId: string, asset: Asset, audioIndex: number) => call<JobInfo>('POST', `/api/projects/${projectId}/narration`, { asset, audioIndex }),
  analysis: (projectId: string, key: string) => call<AnalysisData>('GET', `/api/projects/${projectId}/analysis/${key}`),
  settings: () => call<{ geminiKeySource: 'env' | 'file' | null; anthropicKeySource: 'env' | 'file' | null }>('GET', '/api/settings'),
  setAnthropicKey: (key: string | null) => call<{ anthropicKeySource: 'env' | 'file' | null }>('PUT', '/api/settings/anthropic-key', { key }),
  strip: (projectId: string, assetId: string) => call<{ t: number; frame: string }[]>('GET', `/api/projects/${projectId}/strip/${encodeURIComponent(assetId)}`),
  shots: (project: Project, assetId: string) => call<JobInfo>('POST', `/api/projects/${project.id}/shots`, { project, assetId }),
  aiAssign: (project: Project) => call<JobInfo>('POST', `/api/projects/${project.id}/ai-assign`, { project }),
  setGeminiKey: (key: string | null) => call<{ geminiKeySource: 'env' | 'file' | null }>('PUT', '/api/settings/gemini-key', { key }),
  geminiModels: () => call<string[]>('GET', '/api/gemini/models'),
  transcribe: (projectId: string, body: { sourceKey: string; engine: 'whisper' | 'gemini'; geminiModel: string; cloudConsent: boolean; sensitivityDb: number; modelId: string; dtw: boolean; script?: string; useHints?: boolean; extraHints?: string[]; basis?: 'source' | 'edited'; timeline?: Timeline }) =>
    call<JobInfo>('POST', `/api/projects/${projectId}/transcribe`, body),
  editedAudio: (projectId: string, sourceKey: string, timeline: Timeline) => call<{ url: string }>('POST', `/api/projects/${projectId}/edited-audio`, { sourceKey, timeline }),
  startExport: (projectId: string, project: Project, captions: { id: string; outStart: number; outEnd: number; text: string; png: string }[]) =>
    call<JobInfo>('POST', `/api/projects/${projectId}/exports`, { project, captions }),
  capcutDrafts: (dir?: string) =>
    call<{ dir: string; drafts: { name: string; dir: string; durationSec: number; modified: number; readable: boolean; captions: number; audioPieces: number }[] }>('GET', '/api/capcut/drafts' + (dir ? `?dir=${encodeURIComponent(dir)}` : '')),
  capcutTts: (project: Project, lines: string[]) => call<JobInfo>('POST', `/api/projects/${project.id}/capcut-tts`, { project, lines }),
  capcutTtsImport: (projectId: string, draftDir: string) => call<JobInfo>('POST', `/api/projects/${projectId}/capcut-tts-import`, { draftDir }),
  capcutImport: (projectId: string, draftDir: string) => call<JobInfo>('POST', `/api/projects/${projectId}/capcut-import`, { draftDir }),
  capcutInfo: (dir?: string) => call<{ dir: string; defaultDir: string; exists: boolean; projects: number; version: string | null }>('GET', '/api/capcut' + (dir ? `?dir=${encodeURIComponent(dir)}` : '')),
  startCapcut: (projectId: string, project: Project, captions: { outStart: number; outEnd: number; png: string; x: number; y: number; w: number; h: number }[] = []) =>
    call<JobInfo>('POST', `/api/projects/${projectId}/capcut`, { project, captions }),
  exports: (projectId: string) => call<{ name: string; size: number; mtime: string }[]>('GET', `/api/projects/${projectId}/exports`),
  reveal: (projectId: string) => call<{ path: string }>('POST', `/api/projects/${projectId}/reveal`, {}),
  jobs: (projectId?: string) => call<JobInfo[]>('GET', '/api/jobs' + (projectId ? `?projectId=${projectId}` : '')),
  job: (id: string) => call<JobInfo>('GET', `/api/jobs/${id}`),
  cancelJob: (id: string) => call<{ ok: boolean }>('POST', `/api/jobs/${id}/cancel`, {}),
  retryJob: (id: string) => call<JobInfo>('POST', `/api/jobs/${id}/retry`, {}),
};

export const mediaUrl = (projectId: string, assetId: string, which: 'file' | 'preview' | 'thumb') => `/api/projects/${projectId}/media/${assetId}/${which}`;

/** ジョブが終わるまで待つ。途中経過はコールバックで受け取る */
export async function waitJob(id: string, onUpdate?: (j: JobInfo) => void): Promise<JobInfo> {
  for (;;) {
    const j = await api.job(id);
    onUpdate?.(j);
    if (j.status === 'done' || j.status === 'failed' || j.status === 'canceled') return j;
    await new Promise((r) => setTimeout(r, 400));
  }
}
