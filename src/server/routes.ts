import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Asset, Project, StylePreset, Timeline, Transcript } from '../shared/types.js';
import { outToSrc } from '../shared/timemap.js';
import { hintTerms } from '../shared/script.js';
import { buildPreview, importUpload, removeAssetFiles } from './assets.js';
import { WhisperCppAdapter } from './asr/whisperCpp.js';
import { PRESETS_FILE } from './config.js';
import { cleanupDir, exportBaseName, runExport, type CaptionImage } from './export.js';
import { fontBytes, fontEntry, listFonts, missingChars, registerProjectFont, scanFonts } from './fonts.js';
import { readBody, readJson, Router, sendFile, sendJson } from './http.js';
import { cancelJob, enqueue, getJob, listJobs, retryJob } from './jobs.js';
import {
  analysisPath,
  asrWavPath,
  BROWSER_IMAGE_EXT,
  ensureEditedWav,
  loadSourcePcm,
  prepareNarration,
  proxyPath,
  renderEdited,
  sourceWavPath,
  thumbPath,
  writeWav,
} from './media.js';
import { downloadModel, isInstalled, listModels, modelDef, modelPath, recommend } from './models.js';
import { requireTool, runOk } from './proc.js';
import {
  assertId,
  atomicWrite,
  deleteProject,
  findAsset,
  HttpError,
  listProjects,
  loadProject,
  newProject,
  saveProject,
  sub,
} from './store.js';
import { systemInfo } from './system.js';

export const router = new Router();
const asr = new WhisperCppAdapter();

// ---- システム・モデル ----

router.get('/api/system', async (_req, res) => {
  const sys = await systemInfo(true);
  sendJson(res, 200, { system: sys, recommend: recommend(sys), models: listModels(), asrAvailable: asr.available() });
});

router.post('/api/models/:id/download', (req, res) => {
  const def = modelDef(req.params.id!);
  if (!def) throw new HttpError(404, 'モデルが見つかりません');
  const job = enqueue({
    type: 'model-download',
    label: `モデル ${def.label} のダウンロード (約${def.sizeMB}MB)`,
    queue: 'download',
    runner: async (ctx) => {
      const p = await downloadModel(def, ctx.signal, (v, m) => ctx.progress(v, m));
      return { path: p };
    },
  });
  sendJson(res, 200, job);
});

// ---- フォント ----

router.get('/api/fonts', async (req, res) => {
  if (req.query.get('rescan') === '1') await scanFonts(true);
  sendJson(res, 200, await listFonts());
});

router.get('/api/fonts/file', async (req, res) => {
  const id = req.query.get('id') ?? '';
  await scanFonts();
  const e = fontEntry(id);
  if (!e) throw new HttpError(404, 'フォントが見つかりません');
  const buf = await fontBytes(id);
  res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'private, max-age=3600', 'Content-Length': buf.length });
  res.end(buf);
});

router.post('/api/fonts/missing', async (req, res) => {
  const body = await readJson<{ items: { fontId: string; text: string }[] }>(req);
  await scanFonts();
  sendJson(
    res,
    200,
    body.items.map((it) => {
      const e = fontEntry(it.fontId);
      return { fontId: it.fontId, known: !!e && e.info.status === 'ok', missing: e ? missingChars(it.fontId, it.text) : [] };
    }),
  );
});

// ---- スタイルプリセット ----

router.get('/api/presets', async (_req, res) => {
  try {
    sendJson(res, 200, JSON.parse(await fsp.readFile(PRESETS_FILE, 'utf8')));
  } catch {
    sendJson(res, 200, []);
  }
});

router.put('/api/presets', async (req, res) => {
  const list = await readJson<StylePreset[]>(req);
  if (!Array.isArray(list)) throw new HttpError(400, '形式が正しくありません');
  await atomicWrite(PRESETS_FILE, JSON.stringify(list, null, 1));
  sendJson(res, 200, list);
});

// ---- プロジェクト ----

router.get('/api/projects', async (_req, res) => sendJson(res, 200, await listProjects()));

router.post('/api/projects', async (req, res) => {
  const body = await readJson<{ name?: string }>(req);
  sendJson(res, 200, await newProject(String(body.name ?? '')));
});

async function ensureProjectFonts(p: Project) {
  await scanFonts();
  for (const a of p.assets) {
    if (a.kind === 'font' && a.status === 'ok' && a.fontIds?.some((id) => !fontEntry(id))) {
      await registerProjectFont(sub(p.id, a.file)).catch(() => undefined);
    }
  }
}

router.get('/api/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id!);
  await ensureProjectFonts(p);
  sendJson(res, 200, p);
});

router.put('/api/projects/:id', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<Project>(req, 50 * 1024 * 1024);
  if (body.id !== id) throw new HttpError(400, 'プロジェクトIDが一致しません');
  await loadProject(id); // 存在確認
  const saved = await saveProject(body);
  sendJson(res, 200, { updatedAt: saved.updatedAt });
});

router.del('/api/projects/:id', async (req, res) => {
  await deleteProject(assertId(req.params.id!));
  sendJson(res, 200, { ok: true });
});

// ---- 素材 ----

router.post('/api/projects/:id/assets', async (req, res) => {
  const id = assertId(req.params.id!);
  await loadProject(id);
  const { asset, needsPreview } = await importUpload(id, req);
  let jobId: string | null = null;
  if (needsPreview) {
    const job = enqueue({
      type: 'preview',
      label: `${asset.name} のプレビュー作成`,
      projectId: id,
      queue: 'media',
      runner: (ctx) => buildPreview(id, asset, ctx.signal, ctx.progress),
    });
    jobId = job.id;
  }
  sendJson(res, 200, { asset, jobId });
});

router.del('/api/projects/:id/assets/:assetId', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ asset: Asset }>(req);
  if (body.asset?.id !== req.params.assetId) throw new HttpError(400, '素材IDが一致しません');
  // プロジェクト内のファイルだけを消す(sub がパスを検証する)
  await removeAssetFiles(id, body.asset);
  sendJson(res, 200, { ok: true });
});

async function assetFromProject(projectId: string, assetId: string): Promise<Asset> {
  const p = await loadProject(projectId);
  return findAsset(p, assetId);
}

// 保存前の素材も配信できるよう、ID からファイル位置を決める
router.get('/api/projects/:id/media/:assetId/:which', async (req, res) => {
  const id = assertId(req.params.id!);
  const assetId = assertId(req.params.assetId!);
  const which = req.params.which!;
  const dir = sub(id, 'assets');
  if (which === 'thumb') {
    return sendFile(req, res, thumbPath(id, assetId), { cache: 'no-cache' });
  }
  if (which === 'preview') {
    for (const ext of ['.png', '.jpg', '.mp4']) {
      const p = proxyPath(id, assetId, ext);
      if (fs.existsSync(p)) return sendFile(req, res, p);
    }
  }
  // 元ファイル(assets/<id>.<ext>)
  const files = await fsp.readdir(dir).catch(() => [] as string[]);
  const f = files.find((n) => n.startsWith(assetId + '.') && !n.endsWith('.part'));
  if (!f) throw new HttpError(404, 'ファイルが見つかりません');
  if (which === 'preview' && BROWSER_IMAGE_EXT.includes(path.extname(f).toLowerCase()) === false && !/\.(mp4|m4v|mov|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(f)) {
    throw new HttpError(404, 'プレビューを準備中です');
  }
  return sendFile(req, res, path.join(dir, f));
});

// ---- ナレーション・解析 ----

router.post('/api/projects/:id/narration', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ asset: Asset; audioIndex: number }>(req);
  const asset = body.asset;
  if (!asset || !/^[a-zA-Z0-9_-]+$/.test(asset.id)) throw new HttpError(400, '素材が正しくありません');
  if (!fs.existsSync(sub(id, asset.file))) throw new HttpError(404, '素材ファイルが見つかりません');
  const audioIndex = Number(body.audioIndex ?? 0);
  const job = enqueue({
    type: 'narration',
    label: `${asset.name} の音声を準備`,
    projectId: id,
    queue: 'analysis',
    runner: async (ctx) => {
      const r = await prepareNarration(id, asset, audioIndex, ctx.signal, ctx.progress);
      return {
        narration: {
          assetId: asset.id,
          audioIndex,
          durationSamples: r.durationSamples,
          sourceKey: r.key,
          preparedAt: new Date().toISOString(),
          warnings: r.warnings,
        },
      };
    },
  });
  sendJson(res, 200, job);
});

router.get('/api/projects/:id/analysis/:key', async (req, res) => {
  const id = assertId(req.params.id!);
  const key = assertId(req.params.key!);
  return sendFile(req, res, analysisPath(id, key), { type: 'application/json; charset=utf-8' });
});

router.post('/api/projects/:id/transcribe', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ sourceKey: string; modelId: string; dtw: boolean; script?: string; useHints?: boolean; basis?: 'source' | 'edited'; timeline?: Timeline }>(req);
  const key = assertId(body.sourceKey);
  const def = modelDef(body.modelId);
  if (!def) throw new HttpError(400, 'モデルが正しくありません');
  if (!isInstalled(def)) throw new HttpError(409, `モデル「${def.label}」がまだ導入されていません。先にダウンロードしてください。`);
  if (!asr.available()) requireTool('whisper');
  const hints = body.useHints && body.script ? hintTerms(body.script) : [];
  const prompt = hints.length ? hints.join('、') : undefined;
  const basis = body.basis === 'edited' && body.timeline ? 'edited' : 'source';
  const tl = basis === 'edited' ? body.timeline! : null;
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify([key, def.id, body.dtw, prompt ?? '', basis, tl?.hash ?? '']))
    .digest('hex')
    .slice(0, 20);
  const cacheFile = sub(id, 'cache', `asr-${cacheKey}.json`);
  const job = enqueue({
    type: 'transcribe',
    label: `文字起こし (${def.label})`,
    projectId: id,
    queue: 'analysis',
    runner: async (ctx) => {
      if (fs.existsSync(cacheFile)) {
        ctx.progress(1, '前回の認識結果を再利用しました');
        return { transcript: JSON.parse(await fsp.readFile(cacheFile, 'utf8')) as Transcript, cached: true };
      }
      let wav = asrWavPath(id, key);
      const tmpFiles: string[] = [];
      if (tl) {
        ctx.progress(0.01, '編集後の音声を準備しています');
        const src = await loadSourcePcm(id, key);
        const edited = sub(id, 'work', `asr-edited-${tl.hash}.wav`);
        const tmp48 = edited + '.48k.wav';
        await writeWav(tmp48, renderEdited(src, tl));
        await runOk(requireTool('ffmpeg'), ['-y', '-v', 'error', '-i', tmp48, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', edited], { signal: ctx.signal });
        tmpFiles.push(tmp48, edited);
        wav = edited;
      }
      try {
        const r = await asr.transcribe({
          wavPath: wav,
          language: 'ja',
          modelPath: modelPath(def),
          ...(body.dtw ? { dtwPreset: def.dtw } : {}),
          ...(prompt ? { prompt } : {}),
          workDir: sub(id, 'work'),
          signal: ctx.signal,
          progress: ctx.progress,
        });
        let tokens = r.tokens;
        if (tl) {
          // 編集後音声の時刻を元音声の時刻へ戻す
          tokens = tokens.map((t) => ({ ...t, start: outToSrc(tl, t.start), end: Math.max(outToSrc(tl, t.start), outToSrc(tl, t.end)) }));
        }
        const notes = [...r.notes];
        if (prompt) notes.push(`台本から認識ヒントを使用: ${prompt}`);
        const transcript: Transcript = { engine: asr.name, model: def.id, createdAt: new Date().toISOString(), basis, tokens, notes };
        await atomicWrite(cacheFile, JSON.stringify(transcript));
        return { transcript, cached: false };
      } finally {
        for (const f of tmpFiles) await fsp.rm(f, { force: true }).catch(() => undefined);
      }
    },
  });
  sendJson(res, 200, job);
});

router.post('/api/projects/:id/edited-audio', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ sourceKey: string; timeline: Timeline }>(req);
  const key = assertId(body.sourceKey);
  const tl = body.timeline;
  if (!tl || !Array.isArray(tl.segments) || !/^[0-9a-f]+$/.test(tl.hash)) throw new HttpError(400, '対応表が正しくありません');
  const file = await ensureEditedWav(id, key, tl);
  sendJson(res, 200, { url: `/api/projects/${id}/audio/${path.basename(file)}` });
});

router.get('/api/projects/:id/audio/:name', async (req, res) => {
  const id = assertId(req.params.id!);
  const name = req.params.name!;
  if (!/^(edited|source)-[0-9a-f-]+\.wav$/.test(name)) throw new HttpError(400, '不正なファイル名です');
  return sendFile(req, res, sub(id, 'work', name));
});

router.get('/api/projects/:id/source-audio/:key', async (req, res) => {
  const id = assertId(req.params.id!);
  return sendFile(req, res, sourceWavPath(id, assertId(req.params.key!)));
});

// ---- 書き出し ----

router.post('/api/projects/:id/exports', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ project: Project; captions: { id: string; outStart: number; outEnd: number; text: string; png: string }[] }>(req, 400 * 1024 * 1024);
  const project = body.project;
  if (!project || project.id !== id) throw new HttpError(400, 'プロジェクトが一致しません');
  if (!project.narration) throw new HttpError(400, 'ナレーション音声を設定してください');
  requireTool('ffmpeg');
  // 書き出し開始時点の設定とテロップ画像を固定する
  const workDir = sub(id, 'work', `export-${crypto.randomBytes(5).toString('hex')}`);
  await fsp.mkdir(workDir, { recursive: true });
  const caps: CaptionImage[] = [];
  for (let i = 0; i < (body.captions ?? []).length; i++) {
    const c = body.captions[i]!;
    const m = /^data:image\/png;base64,(.+)$/.exec(c.png);
    if (!m) continue;
    const file = path.join(workDir, `cap-${String(i).padStart(4, '0')}.png`);
    await fsp.writeFile(file, Buffer.from(m[1]!, 'base64'));
    caps.push({ id: c.id, outStart: Math.round(c.outStart), outEnd: Math.round(c.outEnd), text: String(c.text ?? ''), file });
  }
  const baseName = exportBaseName(project);
  const job = enqueue({
    type: 'export',
    label: `書き出し ${baseName}.mp4`,
    projectId: id,
    queue: 'export',
    runner: (ctx) => runExport({ project, captions: caps, workDir, baseName }, ctx),
    cleanup: cleanupDir(workDir),
  });
  sendJson(res, 200, job);
});

router.get('/api/projects/:id/exports', async (req, res) => {
  const id = assertId(req.params.id!);
  const dir = sub(id, 'exports');
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const out = [];
  for (const n of names) {
    if (!/\.(mp4|wav|srt)$/.test(n)) continue;
    const st = await fsp.stat(path.join(dir, n));
    out.push({ name: n, size: st.size, mtime: st.mtime.toISOString() });
  }
  sendJson(res, 200, out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1)));
});

router.get('/api/projects/:id/exports/:name', async (req, res) => {
  const id = assertId(req.params.id!);
  const name = req.params.name!;
  const dir = sub(id, 'exports');
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  if (!names.includes(name) || name.includes('/')) throw new HttpError(404, 'ファイルが見つかりません');
  const dl = req.query.get('download') === '1';
  return sendFile(req, res, path.join(dir, name), dl ? { download: name } : {});
});

router.get('/api/projects/:id/export-frames/:name', async (req, res) => {
  const id = assertId(req.params.id!);
  const name = req.params.name!;
  if (!/^[^/\\]+_f\d+\.jpg$/.test(name)) throw new HttpError(400, '不正なファイル名です');
  return sendFile(req, res, sub(id, 'exports', 'frames', name));
});

router.post('/api/projects/:id/reveal', async (req, res) => {
  // macOS の Finder で書き出しフォルダを開く
  const id = assertId(req.params.id!);
  const dir = sub(id, 'exports');
  await fsp.mkdir(dir, { recursive: true });
  if (process.platform === 'darwin') await runOk('open', [dir]).catch(() => undefined);
  sendJson(res, 200, { path: dir });
});

// ---- ジョブ ----

router.get('/api/jobs', (req, res) => sendJson(res, 200, listJobs(req.query.get('projectId') ?? undefined)));
router.get('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id!);
  if (!j) throw new HttpError(404, 'ジョブが見つかりません');
  sendJson(res, 200, j);
});
router.post('/api/jobs/:id/cancel', (req, res) => sendJson(res, 200, { ok: cancelJob(req.params.id!) }));
router.post('/api/jobs/:id/retry', (req, res) => {
  const j = retryJob(req.params.id!);
  if (!j) throw new HttpError(400, '再試行できません');
  sendJson(res, 200, j);
});

void readBody;
