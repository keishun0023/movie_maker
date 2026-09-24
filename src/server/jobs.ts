// 長い処理のジョブ管理。進捗・失敗理由・再試行・キャンセルを扱う。
// キューごとに1件ずつ順番に実行する(書き出しは設定を固定したままキューに積む)。
import crypto from 'node:crypto';
import type { JobInfo } from '../shared/types.js';
import { CanceledError } from './proc.js';

export interface JobContext {
  signal: AbortSignal;
  progress: (p: number, message?: string) => void;
  job: JobInfo;
}

type Runner = (ctx: JobContext) => Promise<unknown>;

interface JobEntry {
  info: JobInfo;
  queue: string;
  runner: Runner;
  controller: AbortController;
  cleanup?: () => Promise<void> | void;
}

const jobs = new Map<string, JobEntry>();
const queues = new Map<string, string[]>();
const running = new Map<string, string | null>();

export interface EnqueueOptions {
  type: string;
  label: string;
  projectId?: string;
  queue: string;
  runner: Runner;
  /** キャンセル・失敗時の後片付け(一時ファイル削除など) */
  cleanup?: () => Promise<void> | void;
}

export function enqueue(opt: EnqueueOptions): JobInfo {
  const info: JobInfo = {
    id: 'job-' + crypto.randomBytes(6).toString('hex'),
    type: opt.type,
    label: opt.label,
    status: 'queued',
    progress: 0,
    message: '順番待ち',
    createdAt: new Date().toISOString(),
  };
  if (opt.projectId) info.projectId = opt.projectId;
  const entry: JobEntry = { info, queue: opt.queue, runner: opt.runner, controller: new AbortController() };
  if (opt.cleanup) entry.cleanup = opt.cleanup;
  jobs.set(info.id, entry);
  const q = queues.get(opt.queue) ?? [];
  q.push(info.id);
  queues.set(opt.queue, q);
  pump(opt.queue);
  pruneOld();
  return info;
}

function pump(queue: string) {
  if (running.get(queue)) return;
  const q = queues.get(queue) ?? [];
  const next = q.shift();
  if (!next) return;
  const entry = jobs.get(next);
  if (!entry || entry.info.status !== 'queued') return pump(queue);
  running.set(queue, next);
  void execute(entry).finally(() => {
    running.set(queue, null);
    pump(queue);
  });
}

async function execute(entry: JobEntry) {
  const { info } = entry;
  info.status = 'running';
  info.message = '処理中';
  const ctx: JobContext = {
    signal: entry.controller.signal,
    job: info,
    progress: (p, message) => {
      info.progress = Math.max(0, Math.min(1, p));
      if (message) info.message = message;
    },
  };
  try {
    const result = await entry.runner(ctx);
    if (entry.controller.signal.aborted) throw new CanceledError();
    info.result = result;
    info.status = 'done';
    info.progress = 1;
    info.message = '完了';
  } catch (e) {
    if (e instanceof CanceledError || entry.controller.signal.aborted) {
      info.status = 'canceled';
      info.message = 'キャンセルしました';
    } else {
      info.status = 'failed';
      info.error = e instanceof Error ? e.message : String(e);
      info.message = '失敗しました';
      console.error(`[job ${info.id} ${info.type}]`, e);
    }
    try {
      await entry.cleanup?.();
    } catch (ce) {
      console.error('cleanup failed', ce);
    }
  } finally {
    info.finishedAt = new Date().toISOString();
  }
}

export function getJob(id: string): JobInfo | null {
  return jobs.get(id)?.info ?? null;
}

export function listJobs(projectId?: string): JobInfo[] {
  return [...jobs.values()].map((j) => j.info).filter((j) => !projectId || j.projectId === projectId);
}

export function cancelJob(id: string): boolean {
  const e = jobs.get(id);
  if (!e) return false;
  if (e.info.status === 'queued') {
    e.info.status = 'canceled';
    e.info.message = 'キャンセルしました';
    e.info.finishedAt = new Date().toISOString();
    return true;
  }
  if (e.info.status === 'running') {
    e.controller.abort();
    return true;
  }
  return false;
}

/** 同じ内容でもう一度実行する */
export function retryJob(id: string): JobInfo | null {
  const e = jobs.get(id);
  if (!e || (e.info.status !== 'failed' && e.info.status !== 'canceled')) return null;
  const opt: EnqueueOptions = { type: e.info.type, label: e.info.label, queue: e.queue, runner: e.runner };
  if (e.info.projectId) opt.projectId = e.info.projectId;
  if (e.cleanup) opt.cleanup = e.cleanup;
  return enqueue(opt);
}

function pruneOld() {
  const finished = [...jobs.values()].filter((j) => j.info.finishedAt).sort((a, b) => (a.info.finishedAt! < b.info.finishedAt! ? -1 : 1));
  while (finished.length > 200) {
    const j = finished.shift()!;
    jobs.delete(j.info.id);
  }
}
