import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Asset, JobInfo, Project, StylePreset, Timeline, Token, Transcript } from '../shared/types.js';
import { speechChunks, tokensFromChunks } from '../shared/chunks.js';
import { alignChunkTokens } from '../shared/align.js';
import { geminiTranscribe, listGeminiModels, resolveGeminiModel } from './asr/gemini.js';
import { anthropicKey, anthropicKeySource, geminiKey, geminiKeySource, setAnthropicKey, setGeminiKey } from './secrets.js';
import { aiAssign, videoShots, videoStrip } from './ai/assign.js';
import { outToSrc } from '../shared/timemap.js';
import { hintTerms, mergeHints } from '../shared/script.js';
import { adoptLocalFile, buildPreview, importUpload, removeAssetFiles } from './assets.js';
import { WhisperCppAdapter } from './asr/whisperCpp.js';
import { BUILD_INFO, PRESETS_FILE } from './config.js';
import { cleanupDir, exportBaseName, runExport, type CaptionImage } from './export.js';
import { createTtsDraft, defaultDraftsDir, exportCapcut, exportCapcutInto, renderTtsAudio, type CapcutCaptionImage, findSeed, listCapcutDrafts, parseDraft, readDraftTimeline, renderDraftAudio } from './capcut.js';
import { fontBytes, fontEntry, listFonts, missingChars, registerProjectFont, scanFonts } from './fonts.js';
import { readBody, readJson, Router, sendFile, sendJson } from './http.js';
import { cancelJob, enqueue, getJob, listJobs, retryJob } from './jobs.js';
import {
  analysisPath,
  asrWavPath,
  BROWSER_IMAGE_EXT,
  ensureEditedWav,
  loadAnalysis,
  readWav,
  loadSourcePcm,
  prepareNarration,
  proxyPath,
  renderEdited,
  sourceWavPath,
  thumbPath,
  writeWav,
} from './media.js';
import { downloadModel, isInstalled, listModels, MODELS, modelDef, modelPath, recommend, type ModelDef } from './models.js';
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

/** 起動確認(Mac アプリの起動処理が、すでに動いているかを調べるのに使う) */
router.get('/api/ping', (_req, res) => sendJson(res, 200, { app: 'tate-douga-maker', build: BUILD_INFO }));

router.get('/api/system', async (_req, res) => {
  const sys = await systemInfo(true);
  sendJson(res, 200, { system: sys, recommend: recommend(sys), models: listModels(), asrAvailable: asr.available(), build: BUILD_INFO });
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

// ---- 設定(APIキー) ----

router.get('/api/settings', (_req, res) => sendJson(res, 200, { geminiKeySource: geminiKeySource(), anthropicKeySource: anthropicKeySource() }));

function cleanKey(raw: unknown): string {
  // キーの形式は変わることがあるので、ヘッダーに使える文字かだけを確認する
  const k = String(raw ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (k && !/^[\x21-\x7e]{10,1000}$/.test(k)) throw new HttpError(400, 'APIキーに使えない文字(空白や全角文字など)が含まれています。コピーし直して貼り付けてください');
  return k;
}

router.put('/api/settings/anthropic-key', async (req, res) => {
  const body = await readJson<{ key?: string | null }>(req);
  const k = cleanKey(body.key);
  await setAnthropicKey(k || null);
  sendJson(res, 200, { anthropicKeySource: anthropicKeySource() });
});

// ---- Claude による素材の自動割り当て ----

router.post('/api/projects/:id/ai-assign', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ project: Project }>(req, 50 * 1024 * 1024);
  const project = body.project;
  if (!project || project.id !== id) throw new HttpError(400, 'プロジェクトが一致しません');
  if (!project.aiAssign?.consent) throw new HttpError(400, '素材の画像と文章を Claude API に送信することへの同意が必要です。');
  const apiKey = anthropicKey();
  if (!apiKey) throw new HttpError(400, 'Claude の APIキーが設定されていません。');
  const job = enqueue({
    type: 'ai-assign',
    label: 'Claude で素材を割り当て',
    projectId: id,
    queue: 'analysis',
    runner: (ctx) => aiAssign({ project, apiKey, signal: ctx.signal, progress: ctx.progress }),
  });
  sendJson(res, 200, job);
});

/** 動画の場面一覧(手で場面を選ぶとき用)。場面の検出に時間がかかることがあるのでジョブにする */
router.post('/api/projects/:id/shots', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ project: Project; assetId: string }>(req, 50 * 1024 * 1024);
  const project = body.project;
  if (!project || project.id !== id) throw new HttpError(400, 'プロジェクトが一致しません');
  const asset = project.assets.find((a) => a.id === body.assetId && a.status === 'ok');
  if (!asset || asset.kind !== 'video') throw new HttpError(400, '動画の素材を選んでください');
  const job = enqueue({
    type: 'shots',
    label: `${asset.name} の場面一覧`,
    projectId: id,
    queue: 'analysis',
    runner: async (ctx) => ({ assetId: asset.id, shots: await videoShots(project, asset, ctx.signal, ctx.progress) }),
  });
  sendJson(res, 200, job);
});

/** 動画の見取り図(等間隔のサムネイル) */
router.get('/api/projects/:id/strip/:assetId', async (req, res) => {
  const id = assertId(req.params.id!);
  const p = await loadProject(id);
  const asset = p.assets.find((a) => a.id === req.params.assetId && a.status === 'ok');
  if (!asset || asset.kind !== 'video') throw new HttpError(404, '動画の素材が見つかりません');
  const n = Math.max(4, Math.min(24, Number(req.query.get('n') ?? 12) || 12));
  sendJson(res, 200, await videoStrip(p, asset, n, new AbortController().signal));
});

router.get('/api/projects/:id/aiframes/:name', async (req, res) => {
  const id = assertId(req.params.id!);
  const name = req.params.name!;
  if (!/^[A-Za-z0-9_-]+-[0-9.]+\.jpg$/.test(name)) throw new HttpError(400, 'ファイル名が正しくありません');
  const file = sub(id, 'work', 'aiframes', name);
  if (!fs.existsSync(file)) throw new HttpError(404, '画像がありません');
  await sendFile(req, res, file, { type: 'image/jpeg' });
});

router.put('/api/settings/gemini-key', async (req, res) => {
  const body = await readJson<{ key?: string | null }>(req);
  // キーの形式は変わることがある(AIza… / AQ.… など)ので、ヘッダーに使える文字かだけを確認する
  const k = (body.key ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (k && !/^[\x21-\x7e]{10,1000}$/.test(k)) throw new HttpError(400, 'APIキーに使えない文字(空白や全角文字など)が含まれています。コピーし直して貼り付けてください');
  await setGeminiKey(k || null);
  sendJson(res, 200, { geminiKeySource: geminiKeySource() });
});

router.get('/api/gemini/models', async (_req, res) => {
  const k = geminiKey();
  if (!k) throw new HttpError(400, 'Gemini の APIキーが設定されていません');
  sendJson(res, 200, await listGeminiModels(k));
});

type TranscribeBody = {
  sourceKey: string;
  engine?: 'whisper' | 'gemini';
  modelId: string;
  geminiModel?: string;
  cloudConsent?: boolean;
  sensitivityDb?: number;
  dtw: boolean;
  script?: string;
  useHints?: boolean;
  /** 利用者が直した語(認識のヒントにする) */
  extraHints?: string[];
  basis?: 'source' | 'edited';
  timeline?: Timeline;
};

async function transcribeWithGemini(id: string, body: TranscribeBody): Promise<JobInfo> {
  const key = assertId(body.sourceKey);
  const apiKey = geminiKey();
  if (!apiKey) throw new HttpError(400, 'Gemini の APIキーが設定されていません。「自動編集」の画面で設定してください。');
  if (body.cloudConsent !== true) throw new HttpError(400, '音声を Gemini に送信することへの同意が必要です。');
  let model: string;
  try {
    model = await resolveGeminiModel(String(body.geminiModel || 'auto'), apiKey);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  const hints = mergeHints(body.extraHints, body.useHints && body.script ? hintTerms(body.script) : []);
  const sens = Number(body.sensitivityDb ?? 0) || 0;
  const cacheKey = crypto.createHash('sha1').update(JSON.stringify(['gemini', key, model, hints, sens, 1])).digest('hex').slice(0, 20);
  const cacheFile = sub(id, 'cache', `asr-${cacheKey}.json`);
  return enqueue({
    type: 'transcribe',
    label: `文字起こし (Gemini: ${model})`,
    projectId: id,
    queue: 'analysis',
    runner: async (ctx) => {
      // ローカルの whisper があれば、Gemini の文字を whisper の時刻に合わせる(テロップのずれ防止)
      const alignDef = whisperForAlignment(body.modelId);
      const gp = (p: number, m?: string) => ctx.progress(alignDef ? p * 0.7 : p, m ?? '');
      if (fs.existsSync(cacheFile)) {
        gp(1, '前回の認識結果を再利用しました');
        const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8')) as Transcript;
        return { transcript: await alignWithWhisper(id, key, cached, alignDef, !!body.dtw, ctx), cached: true };
      }
      gp(0.02, '音声を無音で区切っています');
      const analysis = await loadAnalysis(id, key);
      const chunks = speechChunks(analysis, sens);
      if (chunks.length === 0) throw new Error('発話のある区間が見つかりませんでした。');
      const pcm = await readWav(asrWavPath(id, key));
      const r = await geminiTranscribe({ pcm16k: pcm.data, chunks, model, apiKey, hints, signal: ctx.signal, progress: gp });
      const tokens = tokensFromChunks(chunks, r.texts);
      const notes = [
        `Gemini (${model}) で ${chunks.length} 個の音声片を書き起こしました。`,
        '時刻は無音で区切った音声片の境目(音量解析)を使い、音声片の中は文字量で推定しています。',
      ];
      if (r.missing.length) notes.push(`${r.missing.length} 個の音声片の結果が返りませんでした(該当箇所はテロップなし)。`);
      if (hints.length) notes.push(`台本から認識ヒントを使用: ${hints.join('、')}`);
      const transcript: Transcript = { engine: 'gemini', model, createdAt: new Date().toISOString(), basis: 'source', tokens, notes };
      await atomicWrite(cacheFile, JSON.stringify(transcript));
      return { transcript: await alignWithWhisper(id, key, transcript, alignDef, !!body.dtw, ctx), cached: false };
    },
  });
}

/** 時刻合わせに使う whisper モデル(導入済みのもの。なければ null) */
function whisperForAlignment(preferId: string | undefined): ModelDef | null {
  if (!asr.available()) return null;
  const prefer = preferId ? modelDef(preferId) : null;
  if (prefer && isInstalled(prefer)) return prefer;
  const order = ['large-v3-turbo-q5_0', 'large-v3-turbo', 'medium-q5_0', 'small-q5_1'];
  return order.map((m) => MODELS.find((d) => d.id === m)).find((d): d is ModelDef => !!d && isInstalled(d)) ?? null;
}

const ESTIMATE_NOTE = '時刻は無音で区切った音声片の境目(音量解析)を使い、音声片の中は文字量で推定しています。';

/**
 * Gemini の結果(音声片の中は文字量で推定した時刻)を、ローカルの whisper で求めた時刻に合わせる。
 * whisper の結果はキャッシュし、失敗しても推定時刻のまま続ける。
 */
async function alignWithWhisper(
  id: string,
  key: string,
  tr: Transcript,
  def: ModelDef | null,
  dtw: boolean,
  ctx: { signal: AbortSignal; progress: (p: number, m?: string) => void },
): Promise<Transcript> {
  const base = tr.notes.filter((n) => n !== ESTIMATE_NOTE && !n.startsWith('whisper'));
  if (!def) {
    return { ...tr, notes: [...base, ESTIMATE_NOTE, 'whisper(ローカル)のモデルを1つ入れておくと、テロップの時刻を声に正確に合わせられます(音声は外部に送られません)。'] };
  }
  try {
    const cacheKey = crypto
      .createHash('sha1')
      .update(JSON.stringify([key, def.id, dtw, '', 'source', '']))
      .digest('hex')
      .slice(0, 20);
    const cacheFile = sub(id, 'cache', `asr-${cacheKey}.json`);
    let timed: Token[];
    if (fs.existsSync(cacheFile)) {
      timed = (JSON.parse(await fsp.readFile(cacheFile, 'utf8')) as Transcript).tokens;
    } else {
      ctx.progress(0.7, `テロップの時刻を合わせています(whisper ${def.label})`);
      const r = await asr.transcribe({
        wavPath: asrWavPath(id, key),
        language: 'ja',
        modelPath: modelPath(def),
        ...(dtw ? { dtwPreset: def.dtw } : {}),
        workDir: sub(id, 'work'),
        signal: ctx.signal,
        progress: (p, m) => ctx.progress(0.7 + p * 0.29, `時刻合わせ: ${m ?? ''}`),
      });
      const w: Transcript = { engine: asr.name, model: def.id, createdAt: new Date().toISOString(), basis: 'source', tokens: r.tokens, notes: r.notes };
      await atomicWrite(cacheFile, JSON.stringify(w));
      timed = r.tokens;
    }
    const { tokens, stats } = alignChunkTokens(tr.tokens, timed);
    const note =
      stats.aligned > 0
        ? `whisper (${def.label}) の時刻に合わせました(${stats.groups} 個中 ${stats.aligned} 個の音声片、一致した文字 ${Math.round(stats.matchRate * 100)}%)。`
        : `whisper (${def.label}) の結果と文字がほとんど一致しなかったため、推定時刻のままです。`;
    return { ...tr, tokens, notes: stats.aligned < stats.groups ? [...base, ESTIMATE_NOTE, note] : [...base, note] };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { ...tr, notes: [...base, ESTIMATE_NOTE, `whisper での時刻合わせに失敗したため、推定時刻のままです: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

router.post('/api/projects/:id/transcribe', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<TranscribeBody>(req);
  if (body.engine === 'gemini') return sendJson(res, 200, await transcribeWithGemini(id, body));
  const key = assertId(body.sourceKey);
  const def = modelDef(body.modelId);
  if (!def) throw new HttpError(400, 'モデルが正しくありません');
  if (!isInstalled(def)) throw new HttpError(409, `モデル「${def.label}」がまだ導入されていません。先にダウンロードしてください。`);
  if (!asr.available()) requireTool('whisper');
  const hints = mergeHints(body.extraHints, body.useHints && body.script ? hintTerms(body.script) : []);
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

/** CapCut の下書きフォルダの状態(見つかるか・見本にするプロジェクトの版) */
router.get('/api/capcut', (req, res) => {
  const dir = (req.query.get('dir') ?? '').trim() || defaultDraftsDir();
  const exists = fs.existsSync(dir);
  const f = exists ? findSeed(dir) : { seed: null, projects: 0, unreadable: 0 };
  sendJson(res, 200, { dir, defaultDir: defaultDraftsDir(), exists, projects: f.projects, version: f.seed?.version ?? null });
});

router.post('/api/projects/:id/capcut', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ project: Project; captions?: { outStart: number; outEnd: number; png: string; x: number; y: number; w: number; h: number }[] }>(req, 200 * 1024 * 1024);
  const project = body.project;
  // テロップを画像で入れるときは、画面で描いたテロップ画像を受け取る
  const workDir = sub(id, 'work', `capcut-${crypto.randomBytes(5).toString('hex')}`);
  const capImages: CapcutCaptionImage[] = [];
  if (Array.isArray(body.captions) && body.captions.length) {
    await fsp.mkdir(workDir, { recursive: true });
    for (let i = 0; i < body.captions.length; i++) {
      const c = body.captions[i]!;
      const m = /^data:image\/png;base64,(.+)$/.exec(c.png);
      if (!m) continue;
      const file = path.join(workDir, `テロップ${String(i + 1).padStart(3, '0')}.png`);
      await fsp.writeFile(file, Buffer.from(m[1]!, 'base64'));
      capImages.push({ outStart: Math.round(c.outStart), outEnd: Math.round(c.outEnd), file, x: c.x, y: c.y, w: c.w, h: c.h });
    }
  }
  if (!project || project.id !== id) throw new HttpError(400, 'プロジェクトが一致しません');
  if (!project.narration) throw new HttpError(400, 'ナレーション音声を設定してください');
  const dir = (project.export.capcutDir ?? '').trim() || defaultDraftsDir();
  if (!path.isAbsolute(dir)) throw new HttpError(400, 'CapCut の下書きフォルダは絶対パスで指定してください');
  const job = enqueue({
    type: 'capcut',
    label: 'CapCut のプロジェクトに書き出し',
    projectId: id,
    queue: 'export',
    // CapCut から読み込んだプロジェクトは、元の下書きに素材を加えた複製を作る
    runner: (ctx) => (project.capcut ? exportCapcutInto(project, dir, ctx) : exportCapcut(project, dir, ctx, capImages)),
    cleanup: cleanupDir(workDir),
  });
  sendJson(res, 200, job);
});

/** 台本から、CapCut で読み上げるための下書きを作る */
router.post('/api/projects/:id/capcut-tts', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ project: Project; lines: string[] }>(req, 5 * 1024 * 1024);
  const project = body.project;
  if (!project || project.id !== id) throw new HttpError(400, 'プロジェクトが一致しません');
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l) => String(l).trim()).filter(Boolean).slice(0, 500);
  if (!lines.length) throw new HttpError(400, '台本がありません');
  const dir = (project.export.capcutDir ?? '').trim() || defaultDraftsDir();
  if (!path.isAbsolute(dir)) throw new HttpError(400, 'CapCut の下書きフォルダは絶対パスで指定してください');
  const job = enqueue({ type: 'capcut-tts', label: 'CapCut の読み上げ用プロジェクトを作成', projectId: id, queue: 'export', runner: (ctx) => createTtsDraft(project, lines, dir, ctx) });
  sendJson(res, 200, job);
});

/** CapCut で読み上げた音声を読み込む(行ごとの音声をつなげて素材に追加) */
router.post('/api/projects/:id/capcut-tts-import', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ draftDir: string }>(req, 64 * 1024);
  const draftDir = String(body.draftDir ?? '');
  if (!path.isAbsolute(draftDir) || !fs.existsSync(draftDir)) throw new HttpError(400, '読み上げ用の CapCut プロジェクトが見つかりません(CapCut で削除や名前の変更をしていないか確認してください)');
  const t = readDraftTimeline(draftDir);
  if (!t) throw new HttpError(400, 'この CapCut のプロジェクトは読み取れませんでした(暗号化されている可能性があります)');
  const job = enqueue({
    type: 'capcut-tts-import',
    label: 'CapCut の読み上げ音声を読み込み',
    projectId: id,
    queue: 'export',
    runner: async (ctx) => {
      const tmp = path.join(os.tmpdir(), `tdm-tts-${crypto.randomBytes(4).toString('hex')}.wav`);
      const r = await renderTtsAudio(t.draft, draftDir, tmp, ctx);
      const asset = await adoptLocalFile(id, tmp, `読み上げ(CapCut).wav`);
      ctx.progress(1, '完了');
      return { asset, lines: r.lines, notes: r.notes };
    },
  });
  sendJson(res, 200, job);
});

/** CapCut の下書きの一覧(読み込み用) */
router.get('/api/capcut/drafts', (req, res) => {
  const dir = (req.query.get('dir') ?? '').trim() || defaultDraftsDir();
  sendJson(res, 200, { dir, drafts: fs.existsSync(dir) ? listCapcutDrafts(dir) : [] });
});

/** CapCut の下書きから、音声(1本の WAV にして素材に追加)とテロップを読み込む */
router.post('/api/projects/:id/capcut-import', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ draftDir: string }>(req, 64 * 1024);
  const draftDir = String(body.draftDir ?? '');
  if (!path.isAbsolute(draftDir) || !fs.existsSync(draftDir)) throw new HttpError(400, 'CapCut のプロジェクトが見つかりません');
  const t = readDraftTimeline(draftDir);
  if (!t) throw new HttpError(400, 'この CapCut のプロジェクトは読み取れませんでした(暗号化されている可能性があります)');
  const job = enqueue({
    type: 'capcut-import',
    label: 'CapCut のプロジェクトを読み込み',
    projectId: id,
    queue: 'export',
    runner: async (ctx) => {
      const d = parseDraft(t.draft, draftDir);
      if (d.audio.length === 0) throw new Error('この CapCut のプロジェクトには音声がありません。');
      const tmp = path.join(os.tmpdir(), `tdm-capcut-${crypto.randomBytes(4).toString('hex')}.wav`);
      const notes = await renderDraftAudio(d, tmp, ctx);
      const asset = await adoptLocalFile(id, tmp, `${d.name}(CapCut の音声).wav`);
      ctx.progress(1, '完了');
      return { asset, captions: d.captions, width: d.width, height: d.height, fps: d.fps, draft: { dir: draftDir, name: d.name, id: d.id, mtime: t.mtime }, notes };
    },
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
