// 画面から呼ぶ操作(取り込み・自動編集・シーン/テロップ編集・書き出し)。
import { SR, type AnalysisData, type Asset, type BgPlacement, type Caption, type JobInfo, type Project, type Scene, type Token, type Transcript } from '../shared/types.js';
import { parseReferenceTable } from '../shared/reference.js';
import { levelStats } from '../shared/silence.js';
import { speakWeight, splitJaText } from '../shared/chunks.js';
import { autoEdit, ensureTimelineSpeeds, markCaptionReview, normalizeScenes, recomputeCut, splitScenesToCutLength, timelineOf } from '../shared/project.js';
import { captionOutputTimings, newId, sceneOutputRanges } from '../shared/segment.js';
import { autoMotions } from '../shared/motion.js';
import { drawCaption, effectiveStyle, layoutCaption } from '../shared/captionRender.js';
import { displayFromRaw } from '../shared/jatext.js';
import { applyTextFixes } from '../shared/script.js';
import { outToSrc, srcToOut } from '../shared/timemap.js';
import { api } from './api.js';
import { toast } from './dom.js';
import { ensureFont, fontError, fontInfo, fontState, renderFontFor } from './fonts.js';
import { store } from './state.js';

// シーンの速さや境界を変えたら、時間対応表を自動で作り直す
store.normalize = (p) => (store.state.analysis ? ensureTimelineSpeeds(p, store.state.analysis) : p);

// ---- ジョブの監視 ----

const jobHandlers = new Map<string, (j: JobInfo) => void>();
let polling = false;

export function watchJob(job: JobInfo, onDone?: (j: JobInfo) => void) {
  if (onDone) jobHandlers.set(job.id, onDone);
  const list = store.state.jobs.filter((j) => j.id !== job.id);
  store.state.jobs = [...list, job];
  store.emit('jobs');
  void poll();
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const active = store.state.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
      if (active.length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
      const fresh = await api.jobs().catch(() => null);
      if (!fresh) continue;
      const byId = new Map(fresh.map((j) => [j.id, j]));
      store.state.jobs = store.state.jobs.map((j) => byId.get(j.id) ?? j);
      for (const j of store.state.jobs) {
        if (j.status !== 'queued' && j.status !== 'running' && jobHandlers.has(j.id)) {
          const h = jobHandlers.get(j.id)!;
          jobHandlers.delete(j.id);
          try {
            h(j);
          } catch (e) {
            console.error(e);
          }
        }
      }
      store.emit('jobs');
    }
  } finally {
    polling = false;
  }
}

function jobPromise(job: JobInfo): Promise<JobInfo> {
  return new Promise((resolve) => watchJob(job, resolve));
}

export async function cancelJob(id: string) {
  await api.cancelJob(id);
  void poll();
}

// ---- 素材 ----

export let previewVersion = 0;

// ---- 素材ライブラリ ----

export const libraryState: { items: Asset[] | null; loading: boolean } = { items: null, loading: false };

export async function loadLibrary(): Promise<void> {
  if (libraryState.loading) return;
  libraryState.loading = true;
  try {
    libraryState.items = (await api.library()).assets;
  } catch {
    libraryState.items = [];
  } finally {
    libraryState.loading = false;
    store.emit('right');
    store.emit('left');
  }
}

function watchPreview(name: string, jobId: string | null) {
  if (!jobId) return;
  watchJob({ id: jobId, type: 'preview', label: `${name} のプレビュー作成`, status: 'queued', progress: 0, message: '', createdAt: '' }, (j) => {
    previewVersion++;
    if (j.status === 'failed') toast(`${name} のプレビューを作れませんでした: ${j.error}`, 'error');
    store.emit('preview');
  });
}

/** ライブラリの素材をこのプロジェクトで使えるようにする(コピーはしない) */
export function addFromLibrary(assets: Asset[]) {
  const have = new Set(store.p.assets.map((a) => a.id));
  const add = assets.filter((a) => !have.has(a.id));
  if (!add.length) return;
  store.commit((pp) => ({ ...pp, assets: [...pp.assets, ...add] }));
  void store.save();
}

function afterLibraryAdd(items: { asset: Asset; existing: boolean; jobId: string | null }[]) {
  for (const it of items) {
    if (it.asset.status === 'error') toast(`${it.asset.name}: ${it.asset.error}`, 'error');
    watchPreview(it.asset.name, it.jobId);
  }
  addFromLibrary(items.map((x) => x.asset).filter((a) => a.status === 'ok'));
  void loadLibrary();
}

/** 取り込み: 音声・動画・画像は素材ライブラリへ(1回だけ保存し、どのプロジェクトからも使える)。フォントはプロジェクトへ */
export async function importFiles(files: File[]) {
  const p = store.p;
  for (const f of files) {
    try {
      toast(`取り込み中: ${f.name}`);
      if (/\.(ttf|otf|ttc)$/i.test(f.name)) {
        const { asset } = await api.upload(p.id, f);
        store.commit((pp) => ({ ...pp, assets: [...pp.assets, asset] }));
        if (asset.status === 'error') toast(`${f.name}: ${asset.error}`, 'error');
        store.state.fonts = await api.fonts();
        store.emit('fonts');
        continue;
      }
      const r = await api.libraryUpload(f);
      if (r.existing) toast(`${f.name} はライブラリにあるので、それを使います(もう一度保存はしません)`);
      for (const w of r.asset.warnings) toast(`${f.name}: ${w}`);
      afterLibraryAdd([r]);
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`, 'error');
    }
  }
  await store.save();
}

/** Mac のファイル選択画面で選んだファイル・フォルダを、コピーせずに使う */
export async function pickIntoLibrary(mode: 'files' | 'folder') {
  try {
    const r = await api.libraryPick(mode);
    if (!r.items.length) return;
    afterLibraryAdd(r.items);
    toast(`${r.items.length} 個の素材を追加しました(元の場所のファイルを使います。コピーはしません)`, 'ok');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** CapCut のプロジェクトで使っている素材を、コピーせずに使う */
export async function linkIntoLibrary(paths: string[]) {
  try {
    const r = await api.libraryLink(paths);
    afterLibraryAdd(r.items);
    toast(`${r.items.length} 個の素材を追加しました(CapCut と同じファイルを使います。コピーはしません)`, 'ok');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** このプロジェクトにコピーしてある素材を、素材ライブラリに移す(ほかのプロジェクトでも使え、同じ素材の重複を消す) */
export async function moveAssetsToLibrary() {
  const p = store.p;
  const n = p.assets.filter((a) => !a.library && a.status === 'ok' && a.kind !== 'font').length;
  if (!n) return toast('ライブラリに移す素材はありません');
  if (!confirm(`このプロジェクトの素材 ${n} 個を素材ライブラリに移します(同じ素材がライブラリにあれば重複分を削除します)。続けますか?`)) return;
  await store.save();
  try {
    const r = await api.assetsToLibrary(p.id);
    const m = r.map;
    const id = (x: string) => m[x]?.id ?? x;
    store.commit((pp) => ({
      ...pp,
      assets: pp.assets.reduce<Asset[]>((acc, a) => {
        const nx = m[a.id] ?? a;
        if (!acc.some((x) => x.id === nx.id)) acc.push(nx);
        return acc;
      }, []),
      narration: pp.narration ? { ...pp.narration, assetId: id(pp.narration.assetId) } : null,
      bgm: pp.bgm ? { ...pp.bgm, assetId: id(pp.bgm.assetId) } : null,
      scenes: pp.scenes.map((s) => ({
        ...s,
        bg: s.bg ? { ...s.bg, assetId: id(s.bg.assetId) } : null,
        inset: s.inset ? { ...s.inset, assetId: id(s.inset.assetId) } : null,
        ...(s.aiAlternatives ? { aiAlternatives: s.aiAlternatives.map((x) => ({ ...x, assetId: id(x.assetId) })) } : {}),
      })),
      aiAssign: { ...pp.aiAssign, assetIds: pp.aiAssign.assetIds.map(id) },
    }));
    await store.save();
    previewVersion++;
    await loadLibrary();
    toast(`${Object.keys(m).length} 個の素材をライブラリに移しました${r.freedBytes ? `(重複分 ${(r.freedBytes / 1024 / 1024).toFixed(0)}MB を削除)` : ''}`, 'ok');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function deleteFromLibrary(a: Asset) {
  if (!confirm(`「${a.name}」を素材ライブラリから削除しますか?\n${a.linked ? '元の場所のファイルは消えません。' : '取り込んだファイルも消えます。'}この素材を使っているプロジェクトや CapCut に書き出したプロジェクトでは表示されなくなります。`)) return;
  await api.libraryDelete(a.id);
  store.commit((pp) => ({ ...pp, assets: pp.assets.filter((x) => x.id !== a.id), scenes: pp.scenes.map((s) => ({ ...s, bg: s.bg?.assetId === a.id ? null : s.bg, inset: s.inset?.assetId === a.id ? null : s.inset })) }));
  await loadLibrary();
}

export async function removeAsset(asset: Asset) {
  const p = store.p;
  const used = p.scenes.some((s) => s.bg?.assetId === asset.id || s.inset?.assetId === asset.id) || p.bgm?.assetId === asset.id || p.narration?.assetId === asset.id;
  if (used && !confirm(`「${asset.name}」はシーン・BGM・ナレーションで使われています。削除すると割り当ても外れます。削除しますか?`)) return;
  if (!used && !confirm(asset.library ? `「${asset.name}」をこのプロジェクトから外しますか?(素材ライブラリには残ります)` : `「${asset.name}」をプロジェクトから削除しますか?(元のファイルは消えません)`)) return;
  store.commit((pp) => ({
    ...pp,
    assets: pp.assets.filter((a) => a.id !== asset.id),
    scenes: pp.scenes.map((s) => ({ ...s, bg: s.bg?.assetId === asset.id ? null : s.bg, inset: s.inset?.assetId === asset.id ? null : s.inset })),
    bgm: pp.bgm?.assetId === asset.id ? null : pp.bgm,
  }));
  await store.save();
  if (asset.id !== p.narration?.assetId && !asset.library) await api.deleteAsset(p.id, asset).catch(() => undefined);
}

export function defaultBg(asset: Asset, p: Project): BgPlacement {
  return {
    assetId: asset.id,
    fit: 'cover',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    startSec: 0,
    shortMode: 'freeze',
    mode: asset.kind === 'video' && p.narration?.assetId === asset.id ? 'synced' : 'independent',
    audio: false,
    volumeDb: 0,
    kenBurns: false,
  };
}

/**
 * 画像をカットの映像の上に重ねる(商品画像・成分の説明など)。
 * 置く位置(画面上の比 0..1)を指定しなければ、テロップと重なりにくい少し上に置く。大きさは画面に収まるように決める。
 */
export function placeOverlay(sceneId: string, assetId: string, at?: { x: number; y: number }) {
  const p = store.p;
  const asset = p.assets.find((a) => a.id === assetId);
  if (!asset || asset.kind !== 'image') return toast('映像の上に重ねられるのは画像です');
  const W = p.export.width;
  const H = p.export.height;
  const aw = asset.width ?? 1;
  const ah = asset.height ?? 1;
  // 横は画面の85%まで、縦は画面の55%まで
  const width = Math.round(Math.min(0.85, (0.55 * H * aw) / ah / W) * 1000) / 1000;
  const hRatio = (width * W * ah) / aw / H;
  const clamp = (v: number, half: number) => Math.round(Math.max(half, Math.min(1 - half, v)) * 1000) / 1000;
  const x = clamp(at?.x ?? 0.5, width / 2);
  const y = clamp(at?.y ?? 0.42, hRatio / 2);
  store.commit((pp) => ({ ...pp, scenes: pp.scenes.map((s) => (s.id === sceneId ? { ...s, inset: { assetId, x, y, width, startSec: 0, endSec: null } } : s)) }));
  store.setUi({ selection: { kind: 'scene', id: sceneId }, rightTab: 'selected' }, 'select');
}

export function assignBg(sceneId: string, assetId: string) {
  const asset = store.p.assets.find((a) => a.id === assetId);
  if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) return toast('背景には画像か動画を割り当ててください');
  store.commit((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === sceneId ? { ...s, bg: defaultBg(asset, p), aiNote: undefined } : s)) }));
}

/** 選択した素材を、選択中のシーンから順番に仮配置する(内容は判断しない) */
export function assignInOrder(assetIds: string[]) {
  const p = store.p;
  const assets = assetIds.map((id) => p.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a && (a.kind === 'image' || a.kind === 'video'));
  if (assets.length === 0) return toast('画像か動画を選択してください');
  const sel = store.state.ui.selection;
  let startIdx = sel?.kind === 'scene' ? p.scenes.findIndex((s) => s.id === sel.id) : 0;
  if (startIdx < 0) startIdx = 0;
  store.commit((pp) => ({
    ...pp,
    scenes: pp.scenes.map((s, i) => {
      const k = i - startIdx;
      if (k < 0 || k >= assets.length) return s;
      return { ...s, bg: defaultBg(assets[k]!, pp) };
    }),
  }));
  toast(`${Math.min(assets.length, p.scenes.length - startIdx)}個のシーンに選択順で配置しました`, 'ok');
}

// ---- ナレーション ----

export async function setNarration(asset: Asset, audioIndex: number) {
  const p = store.p;
  if ((p.captions.length > 0 || p.transcript) && p.narration?.assetId !== asset.id) {
    if (!confirm('ナレーションを変更すると、文字起こし・テロップ・シーンの時刻は作り直しになります。続けますか?')) return;
  }
  const job = await api.prepareNarration(p.id, asset, audioIndex);
  const done = await jobPromise(job);
  if (done.status !== 'done') {
    if (done.status === 'failed') toast('音声の準備に失敗しました: ' + done.error, 'error');
    return;
  }
  const narration = (done.result as { narration: Project['narration'] }).narration!;
  const analysis = await api.analysis(p.id, narration.sourceKey);
  store.state.analysis = analysis;
  const same = p.narration?.sourceKey === narration.sourceKey;
  store.commit((pp) => {
    let next: Project = { ...pp, narration };
    if (!same) {
      next = { ...next, transcript: null, captions: [], scenes: [{ id: newId('scn'), srcStart: 0, srcEnd: narration.durationSamples, bg: null, inset: null }], cut: { ...next.cut, keepRanges: [] } };
    }
    return recomputeCut(next, analysis);
  });
  for (const w of narration.warnings) toast(w, 'error');
  toast('ナレーションを設定しました。「2 自動編集」へ進んでください。', 'ok');
  await store.save();
}

export async function loadAnalysis() {
  const p = store.p;
  if (!p.narration) {
    store.state.analysis = null;
    return;
  }
  try {
    store.state.analysis = await api.analysis(p.id, p.narration.sourceKey);
  } catch {
    store.state.analysis = null;
    toast('音声の解析データが見つかりません。ナレーションを設定し直してください。', 'error');
  }
}

export function applyCutChange(fn: (p: Project) => Project, coalesce?: string) {
  const a = store.state.analysis;
  store.commit((p) => {
    const next = fn(p);
    if (!a) return next;
    const recut = recomputeCut(next, a);
    return { ...recut, captions: markCaptionReview(recut.captions, recut.timeline) };
  }, coalesce ? { coalesce } : {});
}

export function selectedModelId(): string | null {
  const sys = store.state.system;
  const p = store.p;
  if (p.asr.model) return p.asr.model;
  if (!sys) return null;
  return p.asr.quality === 'speed' ? sys.recommend.speed : sys.recommend.accuracy;
}

/** 文字起こし → カット → テロップ・シーン生成 */
export async function runAutoEdit(opts: { basis?: 'source' | 'edited' } = {}) {
  const p = store.p;
  const a = store.state.analysis;
  if (!p.narration || !a) return toast('先にナレーション音声を取り込んでください', 'error');
  const gemini = p.asr.engine === 'gemini';
  const modelId = selectedModelId();
  const model = store.state.system?.models.find((m) => m.id === modelId);
  if (gemini) {
    if (!p.asr.cloudConsent) return toast('音声を Gemini に送信することに同意してから実行してください', 'error');
    if (opts.basis === 'edited') return toast('Gemini では「編集後の音声で再認識」は使えません(もう一度「自動編集を実行」してください)', 'error');
  } else {
    if (!model) return toast('文字起こしモデルを選択してください', 'error');
    if (!model.installed) return toast(`モデル「${model.label}」をダウンロードしてから実行してください`, 'error');
  }
  await store.save();
  let job: JobInfo;
  try {
    job = await api.transcribe(p.id, {
      sourceKey: p.narration.sourceKey,
      engine: p.asr.engine,
      geminiModel: p.asr.geminiModel,
      cloudConsent: p.asr.cloudConsent,
      sensitivityDb: p.cut.params.sensitivityDb,
      modelId: model?.id ?? '',
      dtw: p.asr.dtw,
      script: p.script,
      useHints: p.useScriptHints,
      extraHints: (p.textFixes ?? []).map((f) => f.to),
      basis: opts.basis ?? 'source',
      ...(opts.basis === 'edited' && p.timeline ? { timeline: p.timeline } : {}),
    });
  } catch (e) {
    return toast((e as Error).message, 'error');
  }
  const done = await jobPromise(job);
  if (done.status !== 'done') {
    if (done.status === 'failed') toast('文字起こしに失敗しました: ' + done.error, 'error');
    return;
  }
  const { transcript } = done.result as { transcript: Transcript; cached: boolean };
  const usable = transcript.tokens.filter((t) => t.text.trim());
  store.commit((pp) => autoEdit({ ...pp, transcript }, store.state.analysis!, { keepManual: true }));
  const after = store.p;
  const flagged = after.transcript?.tokens.filter((t) => t.flags?.includes('silence')).length ?? 0;
  if (usable.length === 0) toast('音声から言葉を認識できませんでした。ナレーションの音声か、モデルを確認してください。', 'error');
  else toast(`自動編集が完了しました: テロップ ${after.captions.length}件 / シーン ${after.scenes.length}件${flagged ? ` / 無音区間の認識 ${flagged}語を除外` : ''}`, 'ok');
  store.setUi({ step: 3, rightTab: 'selected' });
}

export function rebuildCaptions(keepManual: boolean) {
  const a = store.state.analysis;
  if (!a || !store.p.transcript) return toast('先に自動編集(文字起こし)を実行してください');
  if (!keepManual && !confirm('手動で直したテロップも含めて作り直します。よろしいですか?(Undoで戻せます)')) return;
  store.commit((p) => autoEdit(keepManual ? p : { ...p, captions: [], scenes: p.scenes }, a, { keepManual }));
}

// ---- シーン ----

function tl() {
  return timelineOf(store.p);
}

export function splitSceneAt(t: number) {
  const timeline = tl();
  if (!timeline) return;
  const s = outToSrc(timeline, t);
  const p = store.p;
  const idx = p.scenes.findIndex((sc) => s > sc.srcStart && s < sc.srcEnd);
  if (idx < 0) return toast('再生位置がシーンの境界上です');
  const sc = p.scenes[idx]!;
  const o0 = srcToOut(timeline, sc.srcStart);
  const o1 = srcToOut(timeline, sc.srcEnd);
  if (t - o0 < 0.3 * SR || o1 - t < 0.3 * SR) return toast('シーンの端に近すぎます(0.3秒以上離してください)');
  const a: Scene = { ...sc, srcEnd: s, boundaryEdited: true };
  const b: Scene = { ...sc, id: newId('scn'), srcStart: s, boundaryEdited: true, bg: sc.bg ? { ...sc.bg } : null, inset: null };
  if (b.bg && b.bg.mode === 'independent') b.bg.startSec = sc.bg!.startSec + (t - o0) / SR;
  store.commit((pp) => ({ ...pp, scenes: [...pp.scenes.slice(0, idx), a, b, ...pp.scenes.slice(idx + 1)] }));
  store.setUi({ selection: { kind: 'scene', id: b.id } }, 'select');
}

export function mergeScene(id: string, dir: -1 | 1) {
  const p = store.p;
  const i = p.scenes.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.scenes.length) return;
  const [first, second] = dir < 0 ? [p.scenes[j]!, p.scenes[i]!] : [p.scenes[i]!, p.scenes[j]!];
  const merged: Scene = { ...first, srcEnd: second.srcEnd, bg: first.bg ?? second.bg, inset: first.inset ?? second.inset };
  const lo = Math.min(i, j);
  store.commit((pp) => ({ ...pp, scenes: normalizeScenes([...pp.scenes.slice(0, lo), merged, ...pp.scenes.slice(lo + 2)], tl()?.srcSamples ?? 0) }));
  store.setUi({ selection: { kind: 'scene', id: merged.id } }, 'select');
}

export function updateScene(id: string, fn: (s: Scene) => Scene, coalesce?: string) {
  store.commit((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === id ? fn(s) : s)) }), { coalesce: coalesce ?? `scene-${id}`, skip: 'right' });
}

// ---- テロップ ----

export function updateCaption(id: string, fn: (c: Caption) => Caption, coalesce?: string, skip = 'right') {
  store.commit((p) => ({ ...p, captions: p.captions.map((c) => (c.id === id ? fn(c) : c)) }), { coalesce: coalesce ?? `cap-${id}`, skip });
}

export function addCaptionAt(t: number) {
  const timeline = tl();
  if (!timeline) return toast('先にナレーション音声を取り込んでください');
  const end = Math.min(timeline.outSamples, t + 2 * SR);
  const cap: Caption = {
    id: newId('cap'),
    srcStart: outToSrc(timeline, t),
    srcEnd: outToSrc(timeline, end),
    tokenIds: [],
    rawText: '',
    text: 'テロップ',
    textEdited: true,
    timingEdited: true,
  };
  store.commit((p) => ({ ...p, captions: [...p.captions, cap].sort((a, b) => a.srcStart - b.srcStart) }));
  store.setUi({ selection: { kind: 'caption', id: cap.id }, rightTab: 'selected', step: 3 }, 'select');
}

export function deleteCaption(id: string) {
  store.commit((p) => ({ ...p, captions: p.captions.filter((c) => c.id !== id) }));
  store.setUi({ selection: null }, 'select');
}

/** テキストの位置でテロップを2つに分ける。時刻は近い語の境界で分ける */
export function splitCaption(id: string, charIndex: number) {
  const p = store.p;
  const cap = p.captions.find((c) => c.id === id);
  if (!cap) return;
  const chars = Array.from(cap.text);
  if (charIndex <= 0 || charIndex >= chars.length) return toast('分けたい位置にカーソルを置いてから押してください');
  const ratio = charIndex / chars.length;
  const toks = (p.transcript?.tokens ?? []).filter((t) => cap.tokenIds.includes(t.id));
  let splitSrc: number;
  let ids1 = cap.tokenIds;
  let ids2: string[] = [];
  if (toks.length >= 2) {
    let acc = 0;
    const total = toks.reduce((s, t) => s + Array.from(t.text.trim()).length, 0) || 1;
    let k = 1;
    let best = Infinity;
    let cum = 0;
    for (let i = 0; i < toks.length - 1; i++) {
      cum += Array.from(toks[i]!.text.trim()).length;
      const d = Math.abs(cum / total - ratio);
      if (d < best) {
        best = d;
        k = i + 1;
      }
    }
    void acc;
    splitSrc = toks[k]!.start;
    ids1 = toks.slice(0, k).map((t) => t.id);
    ids2 = toks.slice(k).map((t) => t.id);
  } else {
    splitSrc = Math.round(cap.srcStart + (cap.srcEnd - cap.srcStart) * ratio);
  }
  const t1 = chars.slice(0, charIndex).join('').trim();
  const t2 = chars.slice(charIndex).join('').trim();
  const raw1 = toks.length >= 2 ? toks.filter((t) => ids1.includes(t.id)).map((t) => t.text).join('') : cap.rawText;
  const raw2 = toks.length >= 2 ? toks.filter((t) => ids2.includes(t.id)).map((t) => t.text).join('') : '';
  const a: Caption = { ...cap, srcEnd: splitSrc, tokenIds: ids1, rawText: raw1, text: t1, textEdited: true };
  const b: Caption = { ...cap, id: newId('cap'), srcStart: splitSrc, tokenIds: ids2, rawText: raw2, text: t2, textEdited: true };
  store.commit((pp) => ({ ...pp, captions: pp.captions.flatMap((c) => (c.id === id ? [a, b] : [c])) }));
  store.setUi({ selection: { kind: 'caption', id: b.id } }, 'select');
}

/**
 * 続いている2つのテロップのつなぎ目を動かす。文章を手で直していなければ、つなぎ目の前後で語も入れ替える
 * (「〜ちゃう / 白玉肌」の区切りを1語ずらす、など)。
 */
export function moveCaptionJoint(aId: string, bId: string, at: number) {
  const p = store.p;
  const a = p.captions.find((c) => c.id === aId);
  const b = p.captions.find((c) => c.id === bId);
  if (!a || !b) return;
  // つなぎ目を動かすと2つはくっつく(隙間をなくす)。位置は語の切れ目に吸着させず自由に動かす
  const gap = 0;
  const minLen = 0.15 * SR;
  const s = Math.round(Math.max(a.srcStart + minLen + gap / 2, Math.min(b.srcEnd - minLen - gap / 2, at)));
  let na: Caption = { ...a, srcEnd: Math.round(s - gap / 2), timingEdited: true };
  let nb: Caption = { ...b, srcStart: Math.round(s + gap / 2), timingEdited: true };
  const ids = new Set([...a.tokenIds, ...b.tokenIds]);
  const toks = (p.transcript?.tokens ?? []).filter((t) => ids.has(t.id)).sort((x, y) => x.start - y.start);
  if (toks.length) {
    // 文字ごとの時刻(語の時間を文字数で割る)で、つなぎ目より前の文字を前のテロップ、後ろの文字を後ろのテロップにする
    const chars: { ch: string; mid: number; tok: string }[] = [];
    for (const t of toks) {
      const cs = Array.from(t.text);
      cs.forEach((ch, i) => chars.push({ ch, mid: t.start + ((t.end - t.start) * (i + 0.5)) / cs.length, tok: t.id }));
    }
    const visible = (i: number) => chars[i]!.ch.trim() !== '';
    let k = chars.findIndex((c) => c.mid >= s);
    if (k < 0) k = chars.length;
    // どちらにも1文字以上残す
    const firstVis = chars.findIndex((_, i) => visible(i));
    let lastVis = -1;
    for (let i = chars.length - 1; i >= 0; i--) if (visible(i)) { lastVis = i; break; }
    if (firstVis >= 0 && lastVis > firstVis) {
      k = Math.max(firstVis + 1, Math.min(lastVis, k));
      const ca = chars.slice(0, k);
      const cb = chars.slice(k);
      const rawA = ca.map((c) => c.ch).join('').replace(/^\s+/, '');
      const rawB = cb.map((c) => c.ch).join('').replace(/^\s+/, '');
      const textOf = (raw: string) => applyTextFixes(displayFromRaw(raw), p.textFixes);
      // 語の途中で分けたときは、その語は両方のテロップに属する
      const idsA = [...new Set(ca.map((c) => c.tok))];
      const idsB = [...new Set(cb.map((c) => c.tok))];
      na = { ...na, tokenIds: idsA, rawText: rawA, ...(a.textEdited ? {} : { text: textOf(rawA) }) };
      nb = { ...nb, tokenIds: idsB, rawText: rawB, ...(b.textEdited ? {} : { text: textOf(rawB) }) };
    }
  }
  store.commit((pp) => ({ ...pp, captions: pp.captions.map((c) => (c.id === aId ? na : c.id === bId ? nb : c)) }), { coalesce: `cap-joint-${aId}` });
}

export function mergeCaptionWithNext(id: string) {
  const p = store.p;
  const sorted = [...p.captions].sort((a, b) => a.srcStart - b.srcStart);
  const i = sorted.findIndex((c) => c.id === id);
  const a = sorted[i];
  const b = sorted[i + 1];
  if (!a || !b) return toast('次のテロップがありません');
  const merged: Caption = {
    ...a,
    srcEnd: Math.max(a.srcEnd, b.srcEnd),
    tokenIds: [...a.tokenIds, ...b.tokenIds],
    rawText: a.rawText + b.rawText,
    text: a.textEdited || b.textEdited ? `${a.text}${b.text}` : displayFromRaw(a.rawText + b.rawText),
    textEdited: a.textEdited || b.textEdited,
    timingEdited: a.timingEdited || b.timingEdited,
  };
  store.commit((pp) => ({ ...pp, captions: pp.captions.filter((c) => c.id !== b.id).map((c) => (c.id === a.id ? merged : c)) }));
}

// ---- 書き出し ----

export interface ExportCheck {
  errors: string[];
  warnings: string[];
}

export async function checkExport(): Promise<ExportCheck> {
  const p = store.p;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!p.narration) errors.push('ナレーション音声が設定されていません。');
  const sys = store.state.system;
  if (sys && !sys.system.tools.ffmpeg) errors.push('ffmpeg が見つかりません。');
  if (sys && sys.system.tools.ffmpeg && !sys.system.ffmpegHasX264) errors.push('ffmpeg に H.264 (libx264) エンコーダーがありません。Homebrew 版の ffmpeg を使ってください。');
  const fontIds = new Set<string>([p.style.fontId, ...p.captions.map((c) => c.style?.fontId).filter((x): x is string => !!x)]);
  for (const id of fontIds) {
    await ensureFont(id);
    if (fontState(id) !== 'loaded') errors.push(`フォントを読み込めません: ${fontInfo(id)?.fullName ?? id}(${fontError(id) ?? '不明な理由'})。別のフォントを選んでください。`);
    else if (fontInfo(id) && !fontInfo(id)!.hasJapanese) warnings.push(`フォント「${fontInfo(id)!.fullName}」は日本語の文字を含みません。`);
  }
  const items = p.captions.filter((c) => c.text.trim()).map((c) => ({ fontId: effectiveStyle(p.style, c).fontId, text: c.text }));
  if (items.length && errors.length === 0) {
    const res = await api.missingGlyphs(items);
    const miss = new Set<string>();
    res.forEach((r) => r.missing.forEach((m) => miss.add(m)));
    if (miss.size) errors.push(`フォントに無い文字があります: ${[...miss].join(' ')}  (代わりのフォントには置き換えません。文字を直すかフォントを変えてください)`);
  }
  const review = p.captions.filter((c) => c.review).length;
  if (review) warnings.push(`確認が必要なテロップが ${review} 件あります(タイムラインで黄色表示)。`);
  const t = timelineOf(p);
  if (t) {
    const ranges = sceneOutputRanges(p.scenes, t);
    const noBg = p.scenes.filter((s, i) => !s.bg && (ranges[i]?.outEnd ?? 0) > (ranges[i]?.outStart ?? 0)).length;
    if (noBg) warnings.push(`背景のないシーンが ${noBg} 件あります(単色背景で書き出します)。`);
  }
  if (p.captions.length === 0) warnings.push('テロップがありません。');
  return { errors, warnings };
}

export async function startExport(): Promise<void> {
  await store.save();
  const chk = await checkExport();
  if (chk.errors.length) {
    toast(chk.errors.join('\n'), 'error');
    return;
  }
  const p = JSON.parse(JSON.stringify(store.p)) as Project; // 開始時点の設定を固定
  const timeline = timelineOf(p)!;
  const timings = captionOutputTimings(p.captions, timeline);
  const W = p.export.width;
  const H = p.export.height;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const caps: { id: string; outStart: number; outEnd: number; text: string; png: string }[] = [];
  for (const t of timings) {
    const c = p.captions.find((x) => x.id === t.id)!;
    if (!c.text.trim()) continue;
    const style = effectiveStyle(p.style, c);
    const font = renderFontFor(style);
    if (!font) {
      toast('フォントの読み込みが終わっていません。少し待ってから再度お試しください。', 'error');
      return;
    }
    g.clearRect(0, 0, W, H);
    drawCaption(g, c.text, style, font, W, H);
    caps.push({ id: c.id, outStart: t.outStart, outEnd: t.outEnd, text: c.text, png: canvas.toDataURL('image/png') });
  }
  try {
    const job = await api.startExport(p.id, p, caps);
    watchJob(job, (j) => {
      if (j.status === 'done') toast('書き出しが完了しました', 'ok');
      else if (j.status === 'failed') toast('書き出しに失敗しました: ' + j.error, 'error');
      store.emit('exports');
    });
    toast('書き出しを開始しました(この間も編集できます。書き出しは開始時点の内容で行います)', 'ok');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/**
 * CapCut で作った下書き(無音カット・テロップ済み)から始める。
 * 音声は1本の WAV にしてナレーションに、テロップは CapCut のものをそのまま使い、カット割りを作る。
 */
export async function importFromCapcut(draftDir: string): Promise<void> {
  const p = store.p;
  if ((p.captions.length > 0 || p.transcript) && !confirm('今のテロップ・カットを、CapCut のプロジェクトのもので置き換えます(割り当てた素材は、同じ時間のカットに引き継ぎます)。続けますか?')) return;
  try {
    await store.save();
    const job = await api.capcutImport(p.id, draftDir);
    const done = await jobPromise(job);
    if (done.status !== 'done') {
      if (done.status === 'failed') toast('CapCut のプロジェクトを読み込めませんでした: ' + done.error, 'error', 10000);
      return;
    }
    const r = done.result as {
      asset: Asset;
      captions: { text: string; startUs: number; endUs: number }[];
      width: number;
      height: number;
      draft: { dir: string; name: string; id: string; mtime: number };
      notes: string[];
    };
    store.commit((pp) => ({ ...pp, assets: [...pp.assets, r.asset] }));
    const nj = await api.prepareNarration(p.id, r.asset, 0);
    const nd = await jobPromise(nj);
    if (nd.status !== 'done') {
      if (nd.status === 'failed') toast('音声の準備に失敗しました: ' + nd.error, 'error');
      return;
    }
    const narration = (nd.result as { narration: Project['narration'] }).narration!;
    const analysis = await api.analysis(p.id, narration.sourceKey);
    store.state.analysis = analysis;
    const toS = (us: number) => Math.max(0, Math.min(narration.durationSamples, Math.round((us / 1e6) * SR)));
    // テロップは CapCut のもの。台本の表どおりのカット割りなどに使えるよう、テロップごとに「語」も作る
    const tokens = r.captions.map((c, i) => ({ id: `cc${i}`, text: c.text.replace(/\s+/g, ''), start: toS(c.startUs), end: Math.max(toS(c.startUs) + 1, toS(c.endUs)), p: 1, seg: i, timing: 'token' as const }));
    const captions: Caption[] = r.captions.map((c, i) => ({
      id: newId('cap'),
      srcStart: tokens[i]!.start,
      srcEnd: tokens[i]!.end,
      tokenIds: [tokens[i]!.id],
      rawText: c.text,
      text: c.text,
      textEdited: true,
      timingEdited: true,
    }));
    store.commit((pp) => {
      const next: Project = {
        ...pp,
        narration,
        capcut: { dir: r.draft.dir, name: r.draft.name, draftId: r.draft.id, mtime: r.draft.mtime, importedAt: new Date().toISOString() },
        transcript: { engine: 'capcut', model: 'CapCut のテロップ', createdAt: new Date().toISOString(), basis: 'source', tokens, notes: [] },
        captions,
        scenes: pp.scenes.length ? pp.scenes : [{ id: newId('scn'), srcStart: 0, srcEnd: narration.durationSamples, bg: null, inset: null }],
        cut: { ...pp.cut, keepRanges: [] },
        export: { ...pp.export, width: r.width || pp.export.width, height: r.height || pp.export.height },
      };
      return autoEdit(next, analysis, { keepManual: false, recut: true });
    });
    await store.save();
    for (const n of r.notes) toast(n, 'error', 8000);
    toast(`CapCut の「${r.draft.name}」を読み込みました(テロップ ${captions.length} 個)。「2 自動編集」でカット割りと素材の割り当てをしてください。`, 'ok', 8000);
    store.setUi({ step: 2 });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** 台本の行(「台本 / 素材」の表を貼った場合は台本の列) */
export function scriptLines(p: Project): string[] {
  return parseReferenceTable(p.script).map((r) => r.line.trim()).filter(Boolean);
}

/** 台本から、CapCut で読み上げるための「読み上げ用」プロジェクトを作る */
export async function createCapcutTts(): Promise<void> {
  const p = store.p;
  const lines = scriptLines(p);
  if (!lines.length) return toast('先に台本を入れてください(1行が1つの読み上げになります)', 'error');
  try {
    await store.save();
    const job = await api.capcutTts(JSON.parse(JSON.stringify(p)) as Project, lines);
    const done = await jobPromise(job);
    if (done.status !== 'done') {
      if (done.status === 'failed') toast('読み上げ用のプロジェクトを作れませんでした: ' + done.error, 'error', 10000);
      return;
    }
    const r = done.result as { draftName: string; draftDir: string };
    // 「台本 / 素材」の表なら、素材の指定(参考)にも使う
    const rows = parseReferenceTable(p.script);
    const hasHints = rows.some((x) => x.hint);
    store.commit((pp) => ({
      ...pp,
      capcutTts: { dir: r.draftDir, name: r.draftName, createdAt: new Date().toISOString(), lines: lines.length },
      ...(hasHints && !pp.aiAssign.reference ? { aiAssign: { ...pp.aiAssign, reference: pp.script, useReference: true } } : {}),
    }));
    await store.save();
    toast(`CapCut に「${r.draftName}」を作りました。CapCut で開いて、文字クリップを全部選んで(⌘A)「テキスト読み上げ」で声を選び、CapCut を終了してから「読み上げた音声を読み込む」を押してください。`, 'ok', 15000);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** CapCut で読み上げた音声を読み込み、ナレーションにする(テロップの文章は台本の行) */
export async function importCapcutTts(): Promise<void> {
  const p = store.p;
  const tts = p.capcutTts;
  if (!tts) return;
  if ((p.captions.length > 0 || p.transcript) && !confirm('今のナレーション・テロップを、CapCut で読み上げた音声と台本で置き換えます(割り当てた素材は、同じ時間のカットに引き継ぎます)。続けますか?')) return;
  try {
    const job = await api.capcutTtsImport(p.id, tts.dir);
    const done = await jobPromise(job);
    if (done.status !== 'done') {
      if (done.status === 'failed') toast(String(done.error), 'error', 12000);
      return;
    }
    const r = done.result as { asset: Asset; lines: { text: string; startUs: number; endUs: number }[]; notes: string[] };
    store.commit((pp) => ({ ...pp, assets: [...pp.assets, r.asset] }));
    const nj = await api.prepareNarration(p.id, r.asset, 0);
    const nd = await jobPromise(nj);
    if (nd.status !== 'done') {
      if (nd.status === 'failed') toast('音声の準備に失敗しました: ' + nd.error, 'error');
      return;
    }
    const narration = (nd.result as { narration: Project['narration'] }).narration!;
    const analysis = await api.analysis(p.id, narration.sourceKey);
    store.state.analysis = analysis;
    const tokens = ttsTokens(r.lines, analysis, p.cut.params.sensitivityDb);
    store.commit((pp) => {
      const next: Project = {
        ...pp,
        narration,
        capcut: undefined,
        transcript: { engine: 'capcut-tts', model: 'CapCut の読み上げ(台本)', createdAt: new Date().toISOString(), basis: 'source', tokens, notes: [] },
        captions: [],
        scenes: [{ id: newId('scn'), srcStart: 0, srcEnd: narration.durationSamples, bg: null, inset: null }],
        cut: { ...pp.cut, keepRanges: [] },
      };
      return autoEdit(recomputeCut(next, analysis), analysis, { keepManual: false, recut: true });
    });
    await store.save();
    for (const n of r.notes) toast(n, 'error', 8000);
    toast(`読み上げ音声を読み込みました(${r.lines.length} 行)。無音カット・テロップ・カット割りを作りました。「2 自動編集」で詰め方や素材の割り当てを調整できます。`, 'ok', 8000);
    store.setUi({ step: 2 });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/**
 * 読み上げた行ごとに、語の時刻を推定する。
 * 行の中の句読点で区切った句と、行の中の声のまとまり(短い間で区切った区間)の数が同じなら句ごとに合わせ、
 * 違えば行の声の区間全体に文字量で配分する。
 */
function ttsTokens(lines: { text: string; startUs: number; endUs: number }[], a: AnalysisData, sensitivityDb: number): Token[] {
  const { threshold } = levelStats(a, sensitivityDb);
  const fs = a.frameSamples;
  const toS = (us: number) => Math.round((us / 1e6) * SR);
  const out: Token[] = [];
  lines.forEach((ln, li) => {
    const f0 = Math.floor(toS(ln.startUs) / fs);
    const f1 = Math.min(a.db.length, Math.ceil(toS(ln.endUs) / fs));
    // 声のある区間(100ms 未満の間はつなげる)
    const runs: { start: number; end: number }[] = [];
    for (let f = f0; f < f1; f++) {
      if (a.db[f]! < threshold) continue;
      const s = f * fs;
      const last = runs[runs.length - 1];
      if (last && s - last.end < 0.1 * SR) last.end = (f + 1) * fs;
      else runs.push({ start: s, end: (f + 1) * fs });
    }
    const voiced = runs.filter((r) => r.end - r.start > 0.05 * SR);
    if (!voiced.length) voiced.push({ start: toS(ln.startUs), end: Math.max(toS(ln.startUs) + 1, toS(ln.endUs)) });
    // 語を、声のある所だけに文字量で配分する(行の中の息継ぎの間には置かない)
    const total = voiced.reduce((acc, r) => acc + (r.end - r.start), 0);
    const at = (x: number) => {
      let rest = x * total;
      for (const r of voiced) {
        const len = r.end - r.start;
        if (rest <= len) return r.start + rest;
        rest -= len;
      }
      return voiced[voiced.length - 1]!.end;
    };
    const words = splitJaText(ln.text);
    const weights = words.map(speakWeight);
    const sum = weights.reduce((x, y) => x + y, 0) || 1;
    let acc = 0;
    words.forEach((w, wi) => {
      const st = Math.round(at(acc / sum));
      acc += weights[wi]!;
      const en = Math.round(at(acc / sum));
      out.push({ id: `t${li}-${wi}`, text: w, start: st, end: Math.max(st + 1, en), p: 0.9, seg: li, timing: 'chunk' });
    });
  });
  return out;
}

/** CapCut のプロジェクト(下書き)として書き出す */
export async function startCapcutExport(): Promise<void> {
  await store.save();
  const chk = await checkExport();
  if (chk.errors.length) {
    toast(chk.errors.join('\n'), 'error');
    return;
  }
  const p = JSON.parse(JSON.stringify(store.p)) as Project;
  // テロップを「見た目そのまま」で入れるときは、プレビューと同じ描き方で画像にする(テロップの所だけ切り出す)
  const caps: { outStart: number; outEnd: number; png: string; x: number; y: number; w: number; h: number }[] = [];
  if (!p.capcut && (p.export.capcutCaptions ?? 'image') === 'image') {
    const timeline = timelineOf(p)!;
    const W = p.export.width;
    const H = p.export.height;
    const full = document.createElement('canvas');
    full.width = W;
    full.height = H;
    const g = full.getContext('2d')!;
    const crop = document.createElement('canvas');
    for (const t of captionOutputTimings(p.captions, timeline)) {
      const c = p.captions.find((x) => x.id === t.id)!;
      if (!c.text.trim()) continue;
      const style = effectiveStyle(p.style, c);
      const font = renderFontFor(style);
      if (!font) {
        toast('フォントの読み込みが終わっていません。少し待ってから再度お試しください。', 'error');
        return;
      }
      g.clearRect(0, 0, W, H);
      const box = drawCaption(g, c.text, style, font, W, H);
      // 縁取り・影・帯の分だけ広げる
      const pad = Math.ceil(style.strokeWidth + (style.shadow ? style.shadowBlur + Math.abs(style.shadowOffsetY) : 0) + (style.band ? style.bandPadding : 0) + 8);
      const x = Math.max(0, Math.floor(box.x - pad));
      const y = Math.max(0, Math.floor(box.y - pad));
      const w = Math.min(W, Math.ceil(box.x + box.w + pad)) - x;
      const h = Math.min(H, Math.ceil(box.y + box.h + pad)) - y;
      if (w <= 0 || h <= 0) continue;
      crop.width = w;
      crop.height = h;
      const cg = crop.getContext('2d')!;
      cg.clearRect(0, 0, w, h);
      cg.drawImage(full, x, y, w, h, 0, 0, w, h);
      caps.push({ outStart: t.outStart, outEnd: t.outEnd, png: crop.toDataURL('image/png'), x, y, w, h });
    }
  }
  // 「CapCut で編集できる文字」: 折り返しの位置はこのアプリの見た目に合わせて送る
  const textLines: Record<string, string[]> = {};
  if (!p.capcut && p.export.capcutCaptions === 'text') {
    const g = document.createElement('canvas').getContext('2d')!;
    for (const c of p.captions) {
      if (!c.text.trim()) continue;
      const style = effectiveStyle(p.style, c);
      const font = renderFontFor(style);
      if (!font) continue;
      textLines[c.id] = layoutCaption(g, c.text.trim(), style, font, p.export.width, p.export.height).lines;
    }
  }
  try {
    const job = await api.startCapcut(p.id, p, caps, textLines);
    watchJob(job, (j) => {
      if (j.status === 'done') {
        const r = j.result as { draftName: string; appVersion: string; notes: string[] };
        toast(`CapCut に「${r.draftName}」を作りました。CapCut を起動するとプロジェクト一覧に表示されます。\n${r.notes.join('\n')}`, 'ok', 12000);
      } else if (j.status === 'failed') toast('CapCut への書き出しに失敗しました: ' + j.error, 'error', 10000);
    });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function downloadModel(id: string) {
  try {
    const job = await api.downloadModel(id);
    watchJob(job, async (j) => {
      if (j.status === 'done') toast('モデルのダウンロードが完了しました', 'ok');
      else if (j.status === 'failed') toast('ダウンロードに失敗しました: ' + j.error + '(再試行できます)', 'error');
      store.state.system = await api.system();
      store.emit('system');
    });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Claude に素材の割り当てを提案してもらい、シーンに反映する(元に戻す で取り消せる) */
export async function runAiAssign() {
  // カットが「1カットの長さ」より長ければ先に分ける(1カットのままだと素材が1つしか選ばれない)
  const before = store.p.scenes.length;
  store.commit((p) => splitScenesToCutLength(p));
  if (store.p.scenes.length !== before) toast(`カットを ${before} 個から ${store.p.scenes.length} 個に分けてから割り当てます`);
  await store.save();
  let job: JobInfo;
  try {
    job = await api.aiAssign(JSON.parse(JSON.stringify(store.p)) as Project);
  } catch (e) {
    return toast((e as Error).message, 'error');
  }
  const done = await jobPromise(job);
  if (done.status !== 'done') {
    if (done.status === 'failed') toast('素材の割り当てに失敗しました: ' + done.error, 'error');
    return;
  }
  const { assignments, notes } = done.result as {
    assignments: { sceneId: string; assetId: string; startSec: number; reason: string; alternatives?: { assetId: string; startSec: number; reason: string }[] }[];
    notes: string[];
  };
  const byScene = new Map(assignments.map((a) => [a.sceneId, a]));
  store.commit((p) => ({
    ...p,
    scenes: p.scenes.map((sc) => {
      const a = byScene.get(sc.id);
      const asset = a ? p.assets.find((x) => x.id === a.assetId) : undefined;
      if (!a || !asset) return sc;
      return { ...sc, bg: { ...defaultBg(asset, p), mode: 'independent', startSec: a.startSec }, aiNote: a.reason, aiAlternatives: a.alternatives ?? [] };
    }),
  }));
  // 割り当てと同じ操作で動きも付ける(1回の 元に戻す でまとめて取り消せるよう、履歴はまとめる)
  if (store.p.motionAuto !== false) store.commit((p) => withAutoMotions(p), { noHistory: true });
  toast(`Claude の提案で ${assignments.length} カットに素材を割り当てました(元に戻す で取り消せます)\n${notes.join('\n')}`, 'ok', 8000);
  store.setUi({ step: 3, leftTab: 'scenes' });
}

/** 無音候補の「この間は残す」を切り替える */
export function toggleKeepCandidate(candId: string) {
  const c = store.p.silenceCandidates.find((k) => k.id === candId);
  if (!c) return;
  store.setUi({ selectedCandidate: candId }, 'candidate');
  const kept = store.p.cut.keepRanges.some((k) => k.start < c.end && k.end > c.start);
  store.commit((p) => {
    const keepRanges = kept
      ? p.cut.keepRanges.filter((k) => !(k.start < c.end && k.end > c.start))
      : [...p.cut.keepRanges, { start: c.start + Math.floor((c.end - c.start) / 2) - 1, end: c.start + Math.floor((c.end - c.start) / 2) + 1 }];
    const next = { ...p, cut: { ...p.cut, keepRanges } };
    return store.state.analysis ? recomputeCut(next, store.state.analysis) : next;
  });
}

/** Claude が挙げたほかの候補に切り替える(今の素材は候補の最後に回すので、押し続けると一巡する) */
export function nextAlternative(sceneId: string) {
  store.commit((p) => ({
    ...p,
    scenes: p.scenes.map((s) => {
      if (s.id !== sceneId || !s.aiAlternatives?.length) return s;
      const [first, ...rest] = s.aiAlternatives;
      const asset = p.assets.find((a) => a.id === first!.assetId && a.status === 'ok');
      if (!asset) return { ...s, aiAlternatives: rest };
      const cur = s.bg ? [{ assetId: s.bg.assetId, startSec: s.bg.startSec, reason: s.aiNote ?? '' }] : [];
      const motion = s.bg?.motion;
      return { ...s, bg: { ...defaultBg(asset, p), mode: 'independent', startSec: first!.startSec, ...(motion ? { motion } : {}) }, aiNote: first!.reason, aiAlternatives: [...rest, ...cur] };
    }),
  }));
}

/** 動画の場面一覧(素材ごとにキャッシュ) */
export const shotCache = new Map<string, { start: number; end: number; frame: string }[] | 'loading'>();

export async function loadShots(assetId: string) {
  if (shotCache.has(assetId)) return;
  shotCache.set(assetId, 'loading');
  store.emit('right');
  try {
    const job = await api.shots(JSON.parse(JSON.stringify(store.p)) as Project, assetId);
    const done = await jobPromise(job);
    if (done.status === 'done') shotCache.set(assetId, (done.result as { shots: { start: number; end: number; frame: string }[] }).shots);
    else {
      shotCache.delete(assetId);
      if (done.status === 'failed') toast('場面の一覧を作れませんでした: ' + done.error, 'error');
    }
  } catch (e) {
    shotCache.delete(assetId);
    toast((e as Error).message, 'error');
  }
  store.emit('right');
}

/** 各カットで話している内容(カットの中央を含むテロップ) */
export function sceneTextOf(p: Project): (s: Scene) => string {
  const tl = timelineOf(p);
  if (!tl) return () => '';
  const ranges = new Map(sceneOutputRanges(p.scenes, tl).map((r) => [r.id, r]));
  const caps = captionOutputTimings(p.captions, tl);
  const byId = new Map(p.captions.map((c) => [c.id, c]));
  return (s) => {
    const r = ranges.get(s.id);
    if (!r) return '';
    return caps.filter((c) => c.outStart < r.outEnd && c.outEnd > r.outStart).map((c) => byId.get(c.id)?.text ?? '').join(' ');
  };
}

/** 背景のあるカットに、おまかせで動きを付ける */
export function withAutoMotions(p: Project): Project {
  const withBg = p.scenes.filter((s) => s.bg);
  const motions = autoMotions(withBg, sceneTextOf(p), p.motionStrength ?? 1);
  const byId = new Map(withBg.map((s, i) => [s.id, motions[i]!]));
  return { ...p, scenes: p.scenes.map((s) => (s.bg && byId.has(s.id) ? { ...s, bg: { ...s.bg, kenBurns: false, motion: byId.get(s.id)! } } : s)) };
}

export function applyAutoMotions() {
  if (!store.p.scenes.some((s) => s.bg)) return toast('先にカットに素材を割り当ててください');
  store.commit((p) => withAutoMotions(p));
  toast('各カットに動きを付けました(元に戻す で取り消せます)', 'ok');
}

export function clearMotions() {
  store.commit((p) => ({ ...p, scenes: p.scenes.map((s) => (s.bg ? { ...s, bg: { ...s.bg, kenBurns: false, motion: { type: 'none', strength: 1 } } } : s)) }));
}

/**
 * カット割り・テロップの長さの設定を変えて、その場で作り直す。
 * 文字起こし済みならテロップから作り直し、未実施ならカットの長さだけ合わせる。素材の割り当ては引き継ぐ。
 */
export function reapplyLayout(change: (p: Project) => Project) {
  const a = store.state.analysis;
  store.commit((p) => {
    const next = change(p);
    if (a && next.transcript) return autoEdit(next, a, { keepManual: true, recut: true });
    return splitScenesToCutLength(next);
  });
}
