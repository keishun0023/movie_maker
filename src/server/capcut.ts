// CapCut(デスクトップ版)のプロジェクト(下書き)として書き出す。
//
// CapCut の下書きの形式は公開されていない。ここでの形式は、次のオープンソースの調査結果に基づく:
//   - capcut-cli (MIT, https://github.com/renezander030/capcut-cli) の docs/draft-schema と version-support
//   - pyCapCut (https://github.com/GuanYixuan/pyCapCut)
// 要点:
//   - 下書きは「CapCut の下書きフォルダ/<名前>/」。Mac は draft_info.json、Windows は draft_content.json が本体
//   - 新しい CapCut は、アプリ自身が書いた印(version など)のない下書きを開かない。
//     そのため、下書きフォルダにある「CapCut が作ったプロジェクト」を土台にし、中身だけ入れ替える
//   - CapCut は下書きフォルダを走査せず root_meta_info.json の一覧から表示するので、そこに登録する
//   - 取り込んだ素材は draft_meta_info.json の draft_materials に登録し、素材の local_material_id と結ぶ
//   - 時間の単位はマイクロ秒。位置は画面中央が 0、半画面が 1(上・右が +)
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SR, type Asset, type CaptionStyle, type Project } from '../shared/types.js';
import { placeBackground, placeInset } from '../shared/fit.js';
import { evalMotion, motionExprs, motionOf } from '../shared/motion.js';
import { frameToSample, sampleToFrame, sourcePiecesForOutput, totalFrames } from '../shared/timemap.js';
import { timelineOf } from '../shared/project.js';
import { captionOutputTimings } from '../shared/segment.js';
import type { JobContext } from './jobs.js';
import { loadSourcePcm, renderEdited, writeWav } from './media.js';
import { run } from './proc.js';
import { sceneSpans } from './export.js';
import { sub } from './store.js';

type Json = Record<string, unknown>;

export interface CapcutResult {
  draftName: string;
  draftDir: string;
  appVersion: string;
  notes: string[];
}

/** CapCut の下書きフォルダの既定の場所 */
export function defaultDraftsDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  return path.join(os.homedir(), 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
}

const uuid = () => crypto.randomUUID().toUpperCase();

function versionTuple(v: string): number[] {
  return v.split('.').map((x) => Number.parseInt(x, 10) || 0);
}

function newer(a: string, b: string): boolean {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * 見本ファイルと同じ包み方で本体を書く。CapCut 8.7 以降の template-2.tmp は
 * {"draft_content": {...}} のように本体を包んでいる(文字列の JSON のこともある)。
 * 包み方が分からないときは null
 */
export function wrapTimeline(seedRaw: Json, draft: Json): Json | null {
  if (Array.isArray(seedRaw.tracks)) return draft;
  for (const [k, v] of Object.entries(seedRaw)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as Json).tracks)) return { ...seedRaw, [k]: draft };
    if (typeof v === 'string' && v.trimStart().startsWith('{')) {
      try {
        const inner = JSON.parse(v) as Json;
        if (inner && Array.isArray(inner.tracks)) return { ...seedRaw, [k]: JSON.stringify(draft) };
      } catch {
        // 本体ではない文字列
      }
    }
  }
  return null;
}

function unwrapTimeline(raw: Json): Json | null {
  if (Array.isArray(raw.tracks)) return raw;
  for (const v of Object.values(raw)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as Json).tracks)) return v as Json;
    if (typeof v === 'string' && v.trimStart().startsWith('{')) {
      try {
        const inner = JSON.parse(v) as Json;
        if (inner && Array.isArray(inner.tracks)) return inner;
      } catch {
        // 本体ではない文字列
      }
    }
  }
  return null;
}

interface Seed {
  dir: string;
  /** 土台にしたプロジェクトにある本体ファイル(この名前で書き出す) */
  files: string[];
  draft: Json;
  meta: Json | null;
  version: string;
  appAuthored: boolean;
  mtime: number;
}

const TIMELINE_FILES = ['draft_info.json', 'draft_content.json', 'template-2.tmp'];

function readJson(file: string): Json | null {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const j = JSON.parse(t) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Json) : null;
  } catch {
    return null;
  }
}

/** 下書きフォルダの中から、土台にする「CapCut が作ったプロジェクト」を選ぶ(新しい版・新しい更新日を優先) */
export function findSeed(draftsDir: string): { seed: Seed | null; projects: number; unreadable: number } {
  let names: string[] = [];
  try {
    names = fs.readdirSync(draftsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { seed: null, projects: 0, unreadable: 0 };
  }
  let best: Seed | null = null;
  let projects = 0;
  let unreadable = 0;
  for (const name of names) {
    const dir = path.join(draftsDir, name);
    const present = TIMELINE_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
    if (present.length === 0) continue;
    projects++;
    let draft: Json | null = null;
    let mtime = 0;
    for (const f of present) {
      const j = readJson(path.join(dir, f));
      const inner = j ? unwrapTimeline(j) : null;
      if (inner) {
        draft = inner;
        mtime = fs.statSync(path.join(dir, f)).mtimeMs;
        break;
      }
    }
    const platform = draft?.platform as Json | undefined;
    const version = typeof platform?.app_version === 'string' ? platform.app_version : '';
    if (!draft || !version) {
      unreadable++;
      continue;
    }
    const appAuthored = (typeof draft.version === 'number' && draft.version > 0) || (typeof draft.new_version === 'string' && draft.new_version !== '') || draft.last_modified_platform != null;
    // 本体として読み込まれるファイルだけ書く(包み方の分かるものだけ)
    const files = present.filter((f) => {
      const raw = readJson(path.join(dir, f));
      return raw !== null && wrapTimeline(raw, {}) !== null;
    });
    const seed: Seed = { dir, files, draft, meta: readJson(path.join(dir, 'draft_meta_info.json')), version, appAuthored, mtime };
    if (!best || (seed.appAuthored !== best.appAuthored ? seed.appAuthored : seed.version !== best.version ? newer(seed.version, best.version) : seed.mtime > best.mtime)) best = seed;
  }
  return { seed: best, projects, unreadable };
}

/** CapCut が起動中か(起動中に書き込むと、終了時に一覧が上書きされて表示されなくなる) */
async function capcutRunning(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const r = await run('pgrep', ['-x', 'CapCut']);
      return r.code === 0 && r.stdout.trim() !== '';
    }
    if (process.platform === 'win32') {
      const r = await run('tasklist', ['/FI', 'IMAGENAME eq CapCut.exe', '/NH']);
      return /CapCut\.exe/i.test(r.stdout);
    }
  } catch {
    // 確認できないときは止めない
  }
  return false;
}

// ---- 素材・区間の組み立て ----

class DraftBuilder {
  readonly materials: Record<string, Json[]> = {};
  readonly tracks: Json[] = [];
  readonly metaEntries: Json[] = [];
  private readonly localIds = new Map<string, string>();

  constructor(readonly dir: string) {}

  add(kind: string, m: Json) {
    (this.materials[kind] ??= []).push(m);
  }

  track(type: 'video' | 'audio' | 'text', name: string): Json[] {
    const segments: Json[] = [];
    this.tracks.push({ attribute: 0, flag: 0, id: uuid(), is_default_name: false, name, segments, type });
    return segments;
  }

  /** 素材ファイルを下書きフォルダにコピーし、draft_meta_info の取り込み済み素材に登録する */
  async importFile(src: string, kind: 'video' | 'photo' | 'music', name: string, durationUs: number, w: number, h: number): Promise<{ file: string; localId: string }> {
    const sub = kind === 'music' ? 'audio' : kind === 'photo' ? 'image' : 'video';
    const dstDir = path.join(this.dir, 'assets', sub);
    await fsp.mkdir(dstDir, { recursive: true });
    const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'media';
    let dst = path.join(dstDir, safe);
    const known = this.localIds.get(src);
    if (known) return { file: dst, localId: known };
    for (let i = 2; fs.existsSync(dst); i++) dst = path.join(dstDir, `${path.parse(safe).name}-${i}${path.extname(safe)}`);
    await fsp.copyFile(src, dst);
    const localId = uuid();
    this.localIds.set(src, localId);
    this.metaEntries.push({
      ai_group_type: '',
      create_time: -1,
      duration: Math.round(durationUs > 0 ? durationUs : 5_000_000),
      enter_from: 0,
      extra_info: path.basename(dst),
      file_Path: dst,
      height: kind === 'music' ? 0 : Math.round(h),
      id: localId,
      import_time: -1,
      import_time_ms: -1,
      item_source: 1,
      material_color_tag: '',
      md5: '',
      metetype: kind,
      roughcut_time_range: { duration: -1, start: -1 },
      sub_time_range: { duration: -1, start: -1 },
      type: 0,
      width: kind === 'music' ? 0 : Math.round(w),
    });
    return { file: dst, localId };
  }

  /** 区間に付く補助素材(速さ・プレースホルダなど)。CapCut は区間ごとにこれらを持つ */
  companions(type: 'video' | 'audio' | 'text', speed = 1): string[] {
    const ids: string[] = [];
    const push = (kind: string, m: Json) => {
      this.add(kind, m);
      ids.push(m.id as string);
    };
    push('speeds', { curve_speed: null, id: uuid(), mode: 0, speed, type: 'speed' });
    push('placeholder_infos', { error_path: '', error_text: '', id: uuid(), meta_type: 'none', res_path: '', res_text: '', type: 'placeholder_info' });
    push('sound_channel_mappings', { audio_channel_mapping: 0, id: uuid(), is_config_open: false, type: 'none' });
    push('vocal_separations', { choice: 0, enter_from: '', final_algorithm: '', id: uuid(), production_path: '', removed_sounds: [], time_range: null, type: 'vocal_separation' });
    if (type === 'video') {
      push('canvases', { album_image: '', blur: 0, color: '', id: uuid(), image: '', image_id: '', image_name: '', source_platform: 0, team_id: '', type: 'canvas_color' });
      push('material_colors', { gradient_angle: 90, gradient_colors: [], gradient_percents: [], height: 0, id: uuid(), is_color_clip: false, is_gradient: false, solid_color: '', type: 'material_color', width: 0 });
    }
    return ids;
  }
}

function segment(materialId: string, start: number, duration: number, source: { start: number; duration: number } | null, extra: Json): Json {
  return {
    cartoon: false,
    clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    common_keyframes: [],
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    extra_material_refs: [],
    group_id: '',
    id: uuid(),
    intensifies_audio: false,
    is_placeholder: false,
    is_tone_modify: false,
    keyframe_refs: [],
    last_nonzero_volume: 1,
    material_id: materialId,
    render_index: 0,
    reverse: false,
    source_timerange: source,
    speed: 1,
    target_timerange: { duration, start },
    template_id: '',
    template_scene: 'default',
    track_attribute: 0,
    track_render_index: 0,
    uniform_scale: { on: true, value: 1 },
    visible: true,
    volume: 1,
    ...extra,
  };
}

function keyframeList(property: string, points: { t: number; v: number }[]): Json {
  return {
    id: uuid(),
    keyframe_list: points.map((p) => ({
      curveType: 'Line',
      graphID: '',
      id: uuid(),
      left_control: { x: 0, y: 0 },
      right_control: { x: 0, y: 0 },
      time_offset: Math.round(p.t),
      values: [Math.round(p.v * 1e6) / 1e6],
    })),
    material_id: '',
    property_type: property,
  };
}

function hex6(c: string): string {
  const m = /^#?([0-9a-fA-F]{6})/.exec(c.trim());
  return '#' + (m ? m[1]!.toUpperCase() : 'FFFFFF');
}

function rgb01(c: string): [number, number, number] {
  const h = hex6(c).slice(1);
  return [0, 2, 4].map((i) => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 1e4) / 1e4) as [number, number, number];
}

/** テロップ1つ分の文字素材。大きさ・縁取りの数値は CapCut の画面上の見た目に近づけた目安 */
function textMaterial(text: string, st: CaptionStyle, W: number): Json {
  // CapCut の文字サイズ 1 は 1080 幅の画面でおよそ 3.4px(実測に基づく目安。ずれたら CapCut でまとめて調整)
  const size = Math.round(((st.size * (1080 / W)) / 3.4) * 10) / 10;
  const style: Json = {
    bold: st.weight >= 600,
    fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: 1, color: rgb01(st.color) } } },
    italic: false,
    range: [0, text.length],
    size,
    underline: false,
    strokes: [],
  };
  let checkFlag = 7;
  if (st.strokeWidth > 0) {
    // 縁取りの太さ: CapCut の 0〜100 を 0〜0.2 で持つ。文字サイズに対する割合から換算
    const w = Math.min(0.2, Math.max(0.02, (st.strokeWidth / Math.max(1, st.size)) * 0.8));
    style.strokes = [{ content: { solid: { alpha: 1, color: rgb01(st.strokeColor) } }, width: Math.round(w * 1e4) / 1e4 }];
    checkFlag |= 8;
  }
  if (st.shadow) {
    style.shadows = [{ alpha: 0.8, angle: -90, content: { solid: { color: rgb01(st.shadowColor) } }, diffuse: Math.min(1, st.shadowBlur / 100 / 6 * 10), distance: Math.max(1, st.shadowOffsetY / 2) }];
    checkFlag |= 32;
  }
  const m: Json = {
    add_type: 0,
    alignment: st.align === 'left' ? 0 : st.align === 'right' ? 2 : 1,
    check_flag: checkFlag,
    content: JSON.stringify({ styles: [style], text }),
    fixed_height: -1,
    fixed_width: -1,
    force_apply_line_max_width: false,
    global_alpha: 1,
    id: uuid(),
    letter_spacing: 0,
    line_feed: 1,
    line_max_width: Math.round(Math.min(1, st.maxWidth / W) * 1e4) / 1e4,
    line_spacing: Math.round(Math.max(0, st.lineHeight - 1.2) * 1e4) / 1e4 + 0.02,
    type: 'text',
    typesetting: 0,
  };
  if (st.band) {
    Object.assign(m, {
      background_alpha: st.bandOpacity,
      background_color: hex6(st.bandColor),
      background_height: 0.14,
      background_horizontal_offset: 0,
      background_round_radius: 0,
      background_style: 1,
      background_vertical_offset: 0,
      background_width: 0.14,
    });
    m.check_flag = (m.check_flag as number) | 16;
  }
  return m;
}

function assetOf(p: Project, id: string): Asset | null {
  const a = p.assets.find((x) => x.id === id);
  return a && a.status === 'ok' ? a : null;
}

/** 画像は向きをそろえた変換済みファイルを使う(書き出しと同じ) */
function mediaFile(p: Project, a: Asset): string {
  if (a.kind === 'image' && a.proxy) return sub(p.id, a.proxy);
  return sub(p.id, a.file);
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'TateDouga';
}

// ---- 書き出し本体 ----

export async function exportCapcut(p: Project, draftsDir: string, ctx: JobContext): Promise<CapcutResult> {
  const notes: string[] = [];
  const tl = timelineOf(p);
  if (!p.narration || !tl) throw new Error('ナレーション音声を設定してください。');
  if (!fs.existsSync(draftsDir)) {
    throw new Error(`CapCut の下書きフォルダが見つかりません: ${draftsDir}\nCapCut をインストールして一度起動するか、CapCut の「設定 → 下書きの場所」に表示される場所を指定してください。`);
  }
  if (await capcutRunning()) {
    throw new Error('CapCut が起動しています。CapCut を終了してから、もう一度書き出してください(起動中に書き込むと、CapCut の終了時にプロジェクト一覧から消えてしまいます)。');
  }
  const found = findSeed(draftsDir);
  const seed = found.seed;
  if (!seed) {
    throw new Error(
      found.projects > 0
        ? `下書きフォルダのプロジェクト(${found.projects}件)を読み取れませんでした(暗号化されている可能性があります)。剪映(中国版)ではなく CapCut(国際版)をお使いください。`
        : 'CapCut のプロジェクトが1つもありません。CapCut で「新しいプロジェクト」を1つ作ってそのまま閉じ、CapCut を終了してから、もう一度書き出してください(CapCut の最新の形式に合わせるための見本にします)。',
    );
  }
  if (!seed.appAuthored) notes.push('見本にしたプロジェクトに CapCut の版の情報が少ないため、開けない場合は CapCut で新しいプロジェクトを1つ作ってから書き出し直してください。');
  if ((versionTuple(seed.version)[0] ?? 0) >= 10) {
    notes.push(`CapCut ${seed.version} は、外部で作ったプロジェクトを「破損している」と表示して開かないことがあると報告されています。開けなかった場合はお知らせください。`);
  }

  const { width: W, height: H, fps } = p.export;
  const total = totalFrames(tl.outSamples, fps);
  const us = (frames: number) => Math.round((frames * 1_000_000) / fps);
  const baseName = safeName(`${p.name} ${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')}`);
  let draftName = baseName;
  for (let i = 2; fs.existsSync(path.join(draftsDir, draftName)); i++) draftName = `${baseName} (${i})`;
  const dir = path.join(draftsDir, draftName);
  await fsp.mkdir(dir, { recursive: true });
  const b = new DraftBuilder(dir);
  try {
    // 1. ナレーション(カット・速さ・被せを反映した1本の音声)
    ctx.progress(0.05, 'ナレーションを書き出しています');
    const src = await loadSourcePcm(p.id, p.narration.sourceKey);
    const narrWav = path.join(os.tmpdir(), `tdm-narration-${crypto.randomBytes(4).toString('hex')}.wav`);
    await writeWav(narrWav, renderEdited(src, tl, p.mix.narrationDb, frameToSample(total, fps)));
    const totalUs = us(total);
    const narr = await b.importFile(narrWav, 'music', 'ナレーション.wav', totalUs, 0, 0);
    await fsp.rm(narrWav, { force: true });

    // 2. 背景(シーンごと)
    const spans = sceneSpans(p, tl, fps);
    const bgTrack = b.track('video', '背景');
    const insetTrack: Json[] = [];
    const videoMats = new Map<string, { id: string; asset: Asset }>();
    const materialFor = async (a: Asset): Promise<string> => {
      const hit = videoMats.get(a.id);
      if (hit) return hit.id;
      const photo = a.kind === 'image';
      const durUs = photo ? 10_800_000_000 : Math.round((a.durationSec ?? 0) * 1e6);
      const f = await b.importFile(mediaFile(p, a), photo ? 'photo' : 'video', a.name, photo ? 5_000_000 : durUs, a.width ?? W, a.height ?? H);
      const id = uuid();
      b.add('videos', {
        aigc_type: 'none',
        category_id: '',
        category_name: 'local',
        check_flag: 62978047,
        crop: { lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1, upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0 },
        crop_ratio: 'free',
        crop_scale: 1,
        duration: durUs,
        extra_type_option: 0,
        formula_id: '',
        freeze: null,
        has_audio: !photo && !!a.audioStreams?.length,
        height: a.height ?? H,
        id,
        intensifies_audio_path: '',
        intensifies_path: '',
        is_ai_generate_content: false,
        is_copyright: false,
        is_text_edit_overdub: false,
        is_unified_beauty_mode: false,
        local_id: '',
        local_material_id: f.localId,
        material_id: '',
        material_name: path.basename(f.file),
        material_url: '',
        matting: { flag: 0, has_use_quick_brush: false, has_use_quick_eraser: false, interactiveTime: [], path: '', strokes: [] },
        media_path: '',
        object_locked: null,
        origin_material_id: '',
        path: f.file,
        picture_from: 'none',
        picture_set_category_id: '',
        picture_set_category_name: '',
        request_id: '',
        reverse_intensifies_path: '',
        reverse_path: '',
        source_platform: 0,
        stable: { matrix_path: '', stable_level: 0, time_range: { duration: 0, start: 0 } },
        team_id: '',
        type: photo ? 'photo' : 'video',
        video_algorithm: { algorithms: [], deflicker: null, motion_blur_config: null, noise_reduction: null, path: '', quality_enhance: null, time_range: null },
        width: a.width ?? W,
      });
      videoMats.set(a.id, { id, asset: a });
      return id;
    };

    let loopedNote = false;
    for (let si = 0; si < spans.length; si++) {
      const span = spans[si]!;
      ctx.progress(0.1 + 0.6 * (si / Math.max(1, spans.length)), `背景を並べています (${si + 1}/${spans.length})`);
      const bg = span.scene.bg;
      if (bg) {
        const a = assetOf(p, bg.assetId);
        if (a && (a.kind === 'video' || a.kind === 'image')) {
          const matId = await materialFor(a);
          const srcW = a.width ?? W;
          const srcH = a.height ?? H;
          const pl = placeBackground(srcW, srcH, W, H, bg);
          // CapCut の拡大率 1 は「画面に収まる大きさ」
          const fitW = srcW * Math.min(W / srcW, H / srcH);
          const baseScale = pl.w / fitW;
          const cx0 = pl.x + pl.w / 2 - W / 2;
          const cy0 = pl.y + pl.h / 2 - H / 2;
          const sceneDur = (span.f1 - span.f0) / fps;
          const mex = motionExprs(motionOf(bg), sceneDur, W, H);
          const at = (T: number) => {
            const m = mex ? evalMotion(mex, Math.max(0, T)) : { s: 1, dx: 0, dy: 0 };
            const lim = (v: number, size: number) => Math.max(-((m.s - 1) * size) / 2, Math.min(((m.s - 1) * size) / 2, v));
            return { scale: baseScale * m.s, x: (m.s * cx0 + lim(m.dx, W)) / (W / 2), y: -(m.s * cy0 + lim(m.dy, H)) / (H / 2) };
          };
          const shake = motionOf(bg)?.type === 'shake';
          // 背景1シーンを、元素材のどこを使うかで区間に分ける
          const pieces: { f0: number; f1: number; srcUs: number; speed: number }[] = [];
          if (a.kind === 'image') {
            pieces.push({ f0: span.f0, f1: span.f1, srcUs: 0, speed: 1 });
          } else if (bg.mode === 'synced' && p.narration.assetId === a.id) {
            const offset = a.audioStartSec ?? 0;
            for (const pc of sourcePiecesForOutput(tl, frameToSample(span.f0, fps), frameToSample(span.f1, fps))) {
              const f0 = Math.max(span.f0, sampleToFrame(pc.outStart, fps));
              const f1 = Math.min(span.f1, sampleToFrame(pc.outEnd, fps));
              if (f1 > f0) pieces.push({ f0, f1, srcUs: Math.round((offset + pc.srcStart / SR) * 1e6), speed: pc.speed ?? 1 });
            }
            // 隙間ができないよう、区間の端を前の区間の終わりにそろえる
            for (let k = 0; k < pieces.length; k++) {
              pieces[k]!.f0 = k === 0 ? span.f0 : pieces[k - 1]!.f1;
              if (k === pieces.length - 1) pieces[k]!.f1 = span.f1;
            }
          } else {
            const len = a.durationSec ?? sceneDur;
            let f = span.f0;
            let pos = Math.min(Math.max(0, bg.startSec), Math.max(0, len - 0.1));
            while (f < span.f1) {
              const avail = Math.max(1, Math.floor((len - pos) * fps));
              const f1 = Math.min(span.f1, f + avail);
              pieces.push({ f0: f, f1, srcUs: Math.round(pos * 1e6), speed: 1 });
              f = f1;
              pos = 0;
              if (f < span.f1) loopedNote = true;
            }
          }
          const volume = a.kind === 'video' && bg.audio && bg.mode !== 'synced' ? Math.pow(10, bg.volumeDb / 20) : 0;
          for (const pc of pieces) {
            const durUs = us(pc.f1) - us(pc.f0);
            const seg = segment(matId, us(pc.f0), durUs, { start: pc.srcUs, duration: Math.round(durUs * pc.speed) }, {
              extra_material_refs: b.companions('video', pc.speed),
              speed: pc.speed,
              volume,
              last_nonzero_volume: volume || 1,
              render_index: 0,
            });
            const s0 = at((pc.f0 - span.f0) / fps);
            seg.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: s0.scale, y: s0.scale }, transform: { x: s0.x, y: s0.y } };
            seg.uniform_scale = { on: true, value: 1 };
            if (mex) {
              // 動きはキーフレームで再現する(揺れは細かく、それ以外は 0.1 秒ごと)
              const step = shake ? 2 / fps : 0.1;
              const t0 = (pc.f0 - span.f0) / fps;
              const t1 = (pc.f1 - span.f0) / fps;
              const pts: { t: number; k: ReturnType<typeof at> }[] = [];
              for (let t = t0; t < t1 - 1e-6; t += step) pts.push({ t: (t - t0) * 1e6, k: at(t) });
              pts.push({ t: (t1 - t0) * 1e6, k: at(t1) });
              seg.common_keyframes = [
                keyframeList('KFTypeScaleX', pts.map((q) => ({ t: q.t, v: q.k.scale }))),
                keyframeList('KFTypeScaleY', pts.map((q) => ({ t: q.t, v: q.k.scale }))),
                keyframeList('KFTypePositionX', pts.map((q) => ({ t: q.t, v: q.k.x }))),
                keyframeList('KFTypePositionY', pts.map((q) => ({ t: q.t, v: q.k.y }))),
              ];
              seg.uniform_scale = { on: false, value: 1 };
            }
            bgTrack.push(seg);
          }
        }
      }
      // ワイプ(小窓)
      const inset = span.scene.inset;
      const ia = inset ? assetOf(p, inset.assetId) : null;
      if (inset && ia && (ia.kind === 'image' || ia.kind === 'video') && ia.width && ia.height) {
        const matId = await materialFor(ia);
        const f0 = Math.min(span.f1 - 1, span.f0 + Math.round(inset.startSec * fps));
        const f1 = inset.endSec == null ? span.f1 : Math.min(span.f1, span.f0 + Math.round(inset.endSec * fps));
        if (f1 > f0) {
          const pl = placeInset(ia.width, ia.height, W, H, inset);
          const fitW = ia.width * Math.min(W / ia.width, H / ia.height);
          const durUs = us(f1) - us(f0);
          const seg = segment(matId, us(f0), durUs, { start: 0, duration: durUs }, { extra_material_refs: b.companions('video'), volume: 0, render_index: 1 });
          const sc = pl.w / fitW;
          seg.clip = {
            alpha: 1,
            flip: { horizontal: false, vertical: false },
            rotation: 0,
            scale: { x: sc, y: sc },
            transform: { x: (pl.x + pl.w / 2 - W / 2) / (W / 2), y: -(pl.y + pl.h / 2 - H / 2) / (H / 2) },
          };
          insetTrack.push(seg);
        }
      }
    }
    if (insetTrack.length) b.track('video', 'ワイプ').push(...insetTrack);
    if (loopedNote) notes.push('素材の動画がカットより短い所は、動画を最初から繰り返して埋めています。');

    // 3. ナレーション
    const narrMat = uuid();
    b.add('audios', {
      app_id: 0,
      category_id: '',
      category_name: 'local',
      check_flag: 1,
      copyright_limit_type: 'none',
      duration: totalUs,
      effect_id: '',
      formula_id: '',
      id: narrMat,
      local_material_id: narr.localId,
      music_id: '',
      name: path.basename(narr.file),
      path: narr.file,
      request_id: '',
      resource_id: '',
      source_platform: 0,
      team_id: '',
      text_id: '',
      tone_category_id: '',
      tone_category_name: '',
      tone_effect_id: '',
      tone_effect_name: '',
      tone_platform: '',
      tone_second_category_id: '',
      tone_second_category_name: '',
      tone_speaker: '',
      tone_type: '',
      type: 'extract_music',
      video_id: '',
      wave_points: [],
    });
    b.track('audio', 'ナレーション').push(
      segment(narrMat, 0, totalUs, { start: 0, duration: totalUs }, { clip: null, extra_material_refs: b.companions('audio'), uniform_scale: null }),
    );

    // 4. BGM
    const bgm = p.bgm ? assetOf(p, p.bgm.assetId) : null;
    if (p.bgm && bgm && bgm.durationSec) {
      ctx.progress(0.75, 'BGM を並べています');
      const f = await b.importFile(sub(p.id, bgm.file), 'music', bgm.name, bgm.durationSec * 1e6, 0, 0);
      const matId = uuid();
      b.add('audios', {
        category_id: '',
        category_name: 'local',
        check_flag: 1,
        duration: Math.round(bgm.durationSec * 1e6),
        id: matId,
        local_material_id: f.localId,
        music_id: '',
        name: path.basename(f.file),
        path: f.file,
        source_platform: 0,
        type: 'extract_music',
        wave_points: [],
      });
      const segs = b.track('audio', 'BGM');
      const vol = Math.pow(10, p.bgm.volumeDb / 20);
      let t = 0;
      let pos = Math.max(0, Math.min(p.bgm.startSec, bgm.durationSec - 0.1));
      while (t < totalUs) {
        const len = Math.min(totalUs - t, Math.round((bgm.durationSec - pos) * 1e6));
        if (len <= 0) break;
        segs.push(segment(matId, t, len, { start: Math.round(pos * 1e6), duration: len }, { clip: null, extra_material_refs: b.companions('audio'), uniform_scale: null, volume: vol, last_nonzero_volume: vol }));
        t += len;
        pos = 0;
        if (!p.bgm.loop) break;
      }
      const fadeIn = Math.round(p.bgm.fadeInSec * 1e6);
      const fadeOut = Math.round(p.bgm.fadeOutSec * 1e6);
      if (segs.length && (fadeIn > 0 || fadeOut > 0)) {
        const add = (seg: Json, fin: number, fout: number) => {
          const id = uuid();
          b.add('audio_fades', { fade_in_duration: fin, fade_out_duration: fout, fade_type: 0, id, type: 'audio_fade' });
          (seg.extra_material_refs as string[]).push(id);
        };
        if (segs.length === 1) add(segs[0]!, fadeIn, fadeOut);
        else {
          if (fadeIn > 0) add(segs[0]!, fadeIn, 0);
          if (fadeOut > 0) add(segs[segs.length - 1]!, 0, fadeOut);
        }
      }
    }

    // 5. テロップ(CapCut の文字として入れるので、あとから文字・位置・フォントを直せる)
    ctx.progress(0.8, 'テロップを並べています');
    const texts = b.track('text', 'テロップ');
    for (const t of captionOutputTimings(p.captions, tl)) {
      const c = p.captions.find((x) => x.id === t.id);
      if (!c || !c.text.trim()) continue;
      const f0 = sampleToFrame(t.outStart, fps);
      const f1 = Math.min(total, Math.max(f0 + 1, sampleToFrame(t.outEnd, fps)));
      if (f1 <= f0) continue;
      const st = { ...p.style, ...(c.style ?? {}) } as CaptionStyle;
      const mat = textMaterial(c.text.trim(), st, W);
      b.add('texts', mat);
      const seg = segment(mat.id as string, us(f0), us(f1) - us(f0), null, { extra_material_refs: b.companions('text'), render_index: 14000 });
      seg.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: st.x * 2 - 1, y: 1 - st.y * 2 } };
      texts.push(seg);
    }
    notes.push('テロップは CapCut の標準フォントで入ります。文字の大きさ・縁取りは近い値にしてありますが、見た目が違う場合は CapCut でテロップをまとめて選んで調整してください。');

    // 6. 本体ファイル(見本プロジェクトの形式・版の印を引き継ぎ、中身を入れ替える)
    ctx.progress(0.9, 'プロジェクトファイルを書き込んでいます');
    const draftId = uuid();
    const nowMs = Date.now();
    const draft = structuredClone(seed.draft);
    for (const [k, v] of Object.entries(draft)) {
      if ((k === 'materials' || k === 'keyframes') && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const kk of Object.keys(v as Json)) if (Array.isArray((v as Json)[kk])) (v as Json)[kk] = [];
      } else if (Array.isArray(v)) draft[k] = [];
      else if (k === 'cover' || k === 'retouch_cover' || k === 'time_marks') draft[k] = null;
    }
    const materials = (draft.materials ?? {}) as Record<string, Json[]>;
    for (const [k, list] of Object.entries(b.materials)) materials[k] = [...(materials[k] ?? []), ...list];
    draft.materials = materials;
    draft.tracks = b.tracks.filter((t) => (t.segments as Json[]).length > 0);
    draft.id = draftId;
    draft.name = draftName;
    draft.duration = totalUs;
    draft.fps = fps;
    const canvas = (draft.canvas_config ?? {}) as Json;
    draft.canvas_config = { ...canvas, width: W, height: H, ratio: 'original' };
    if (typeof draft.create_time === 'number') draft.create_time = Math.floor(nowMs / 1000);
    if (typeof draft.update_time === 'number') draft.update_time = Math.floor(nowMs / 1000);
    if (typeof draft.static_cover_image_path === 'string') draft.static_cover_image_path = '';
    for (const f of seed.files) {
      const raw = readJson(path.join(seed.dir, f));
      const out = raw ? wrapTimeline(raw, draft) : null;
      if (out) await fsp.writeFile(path.join(dir, f), JSON.stringify(out), 'utf8');
    }
    const mainFile = path.join(dir, seed.files.includes('draft_info.json') ? 'draft_info.json' : seed.files[0]!);

    // 7. draft_meta_info.json(取り込んだ素材の登録を含む)
    const meta: Json = structuredClone(seed.meta ?? {});
    for (const k of Object.keys(meta)) {
      if (/cloud|enterprise|purchase|deeplink|template_id|tutorial/i.test(k)) {
        const v = meta[k];
        meta[k] = typeof v === 'boolean' ? false : typeof v === 'number' ? 0 : typeof v === 'string' ? '' : Array.isArray(v) ? [] : v;
      }
    }
    const groups: Json[] = Array.isArray(meta.draft_materials) ? (meta.draft_materials as Json[]).map((g) => ({ ...g, value: [] })) : [];
    const g0 = groups.find((g) => g.type === 0);
    if (g0) g0.value = b.metaEntries;
    else groups.unshift({ type: 0, value: b.metaEntries });
    Object.assign(meta, {
      draft_cover: '',
      draft_fold_path: dir,
      draft_id: draftId,
      draft_json_file: mainFile,
      draft_materials: groups,
      draft_materials_copied_info: [],
      draft_name: draftName,
      draft_root_path: draftsDir,
      draft_segment_extra_info: [],
      draft_timeline_materials_size_: 0,
      tm_draft_create: nowMs * 1000,
      tm_draft_modified: nowMs * 1000,
      tm_draft_removed: 0,
      tm_duration: totalUs,
    });
    await fsp.writeFile(path.join(dir, 'draft_meta_info.json'), JSON.stringify(meta), 'utf8');

    // 8. CapCut のプロジェクト一覧(root_meta_info.json)に登録する(元のファイルは .bak に残す)
    const indexFile = path.join(draftsDir, 'root_meta_info.json');
    const entry = {
      draft_cover: '',
      draft_fold_path: dir,
      draft_id: draftId,
      draft_is_ai_shorts: false,
      draft_is_invisible: false,
      draft_json_file: mainFile,
      draft_name: draftName,
      draft_new_version: '',
      draft_root_path: draftsDir,
      draft_timeline_materials_size: 0,
      tm_draft_create: nowMs * 1000,
      tm_draft_modified: nowMs * 1000,
      tm_draft_removed: 0,
      tm_duration: totalUs,
    };
    const rawIndex = fs.existsSync(indexFile) ? await fsp.readFile(indexFile, 'utf8') : null;
    const index = rawIndex !== null ? (JSON.parse(rawIndex.replace(/^﻿/, '')) as Json) : { all_draft_store: [] };
    const key =
      Object.keys(index).find((k) => Array.isArray(index[k]) && (index[k] as Json[]).some((e) => e && typeof e === 'object' && ('draft_fold_path' in e || 'draft_id' in e))) ??
      Object.keys(index).find((k) => Array.isArray(index[k]) && /draft_store/i.test(k)) ??
      'all_draft_store';
    const list = (Array.isArray(index[key]) ? index[key] : []) as Json[];
    const like = list[0];
    // 既存の項目と同じ形にそろえる(この版の CapCut が書く項目を引き継ぐ)
    list.unshift(like ? { ...structuredClone(like), ...entry } : entry);
    index[key] = list;
    if (rawIndex !== null) await fsp.writeFile(indexFile + '.bak', rawIndex, 'utf8');
    await fsp.writeFile(indexFile, JSON.stringify(index), 'utf8');
    ctx.progress(1, '完了');
    return { draftName, draftDir: dir, appVersion: seed.version, notes };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}
