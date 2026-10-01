// 画面から呼ぶ操作(取り込み・自動編集・シーン/テロップ編集・書き出し)。
import { SR, type Asset, type BgPlacement, type Caption, type JobInfo, type Project, type Scene, type Transcript } from '../shared/types.js';
import { autoEdit, ensureTimelineSpeeds, markCaptionReview, normalizeScenes, recomputeCut, splitScenesToCutLength, timelineOf } from '../shared/project.js';
import { captionOutputTimings, newId, sceneOutputRanges } from '../shared/segment.js';
import { autoMotions } from '../shared/motion.js';
import { drawCaption, effectiveStyle } from '../shared/captionRender.js';
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

export async function importFiles(files: File[]) {
  const p = store.p;
  for (const f of files) {
    try {
      toast(`取り込み中: ${f.name}`);
      const { asset, jobId } = await api.upload(p.id, f);
      store.commit((pp) => ({ ...pp, assets: [...pp.assets, asset] }));
      if (asset.status === 'error') toast(`${f.name}: ${asset.error}`, 'error');
      else if (asset.kind === 'font') {
        store.state.fonts = await api.fonts();
        store.emit('fonts');
      }
      for (const w of asset.warnings) toast(`${f.name}: ${w}`);
      if (jobId) {
        watchJob({ id: jobId, type: 'preview', label: `${f.name} のプレビュー作成`, status: 'queued', progress: 0, message: '', createdAt: '' }, (j) => {
          previewVersion++;
          if (j.status === 'failed') toast(`${f.name} のプレビューを作れませんでした: ${j.error}`, 'error');
          store.emit('preview');
        });
      }
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`, 'error');
    }
  }
  await store.save();
}

export async function removeAsset(asset: Asset) {
  const p = store.p;
  const used = p.scenes.some((s) => s.bg?.assetId === asset.id || s.inset?.assetId === asset.id) || p.bgm?.assetId === asset.id || p.narration?.assetId === asset.id;
  if (used && !confirm(`「${asset.name}」はシーン・BGM・ナレーションで使われています。削除すると割り当ても外れます。削除しますか?`)) return;
  if (!used && !confirm(`「${asset.name}」をプロジェクトから削除しますか?(元のファイルは消えません)`)) return;
  store.commit((pp) => ({
    ...pp,
    assets: pp.assets.filter((a) => a.id !== asset.id),
    scenes: pp.scenes.map((s) => ({ ...s, bg: s.bg?.assetId === asset.id ? null : s.bg, inset: s.inset?.assetId === asset.id ? null : s.inset })),
    bgm: pp.bgm?.assetId === asset.id ? null : pp.bgm,
  }));
  await store.save();
  if (asset.id !== p.narration?.assetId) await api.deleteAsset(p.id, asset).catch(() => undefined);
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
  const minLen = 0.15 * SR;
  let s = Math.max(a.srcStart + minLen, Math.min(b.srcEnd - minLen, at));
  let na: Caption = { ...a, srcEnd: s, timingEdited: true };
  let nb: Caption = { ...b, srcStart: s, timingEdited: true };
  const ids = new Set([...a.tokenIds, ...b.tokenIds]);
  const toks = (p.transcript?.tokens ?? []).filter((t) => ids.has(t.id)).sort((x, y) => x.start - y.start);
  if (toks.length >= 2) {
    // 語の切れ目に合わせる(どちらにも1語以上残す)
    let k = toks.findIndex((t) => (t.start + t.end) / 2 >= s);
    if (k < 0) k = toks.length;
    k = Math.max(1, Math.min(toks.length - 1, k));
    const ta = toks.slice(0, k);
    const tb = toks.slice(k);
    const prevEnd = ta[ta.length - 1]!.end;
    const nextStart = tb[0]!.start;
    s = Math.max(a.srcStart + minLen, Math.min(b.srcEnd - minLen, Math.min(Math.max(s, prevEnd), nextStart)));
    const rawA = ta.map((t) => t.text).join('').replace(/^\s+/, '');
    const rawB = tb.map((t) => t.text).join('').replace(/^\s+/, '');
    const textOf = (raw: string) => applyTextFixes(displayFromRaw(raw), p.textFixes);
    na = { ...na, srcEnd: s, tokenIds: ta.map((t) => t.id), rawText: rawA, ...(a.textEdited ? {} : { text: textOf(rawA) }) };
    nb = { ...nb, srcStart: s, tokenIds: tb.map((t) => t.id), rawText: rawB, ...(b.textEdited ? {} : { text: textOf(rawB) }) };
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

/** CapCut のプロジェクト(下書き)として書き出す */
export async function startCapcutExport(): Promise<void> {
  await store.save();
  const chk = await checkExport();
  if (chk.errors.length) {
    toast(chk.errors.join('\n'), 'error');
    return;
  }
  const p = JSON.parse(JSON.stringify(store.p)) as Project;
  try {
    const job = await api.startCapcut(p.id, p);
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
