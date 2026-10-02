// プロジェクトの初期値と、解析結果からカット・テロップ・シーンを組み立てる処理。
import { applyTextFixes } from './script.js';
import { alignCutsToReference, parseReferenceTable, splitByReference, type ReferenceSplit } from './reference.js';
import {
  SCHEMA_VERSION,
  SR,
  type AnalysisData,
  type Caption,
  type CutParams,
  type CutPresetId,
  type Project,
  type PauseInsert,
  type Scene,
  type SpeedRange,
  type Timeline,
} from './types.js';
import { CUT_PRESETS, DEFAULT_CUT_PRESET, decideCuts, detectSilences, flagTokens, levelStats, protectBySpeech, removeRangesFromCuts } from './silence.js';
import { buildTimeline, clampSpeed, identityTimeline, msToSamples, pauseKeyOf, speedKeyOf, srcToOut } from './timemap.js';
import { buildCaptions, buildScenes, carryOverScenes, DEFAULT_SEGMENT_OPTIONS, mergeCaptions, splitLongScenes, applyRhythm, scenesAtBreaks, scenesPerCaption, usableTokens, type SegmentOptions } from './segment.js';
import { charsPerLineFor, DEFAULT_STYLE } from './captionRender.js';

/** 初期値 'auto' は、実行時に API のモデル一覧から最新の flash モデルを選ぶ(モデル名は入れ替わるため) */
export const DEFAULT_GEMINI_MODEL = 'auto';

export function createProject(id: string, name: string): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    assets: [],
    narration: null,
    script: '',
    useScriptHints: true,
    transcript: null,
    cut: { preset: DEFAULT_CUT_PRESET, params: { ...CUT_PRESETS.jumpcut.params }, keepRanges: [] },
    silenceCandidates: [],
    timeline: null,
    scenes: [],
    captions: [],
    style: { ...DEFAULT_STYLE },
    bgm: null,
    mix: { narrationDb: 0 },
    export: { width: 1080, height: 1920, fps: 30, crf: 20, bgColor: '#161616', alsoWav: false, alsoSrt: false },
    safeArea: { show: false, topPct: 9, bottomPct: 22, rightPct: 14 },
    sceneLen: { minSec: 0.6, maxSec: 3, rhythm: 'caption' },
    captionLen: 'short',
    aiAssign: { consent: false, assetIds: [] },
    asr: { engine: 'whisper', quality: 'accuracy', model: null, dtw: false, geminiModel: DEFAULT_GEMINI_MODEL, cloudConsent: false },
  };
}

/** 古い schemaVersion のプロジェクトを現在の形へそろえる */
export function migrateProject(p: Partial<Project> & { id: string; name: string }): Project {
  const base = createProject(p.id, p.name);
  const merged: Project = { ...base, ...p } as Project;
  merged.cut = { ...base.cut, ...(p.cut ?? {}), params: { ...base.cut.params, ...(p.cut?.params ?? {}) } };
  merged.style = { ...base.style, ...(p.style ?? {}) };
  merged.export = { ...base.export, ...(p.export ?? {}) };
  merged.safeArea = { ...base.safeArea, ...(p.safeArea ?? {}) };
  merged.asr = { ...base.asr, ...(p.asr ?? {}) };
  // 以前の初期値(提供終了)は自動選択に切り替える
  if (merged.asr.geminiModel === 'gemini-2.5-flash') merged.asr.geminiModel = 'auto';
  // 以前のバージョンで作ったプロジェクトは、当時の作り方(均等なカット割り・2行までのテロップ)のまま表示する
  merged.sceneLen = p.sceneLen ? { rhythm: 'even', ...p.sceneLen } : { ...base.sceneLen };
  merged.captionLen = p.captionLen ?? (p.sceneLen ? 'normal' : base.captionLen);
  merged.aiAssign = { ...base.aiAssign, ...(p.aiAssign ?? {}) };
  merged.mix = { ...base.mix, ...(p.mix ?? {}) };
  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

export function presetParams(preset: CutPresetId, current: CutParams): CutParams {
  if (preset === 'custom') return { ...current };
  return { ...CUT_PRESETS[preset].params };
}

export function segmentOptionsFor(p: Project): SegmentOptions {
  return {
    ...DEFAULT_SEGMENT_OPTIONS,
    charsPerLine: charsPerLineFor(p.style),
    maxLines: p.style.maxLines,
    sceneMinSec: p.sceneLen.minSec,
    sceneMaxSec: p.sceneLen.maxSec,
    introSec: p.sceneLen.introSec ?? 0,
    introMaxSec: p.sceneLen.introMaxSec ?? 0,
    // 短く区切る: 1行・11文字までで、話の区切り(「〜は」「〜とか」など)ごとにテロップを分ける
    ...(p.captionLen === 'short' ? { charsPerLine: Math.min(11, charsPerLineFor(p.style)), maxLines: 1, captionMinSec: 0.5, captionMaxSec: 2.2, minChars: 5 } : {}),
  };
}

/** 無音候補と削除区間・対応表を再計算する(テロップ・シーンの元音声時刻は変えない) */
export function recomputeCut(p: Project, a: AnalysisData): Project {
  const dur = p.narration?.durationSamples ?? a.durationSamples;
  // CapCut から読み込んだ音声は CapCut で編集済みなので、そのまま使う(カット・速さ・間は CapCut 側で)
  if (p.capcut) return { ...p, silenceCandidates: [], timeline: buildTimeline(dur, [], 0) };
  let cands = detectSilences(a, p.cut.params.sensitivityDb, 50);
  if (p.transcript && p.cut.protectSpeech !== false) cands = protectBySpeech(cands, p.transcript.tokens, a, p.cut.params.sensitivityDb);
  const cuts = decideCuts(cands, p.cut.params, dur, p.cut.keepRanges);
  const timeline = buildTimeline(dur, removeRangesFromCuts(cuts, dur), p.cut.params.fadeMs, speedRangesOf(p.scenes), p.cut.params.overlapMs ?? 0, pausesOf(p.scenes));
  return { ...p, silenceCandidates: cands, timeline };
}

/** シーンの「話す速さ」から、元音声の範囲ごとの速さを作る */
export function speedRangesOf(scenes: Scene[]): SpeedRange[] {
  return scenes.filter((s) => clampSpeed(s.speed) !== 1).map((s) => ({ start: s.srcStart, end: s.srcEnd, speed: clampSpeed(s.speed) }));
}

/** カットごとに「後に足す間」から、足す位置と長さを作る */
export function pausesOf(scenes: Scene[]): PauseInsert[] {
  return scenes.filter((s) => (s.pauseAfterMs ?? 0) > 0).map((s) => ({ at: s.srcEnd, samples: msToSamples(Math.min(5000, s.pauseAfterMs!)) }));
}

/** シーンの速さ・境界が対応表と食い違っていれば対応表を作り直す */
export function ensureTimelineSpeeds(p: Project, a: AnalysisData): Project {
  if (!p.narration || !p.timeline) return p;
  const want = p.capcut ? '' : speedKeyOf(speedRangesOf(p.scenes)) + pauseKeyOf(pausesOf(p.scenes));
  if ((p.timeline.speedKey ?? '') === want) return p;
  const next = recomputeCut(p, a);
  return { ...next, captions: markCaptionReview(next.captions, next.timeline) };
}

export function timelineOf(p: Project): Timeline | null {
  if (p.timeline) return p.timeline;
  if (p.narration) return identityTimeline(p.narration.durationSamples);
  return null;
}

/**
 * テロップの始まり・終わりを実際の発話の立ち上がり・立ち下がりへ寄せる。
 * whisper のトークン時刻は数百ms ずれることがあるため、音量で補正する。
 */
export function snapCaptionsToSpeech(caps: Caption[], a: AnalysisData, sensitivityDb = 0): Caption[] {
  const { threshold } = levelStats(a, sensitivityDb);
  const fs = a.frameSamples;
  const silent = (f: number) => f < 0 || f >= a.db.length || a.db[f]! < threshold;
  const fwd = Math.round(msToSamples(300) / fs);
  const back = Math.round(msToSamples(200) / fs);
  const sorted = [...caps].sort((x, y) => x.srcStart - y.srcStart);
  return sorted.map((c, i) => {
    if (c.timingEdited) return c;
    let s = c.srcStart;
    let e = c.srcEnd;
    let f = Math.floor(s / fs);
    if (silent(f)) {
      for (let k = 1; k <= fwd; k++) if (!silent(f + k)) { s = (f + k) * fs; break; }
    } else {
      for (let k = 1; k <= back; k++) if (silent(f - k)) { s = (f - k + 1) * fs; break; }
    }
    f = Math.max(0, Math.ceil(e / fs) - 1);
    if (silent(f)) {
      for (let k = 1; k <= fwd; k++) if (!silent(f - k)) { e = (f - k + 1) * fs; break; }
    } else {
      for (let k = 1; k <= back; k++) if (silent(f + k)) { e = (f + k) * fs; break; }
    }
    const prevEnd = i > 0 ? sorted[i - 1]!.srcEnd : 0;
    const nextStart = i < sorted.length - 1 ? sorted[i + 1]!.srcStart : a.durationSamples;
    s = Math.max(s, Math.min(prevEnd, c.srcStart));
    e = Math.min(e, Math.max(nextStart, c.srcEnd));
    if (e - s < msToSamples(120)) return c;
    return { ...c, srcStart: s, srcEnd: e };
  });
}

export interface AutoEditOptions {
  /** 手動修正したテロップ・シーンを保持する */
  keepManual: boolean;
  /** 手で動かしたカットの境界も作り直す(カット割りの設定を明示的に変えたとき) */
  recut?: boolean;
}

/** 認識結果と解析データから、カット・テロップ・シーンを自動生成する */
export function autoEdit(p: Project, a: AnalysisData, opt: AutoEditOptions = { keepManual: true }): Project {
  if (!p.narration) return p;
  if (p.capcut) return capcutLayout(p, a, opt);
  let next: Project = p;
  if (p.transcript) {
    next = { ...next, transcript: { ...p.transcript, tokens: flagTokens(p.transcript.tokens, a, p.cut.params.sensitivityDb) } };
  }
  next = recomputeCut(next, a);
  const tl = next.timeline;
  const dur = next.narration!.durationSamples;
  const tokens = next.transcript?.tokens ?? [];
  // 台本の表どおりにカットを割るときは、表の行の切れ目でテロップも区切る
  const ref = next.sceneLen.rhythm === 'reference' ? referenceSplitOf(next) : null;
  const segOpt = ref ? { ...segmentOptionsFor(next), breaksAt: ref.breaks } : segmentOptionsFor(next);
  let caps = snapCaptionsToSpeech(buildCaptions(tokens, tl, segOpt), a, next.cut.params.sensitivityDb);
  // 覚えておいた文字起こしの直しを当てはめる
  if (next.textFixes?.length) caps = caps.map((c) => (c.textEdited ? c : { ...c, text: applyTextFixes(c.text, next.textFixes) }));
  if (opt.keepManual) caps = mergeCaptions(p.captions, caps);
  // シーン境界を手で直している場合は境界を保持する。素材の割り当ては常に引き継ぐ
  const manualScenes = opt.keepManual && !opt.recut && p.scenes.length > 1 && p.scenes.some((s) => s.boundaryEdited);
  const scenes = manualScenes
    ? normalizeScenes(p.scenes, dur)
    : carryOverScenes(
        p.scenes,
        ref
          ? scenesAtBreaks(caps, ref.breaks, dur)
          : next.sceneLen.rhythm === 'caption'
          ? scenesPerCaption(caps, tl, dur, Math.max(0.6, next.sceneLen.minSec))
          : cutToLength({ ...next, captions: caps }, buildScenes(caps, tl, dur, segmentOptionsFor(next))),
      );
  return { ...next, captions: markCaptionReview(caps, tl), scenes };
}

/** 台本の表(素材の指定)の行の切れ目。表がない・文字起こしと合わないときは null */
export function referenceSplitOf(p: Project): ReferenceSplit | null {
  const text = p.aiAssign.reference ?? '';
  const rows = parseReferenceTable(text);
  if (!rows.length || !p.transcript) return null;
  // 文字単位の対応づけは重いので、同じ文字起こし・同じ表なら使い回す
  const tokens = p.transcript.tokens;
  const hit = splitCache.get(tokens);
  if (hit && hit.text === text) return hit.split;
  const split = splitByReference(tokens, rows);
  splitCache.set(tokens, { text, split });
  return split;
}
const splitCache = new WeakMap<object, { text: string; split: ReferenceSplit | null }>();

/**
 * カットごとに、台本の表のどの行に当たるか(行の番号の配列。空なら対応なし)。
 * 表どおりにカットを割っているときは切れ目から、そうでなければカットの文章の重なりから決める。
 * texts はカット(scenes の順)の文章。
 */
export function referenceRowsForScenes(p: Project, scenes: Scene[], texts: string[]): number[][] {
  const rows = parseReferenceTable(p.aiAssign.reference ?? '');
  if (!rows.length) return scenes.map(() => []);
  const split = p.sceneLen.rhythm === 'reference' ? referenceSplitOf(p) : null;
  if (split) {
    return scenes.map((sc) => {
      const mid = (sc.srcStart + sc.srcEnd) / 2;
      return split.rowsOf[split.breaks.filter((b) => b <= mid).length] ?? [];
    });
  }
  return alignCutsToReference(texts, rows).map((r) => (r >= 0 ? [r] : []));
}

/** CapCut から読み込んだプロジェクト: テロップは CapCut のまま、カット割りだけ作り直す */
function capcutLayout(p: Project, a: AnalysisData, opt: AutoEditOptions): Project {
  const next = recomputeCut(p, a);
  const tl = next.timeline;
  const dur = next.narration!.durationSamples;
  const caps = next.captions;
  const manualScenes = opt.keepManual && !opt.recut && p.scenes.length > 1 && p.scenes.some((s) => s.boundaryEdited);
  if (manualScenes) return { ...next, scenes: normalizeScenes(p.scenes, dur) };
  const ref = next.sceneLen.rhythm === 'reference' ? referenceSplitOf(next) : null;
  const fresh = ref
    ? scenesAtBreaks(caps, ref.breaks, dur)
    : next.sceneLen.rhythm === 'caption'
      ? scenesPerCaption(caps, tl, dur, Math.max(0.6, next.sceneLen.minSec))
      : cutToLength(next, buildScenes(caps, tl, dur, segmentOptionsFor(next)));
  return { ...next, scenes: carryOverScenes(p.scenes, fresh) };
}

/** カット後に表示時間がなくなったテロップなどに確認の印を付ける */
export function markCaptionReview(caps: Caption[], tl: Timeline | null): Caption[] {
  return caps.map((c) => {
    if (!tl) return c;
    const o0 = srcToOut(tl, c.srcStart);
    const o1 = srcToOut(tl, c.srcEnd);
    if (o1 - o0 < msToSamples(200)) return { ...c, review: '無音カット後の表示時間がほとんどありません' };
    if (c.review === '無音カット後の表示時間がほとんどありません') {
      const { review: _r, ...rest } = c;
      void _r;
      return rest;
    }
    return c;
  });
}

/** シーン配列が元音声全体を隙間なく覆うように整える */
export function normalizeScenes(scenes: Scene[], srcSamples: number): Scene[] {
  if (scenes.length === 0) return scenes;
  const s = [...scenes].sort((a, b) => a.srcStart - b.srcStart).map((x) => ({ ...x }));
  s[0]!.srcStart = 0;
  for (let i = 1; i < s.length; i++) s[i]!.srcStart = s[i - 1]!.srcEnd;
  s[s.length - 1]!.srcEnd = srcSamples;
  return s.filter((x) => x.srcEnd > x.srcStart || s.length === 1);
}

export const secondsOf = (samples: number) => samples / SR;

/**
 * 「1カットの長さ」より長いカットを分ける(語の切れ目で。文字起こしがなければ均等に)。
 * 自動編集をしていない(カットが1つだけ)場合でも、素材の割り当て前にカット割りを作るために使う。
 */
export function splitScenesToCutLength(p: Project): Project {
  if (!p.narration || p.scenes.length === 0) return p;
  const tl = timelineOf(p);
  void tl;
  const scenes = cutToLength(p, p.scenes);
  return scenes.length === p.scenes.length ? p : { ...p, scenes };
}

/** カット割りの設定(均等 / メリハリ)に合わせて、長いカットを分ける */
function cutToLength(p: Project, scenes: Scene[]): Scene[] {
  const tl = timelineOf(p);
  const tokens = usableTokens(p.transcript?.tokens ?? []);
  const opt = segmentOptionsFor(p);
  // 台本の表どおり: 表の1行を1カットにするので、長くても分けない
  if (p.sceneLen.rhythm === 'reference') return scenes;
  if (p.sceneLen.rhythm === 'mix') return applyRhythm(scenes, tokens, tl, p.captions, opt);
  // テロップごとのカット割りでも、テロップのない長い区間(3秒超)は分ける
  if (p.sceneLen.rhythm === 'caption') return splitLongScenes(scenes, tokens, tl, { ...opt, sceneMaxSec: 3, introSec: 0 });
  return splitLongScenes(scenes, tokens, tl, opt);
}
