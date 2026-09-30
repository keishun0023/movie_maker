// プロジェクトの初期値と、解析結果からカット・テロップ・シーンを組み立てる処理。
import {
  SCHEMA_VERSION,
  SR,
  type AnalysisData,
  type Caption,
  type CutParams,
  type CutPresetId,
  type Project,
  type Scene,
  type SpeedRange,
  type Timeline,
} from './types.js';
import { CUT_PRESETS, DEFAULT_CUT_PRESET, decideCuts, detectSilences, flagTokens, levelStats, protectBySpeech, removeRangesFromCuts } from './silence.js';
import { buildTimeline, clampSpeed, identityTimeline, msToSamples, speedKeyOf, srcToOut } from './timemap.js';
import { buildCaptions, buildScenes, carryOverScenes, DEFAULT_SEGMENT_OPTIONS, mergeCaptions, splitLongScenes, usableTokens, type SegmentOptions } from './segment.js';
import { charsPerLineFor, DEFAULT_STYLE } from './captionRender.js';

/** 初期値。画面でAPIから取得したモデル一覧に切り替えられる */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

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
    sceneLen: { minSec: 2, maxSec: 5 },
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
  merged.sceneLen = { ...base.sceneLen, ...(p.sceneLen ?? {}) };
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
  };
}

/** 無音候補と削除区間・対応表を再計算する(テロップ・シーンの元音声時刻は変えない) */
export function recomputeCut(p: Project, a: AnalysisData): Project {
  const dur = p.narration?.durationSamples ?? a.durationSamples;
  let cands = detectSilences(a, p.cut.params.sensitivityDb, 50);
  if (p.transcript) cands = protectBySpeech(cands, p.transcript.tokens, a, p.cut.params.sensitivityDb);
  const cuts = decideCuts(cands, p.cut.params, dur, p.cut.keepRanges);
  const timeline = buildTimeline(dur, removeRangesFromCuts(cuts, dur), p.cut.params.fadeMs, speedRangesOf(p.scenes), p.cut.params.overlapMs ?? 0);
  return { ...p, silenceCandidates: cands, timeline };
}

/** シーンの「話す速さ」から、元音声の範囲ごとの速さを作る */
export function speedRangesOf(scenes: Scene[]): SpeedRange[] {
  return scenes.filter((s) => clampSpeed(s.speed) !== 1).map((s) => ({ start: s.srcStart, end: s.srcEnd, speed: clampSpeed(s.speed) }));
}

/** シーンの速さ・境界が対応表と食い違っていれば対応表を作り直す */
export function ensureTimelineSpeeds(p: Project, a: AnalysisData): Project {
  if (!p.narration || !p.timeline) return p;
  const want = speedKeyOf(speedRangesOf(p.scenes));
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
}

/** 認識結果と解析データから、カット・テロップ・シーンを自動生成する */
export function autoEdit(p: Project, a: AnalysisData, opt: AutoEditOptions = { keepManual: true }): Project {
  if (!p.narration) return p;
  let next: Project = p;
  if (p.transcript) {
    next = { ...next, transcript: { ...p.transcript, tokens: flagTokens(p.transcript.tokens, a, p.cut.params.sensitivityDb) } };
  }
  next = recomputeCut(next, a);
  const tl = next.timeline;
  const dur = next.narration!.durationSamples;
  const tokens = next.transcript?.tokens ?? [];
  let caps = snapCaptionsToSpeech(buildCaptions(tokens, tl, segmentOptionsFor(next)), a, next.cut.params.sensitivityDb);
  if (opt.keepManual) caps = mergeCaptions(p.captions, caps);
  // シーン境界を手で直している場合は境界を保持する。素材の割り当ては常に引き継ぐ
  const manualScenes = opt.keepManual && p.scenes.length > 1 && p.scenes.some((s) => s.boundaryEdited);
  const scenes = manualScenes
    ? normalizeScenes(p.scenes, dur)
    : carryOverScenes(
        p.scenes,
        splitLongScenes(buildScenes(caps, tl, dur, segmentOptionsFor(next)), usableTokens(tokens), tl, segmentOptionsFor(next)),
      );
  return { ...next, captions: markCaptionReview(caps, tl), scenes };
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
