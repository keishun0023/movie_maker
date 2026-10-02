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
import { SR, type Asset, type CaptionStyle, type Project, type Timeline } from '../shared/types.js';
import { placeBackground, placeInset } from '../shared/fit.js';
import { evalMotion, motionExprs, motionOf } from '../shared/motion.js';
import { frameToSample, sampleToFrame, sourcePiecesForOutput, totalFrames } from '../shared/timemap.js';
import { timelineOf } from '../shared/project.js';
import { captionOutputTimings } from '../shared/segment.js';
import type { JobContext } from './jobs.js';
import { loadSourcePcm, readWav, renderEdited, writeWav, type Pcm16 } from './media.js';
import { requireTool, run } from './proc.js';
import { timeStretch } from '../shared/stretch.js';
import { sceneSpans } from './export.js';
import { sub } from './store.js';
import { fontEntry } from './fonts.js';

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
  private readonly files = new Map<string, string>();

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
  async importFile(src: string, kind: 'video' | 'photo' | 'music', name: string, durationUs: number, w: number, h: number, copy = true): Promise<{ file: string; localId: string }> {
    const known = this.localIds.get(src);
    if (known) return { file: this.files.get(src)!, localId: known };
    let dst = src;
    // 素材ライブラリのファイルはコピーせず、そのまま参照する(容量を食わない)。一時的に作ったファイルだけ下書きにコピーする
    if (copy) {
      const sub = kind === 'music' ? 'audio' : kind === 'photo' ? 'image' : 'video';
      const dstDir = path.join(this.dir, 'assets', sub);
      await fsp.mkdir(dstDir, { recursive: true });
      const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'media';
      dst = path.join(dstDir, safe);
      for (let i = 2; fs.existsSync(dst); i++) dst = path.join(dstDir, `${path.parse(safe).name}-${i}${path.extname(safe)}`);
      await fsp.copyFile(src, dst);
    }
    this.files.set(src, dst);
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
function textMaterial(text: string, st: CaptionStyle, W: number, fontPath = ''): Json {
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
  if (fontPath) style.font = { id: '', path: fontPath };
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

/** 見本プロジェクトの形式・版の印を引き継いで、作った中身で本体ファイルと draft_meta_info.json を書く */
async function writeDraftFromSeed(seed: Seed, b: DraftBuilder, dir: string, draftsDir: string, draftName: string, totalUs: number, W: number, H: number, fps: number): Promise<{ draftId: string; mainFile: string; nowMs: number }> {
  // 6. 本体ファイル(見本プロジェクトの形式・版の印を引き継ぎ、中身を入れ替える)
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
  draft.canvas_config = { ...canvas, width: W, height: H, ratio: canvasRatio(W, H) };
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
  return { draftId, mainFile, nowMs };
}

/** CapCut のプロジェクト一覧(root_meta_info.json)に登録する(元のファイルは .bak に残す) */
async function registerDraft(draftsDir: string, dir: string, draftId: string, draftName: string, mainFile: string, totalUs: number, nowMs: number): Promise<void> {
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
}

/** 映像・画像の素材(CapCut の materials.videos の1項目) */
function mediaMaterial(id: string, f: { file: string; localId: string }, photo: boolean, durUs: number, w: number, h: number, hasAudio: boolean): Json {
  return {
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
    has_audio: hasAudio,
    height: h,
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
    width: w,
  };
}

/** 背景(シーンごと)とワイプの映像トラックを作る */
async function addVisualTracks(b: DraftBuilder, p: Project, tl: Timeline, ctx: JobContext, notes: string[]): Promise<void> {
  const { width: W, height: H, fps } = p.export;
  const us = (frames: number) => Math.round((frames * 1_000_000) / fps);
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
    const f = await b.importFile(mediaFile(p, a), photo ? 'photo' : 'video', a.name, photo ? 5_000_000 : durUs, a.width ?? W, a.height ?? H, !a.library);
    const id = uuid();
    b.add('videos', mediaMaterial(id, f, photo, durUs, a.width ?? W, a.height ?? H, !photo && !!a.audioStreams?.length));
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
        } else if (bg.mode === 'synced' && p.narration?.assetId === a.id) {
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
}

/** 画面で描いたテロップ画像(見た目そのままで CapCut に入れる用)。位置・大きさは出力画面の px */
export interface CapcutCaptionImage {
  outStart: number;
  outEnd: number;
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 画面の縦横比(CapCut の「比率」)。original にすると最初の素材の比率に変わってしまうため、決まった比率を書く */
export function canvasRatio(W: number, H: number): string {
  const r = W / H;
  const known: [string, number][] = [['9:16', 9 / 16], ['16:9', 16 / 9], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5]];
  const hit = known.find(([, v]) => Math.abs(v - r) < 0.01);
  return hit ? hit[0] : 'original';
}

export async function exportCapcut(p: Project, draftsDir: string, ctx: JobContext, capImages: CapcutCaptionImage[] = []): Promise<CapcutResult> {
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

    // 2. 背景(シーンごと)・ワイプ
    await addVisualTracks(b, p, tl, ctx, notes);

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
      const f = await b.importFile(sub(p.id, bgm.file), 'music', bgm.name, bgm.durationSec * 1e6, 0, 0, !bgm.library);
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

    // 5. テロップ
    ctx.progress(0.8, 'テロップを並べています');
    if (capImages.length) {
      // 見た目そのまま: このアプリで描いたテロップを画像で入れる(フォント・大きさ・位置・縁取りが一致する)
      const segs = b.track('video', 'テロップ');
      for (const c of capImages) {
        const f0 = sampleToFrame(c.outStart, fps);
        const f1 = Math.min(total, Math.max(f0 + 1, sampleToFrame(c.outEnd, fps)));
        if (f1 <= f0 || c.w <= 0 || c.h <= 0) continue;
        const f = await b.importFile(c.file, 'photo', path.basename(c.file), 5_000_000, c.w, c.h);
        const id = uuid();
        b.add('videos', mediaMaterial(id, f, true, 10_800_000_000, c.w, c.h, false));
        const durUs = us(f1) - us(f0);
        const seg = segment(id, us(f0), durUs, { start: 0, duration: durUs }, { extra_material_refs: b.companions('video'), volume: 0, render_index: 2 });
        // CapCut の拡大率 1 は「画面に収まる大きさ」
        const sc = 1 / Math.min(W / c.w, H / c.h);
        seg.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: sc, y: sc }, transform: { x: (c.x + c.w / 2 - W / 2) / (W / 2), y: -(c.y + c.h / 2 - H / 2) / (H / 2) } };
        segs.push(seg);
      }
      notes.push('テロップは、このアプリの見た目そのままの画像で入れました(CapCut で文字を直すことはできません。直したい場合は「CapCut で編集できる文字」で書き出してください)。');
    } else {
      // CapCut の文字として入れる(あとから文字・位置を直せる。見た目は近い値)
      const texts = b.track('text', 'テロップ');
      const fontFiles = new Map<string, string>();
      for (const t of captionOutputTimings(p.captions, tl)) {
        const c = p.captions.find((x) => x.id === t.id);
        if (!c || !c.text.trim()) continue;
        const f0 = sampleToFrame(t.outStart, fps);
        const f1 = Math.min(total, Math.max(f0 + 1, sampleToFrame(t.outEnd, fps)));
        if (f1 <= f0) continue;
        const st = { ...p.style, ...(c.style ?? {}) } as CaptionStyle;
        // フォントは下書きの中にコピーして指定する(CapCut が読めない場合は標準フォントになる)
        let fontPath = fontFiles.get(st.fontId);
        if (fontPath === undefined) {
          const fe = fontEntry(st.fontId);
          fontPath = '';
          if (fe && !fe.isCollection && fs.existsSync(fe.file)) {
            const dst = path.join(dir, 'assets', 'font', path.basename(fe.file));
            await fsp.mkdir(path.dirname(dst), { recursive: true });
            if (!fs.existsSync(dst)) await fsp.copyFile(fe.file, dst);
            fontPath = dst;
          }
          fontFiles.set(st.fontId, fontPath);
        }
        const mat = textMaterial(c.text.trim(), st, W, fontPath);
        b.add('texts', mat);
        const seg = segment(mat.id as string, us(f0), us(f1) - us(f0), null, { extra_material_refs: b.companions('text'), render_index: 14000 });
        seg.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: st.x * 2 - 1, y: 1 - st.y * 2 } };
        texts.push(seg);
      }
      notes.push('テロップは CapCut の文字で入れました。文字の大きさ・縁取りは近い値にしてありますが、見た目が違う場合は CapCut でまとめて調整するか、「見た目そのまま(画像)」で書き出してください。');
    }

    // 6〜7. 本体ファイルと draft_meta_info.json(見本プロジェクトの形式・版の印を引き継ぎ、中身を入れ替える)
    ctx.progress(0.9, 'プロジェクトファイルを書き込んでいます');
    const { draftId, mainFile, nowMs } = await writeDraftFromSeed(seed, b, dir, draftsDir, draftName, totalUs, W, H, fps);
    // 8. CapCut のプロジェクト一覧(root_meta_info.json)に登録する
    await registerDraft(draftsDir, dir, draftId, draftName, mainFile, totalUs, nowMs);
    ctx.progress(1, '完了');
    return { draftName, draftDir: dir, appVersion: seed.version, notes };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

// ---- CapCut で作った下書きを読み込む(音声・テロップは CapCut、素材の割り当てはこのアプリ) ----

export interface CapcutDraftSummary {
  name: string;
  dir: string;
  durationSec: number;
  /** 本体ファイルの更新日時(ms) */
  modified: number;
  /** 読み取れたか(暗号化された下書きは読めない) */
  readable: boolean;
  captions: number;
  audioPieces: number;
}

export interface DraftAudioPiece {
  file: string;
  srcStartUs: number;
  srcDurUs: number;
  dstStartUs: number;
  dstDurUs: number;
  volume: number;
}

export interface DraftCaption {
  text: string;
  startUs: number;
  endUs: number;
}

export interface ParsedDraft {
  name: string;
  id: string;
  width: number;
  height: number;
  fps: number;
  durationUs: number;
  audio: DraftAudioPiece[];
  captions: DraftCaption[];
}

/** 下書きの本体を読む。暗号化などで読めなければ null */
export function readDraftTimeline(dir: string): { draft: Json; file: string; mtime: number } | null {
  for (const f of TIMELINE_FILES) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    const j = readJson(file);
    const inner = j ? unwrapTimeline(j) : null;
    if (inner) return { draft: inner, file, mtime: fs.statSync(file).mtimeMs };
  }
  return null;
}

/** 下書きの素材のパス(CapCut は下書きフォルダの中のファイルを「##_draftpath_placeholder_…_##」で書く) */
function resolveDraftPath(p: string, dir: string): string {
  const r = p.replace(/##_draftpath_placeholder_[^#]*_##/g, dir);
  return path.isAbsolute(r) ? r : path.join(dir, r);
}

/** 文字素材の中身から文字だけを取り出す(新しい形式は JSON、古い形式は <font …>[文字]</font>) */
export function textOfContent(content: unknown): string {
  if (typeof content !== 'string') return '';
  const t = content.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { text?: unknown };
      if (typeof j.text === 'string') return j.text;
    } catch {
      // 下へ
    }
  }
  const m = /\[([\s\S]*)\]/.exec(t);
  if (m && /<[^>]+>/.test(t)) return m[1]!;
  return t.replace(/<[^>]+>/g, '');
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

/** 下書きから、音声の区間(どのファイルのどこを、どこに置くか)とテロップを取り出す */
export function parseDraft(draft: Json, dir: string): ParsedDraft {
  const mats = (draft.materials ?? {}) as Record<string, unknown>;
  const byId = new Map<string, { kind: string; m: Json }>();
  for (const [kind, list] of Object.entries(mats)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) if (m && typeof m === 'object' && typeof (m as Json).id === 'string') byId.set((m as Json).id as string, { kind, m: m as Json });
  }
  const canvas = (draft.canvas_config ?? {}) as Json;
  const audio: DraftAudioPiece[] = [];
  const captions: DraftCaption[] = [];
  let durationUs = num(draft.duration);
  for (const tr of (Array.isArray(draft.tracks) ? draft.tracks : []) as Json[]) {
    const type = tr.type;
    for (const seg of (Array.isArray(tr.segments) ? tr.segments : []) as Json[]) {
      const target = (seg.target_timerange ?? {}) as Json;
      const t0 = num(target.start);
      const td = num(target.duration);
      if (td <= 0) continue;
      durationUs = Math.max(durationUs, t0 + td);
      const mat = byId.get(String(seg.material_id ?? ''));
      if (!mat) continue;
      if (type === 'text' && mat.kind === 'texts') {
        const text = textOfContent(mat.m.content).trim();
        if (text) captions.push({ text, startUs: t0, endUs: t0 + td });
        continue;
      }
      // 音のある区間(音声トラック、または音の入った動画)
      const isAudio = type === 'audio' && mat.kind === 'audios';
      const isVideo = type === 'video' && mat.kind === 'videos' && mat.m.type !== 'photo';
      if (!isAudio && !isVideo) continue;
      const volume = num(seg.volume, 1);
      if (!(volume > 0) || typeof mat.m.path !== 'string' || !mat.m.path) continue;
      const src = (seg.source_timerange ?? null) as Json | null;
      audio.push({
        file: resolveDraftPath(mat.m.path, dir),
        srcStartUs: num(src?.start),
        srcDurUs: src ? num(src.duration, td) : td,
        dstStartUs: t0,
        dstDurUs: td,
        volume,
      });
    }
  }
  captions.sort((a, b) => a.startUs - b.startUs);
  audio.sort((a, b) => a.dstStartUs - b.dstStartUs);
  return {
    name: typeof draft.name === 'string' && draft.name ? draft.name : path.basename(dir),
    id: typeof draft.id === 'string' ? draft.id : '',
    width: num(canvas.width, 1080) || 1080,
    height: num(canvas.height, 1920) || 1920,
    fps: num(draft.fps, 30) || 30,
    durationUs,
    audio,
    captions,
  };
}

/** 下書きフォルダのプロジェクト一覧(新しい順) */
export function listCapcutDrafts(draftsDir: string): CapcutDraftSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(draftsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: CapcutDraftSummary[] = [];
  for (const name of names) {
    const dir = path.join(draftsDir, name);
    if (!TIMELINE_FILES.some((f) => fs.existsSync(path.join(dir, f)))) continue;
    const t = readDraftTimeline(dir);
    if (!t) {
      const f = TIMELINE_FILES.map((x) => path.join(dir, x)).find((x) => fs.existsSync(x))!;
      out.push({ name, dir, durationSec: 0, modified: fs.statSync(f).mtimeMs, readable: false, captions: 0, audioPieces: 0 });
      continue;
    }
    const d = parseDraft(t.draft, dir);
    out.push({ name: d.name, dir, durationSec: d.durationUs / 1e6, modified: t.mtime, readable: true, captions: d.captions.length, audioPieces: d.audio.length });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/**
 * 下書きの音声(全トラックを重ねたもの)を 48kHz ステレオの WAV にする。
 * 区間ごとに元のファイルの使う所を切り出し、速さを変えた区間は音程を保ったまま伸縮する。
 */
export async function renderDraftAudio(d: ParsedDraft, outFile: string, ctx: JobContext): Promise<string[]> {
  const ffmpeg = requireTool('ffmpeg');
  const notes: string[] = [];
  const total = Math.max(1, Math.round((d.durationUs / 1e6) * SR));
  const acc = new Float32Array(total * 2);
  const cache = new Map<string, Pcm16 | null>();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdm-capcut-'));
  try {
    const files = [...new Set(d.audio.map((a) => a.file))];
    for (const [i, file] of files.entries()) {
      ctx.progress(0.1 + 0.6 * (i / Math.max(1, files.length)), `音声を読み込んでいます (${i + 1}/${files.length})`);
      if (!fs.existsSync(file)) {
        notes.push(`素材のファイルが見つかりませんでした: ${file}`);
        cache.set(file, null);
        continue;
      }
      const wav = path.join(tmpDir, `${i}.wav`);
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', String(SR), '-c:a', 'pcm_s16le', wav], { signal: ctx.signal });
      cache.set(file, r.code === 0 && fs.existsSync(wav) ? await readWav(wav) : null);
    }
    ctx.progress(0.75, '音声を並べています');
    for (const pc of d.audio) {
      const src = cache.get(pc.file);
      if (!src) continue;
      const ch = src.channels;
      const frames = src.data.length / ch;
      const a = Math.max(0, Math.min(frames, Math.round((pc.srcStartUs / 1e6) * SR)));
      const b = Math.max(a, Math.min(frames, Math.round(((pc.srcStartUs + pc.srcDurUs) / 1e6) * SR)));
      const want = Math.round((pc.dstDurUs / 1e6) * SR);
      if (b <= a || want <= 0) continue;
      const raw = src.data.subarray(a * ch, b * ch);
      const piece = Math.abs(b - a - want) > 2 ? timeStretch(raw, ch, want) : raw;
      const o0 = Math.round((pc.dstStartUs / 1e6) * SR);
      const len = Math.min(want, piece.length / ch, total - o0);
      const f = Math.min(Math.round(0.004 * SR), Math.floor(len / 2));
      for (let k = 0; k < len; k++) {
        let g = pc.volume;
        if (k < f) g *= k / f;
        else if (len - 1 - k < f) g *= (len - 1 - k) / f;
        for (let c = 0; c < 2; c++) acc[(o0 + k) * 2 + c]! += piece[k * ch + Math.min(c, ch - 1)]! * g;
      }
    }
    const out = new Int16Array(total * 2);
    for (let i = 0; i < out.length; i++) {
      const v = acc[i]!;
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
    }
    await writeWav(outFile, { sampleRate: SR, channels: 2, data: out });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return notes;
}

/**
 * CapCut で作った下書きに、このアプリで割り当てた素材(背景・ワイプ)を加えた「素材入り」の下書きを新しく作る。
 * 元の下書きの音声・テロップ・エフェクトはそのまま残す(元の下書きは書き換えない)。
 */
export async function exportCapcutInto(p: Project, draftsDir: string, ctx: JobContext): Promise<CapcutResult> {
  const notes: string[] = [];
  const tl = timelineOf(p);
  const from = p.capcut;
  if (!from || !tl) throw new Error('CapCut から読み込んだプロジェクトではありません。');
  if (!fs.existsSync(from.dir)) throw new Error(`読み込んだ CapCut のプロジェクトが見つかりません: ${from.dir}`);
  if (await capcutRunning()) {
    throw new Error('CapCut が起動しています。CapCut を終了してから、もう一度書き出してください(起動中に書き込むと、CapCut の終了時にプロジェクト一覧から消えてしまいます)。');
  }
  const base = readDraftTimeline(from.dir);
  if (!base) throw new Error('CapCut のプロジェクトを読み取れませんでした(暗号化されている可能性があります)。');
  if (Math.abs(base.mtime - from.mtime) > 1000) {
    notes.push('読み込んだ後に CapCut でこのプロジェクトが変更されています。音声やテロップの位置を変えた場合は、素材の位置とずれていることがあります(このアプリで「CapCut から読み込み直す」をすると合わせられます)。');
  }
  const baseName = safeName(`${path.basename(from.dir)} 素材入り`);
  let draftName = baseName;
  for (let i = 2; fs.existsSync(path.join(draftsDir, draftName)); i++) draftName = `${baseName} (${i})`;
  const dir = path.join(draftsDir, draftName);
  ctx.progress(0.03, '元のプロジェクトを複製しています');
  await fsp.cp(from.dir, dir, { recursive: true });
  try {
    const b = new DraftBuilder(dir);
    await addVisualTracks(b, p, tl, ctx, notes);
    ctx.progress(0.9, 'プロジェクトファイルを書き込んでいます');
    const draftId = uuid();
    const nowMs = Date.now();
    const draft = structuredClone(base.draft);
    const materials = (draft.materials ?? {}) as Record<string, Json[]>;
    for (const [k, list] of Object.entries(b.materials)) materials[k] = [...(Array.isArray(materials[k]) ? materials[k] : []), ...list];
    draft.materials = materials;
    // 素材の映像トラックは、元の映像トラックの上(テロップの下)に入れる
    const tracks = (Array.isArray(draft.tracks) ? draft.tracks : []) as Json[];
    const ours = b.tracks.filter((t) => (t.segments as Json[]).length > 0);
    let at = 0;
    tracks.forEach((t, i) => {
      if (t.type === 'video') at = i + 1;
    });
    draft.tracks = [...tracks.slice(0, at), ...ours, ...tracks.slice(at)];
    draft.id = draftId;
    draft.name = draftName;
    const totalUs = Math.max(num(draft.duration), Math.round((tl.outSamples / SR) * 1e6));
    draft.duration = totalUs;
    if (typeof draft.update_time === 'number') draft.update_time = Math.floor(nowMs / 1000);
    const written: string[] = [];
    for (const f of TIMELINE_FILES) {
      const file = path.join(dir, f);
      if (!fs.existsSync(file)) continue;
      const raw = readJson(file);
      const out = raw ? wrapTimeline(raw, draft) : null;
      if (out) {
        await fsp.writeFile(file, JSON.stringify(out), 'utf8');
        written.push(f);
      }
    }
    if (!written.length) throw new Error('CapCut のプロジェクトファイルを書き換えられませんでした。');
    const mainFile = path.join(dir, written.includes('draft_info.json') ? 'draft_info.json' : written[0]!);
    const metaFile = path.join(dir, 'draft_meta_info.json');
    const meta: Json = readJson(metaFile) ?? {};
    const groups: Json[] = Array.isArray(meta.draft_materials) ? (meta.draft_materials as Json[]) : [];
    const g0 = groups.find((g) => g.type === 0);
    if (g0) g0.value = [...(Array.isArray(g0.value) ? (g0.value as Json[]) : []), ...b.metaEntries];
    else groups.unshift({ type: 0, value: b.metaEntries });
    Object.assign(meta, {
      draft_fold_path: dir,
      draft_id: draftId,
      draft_json_file: mainFile,
      draft_materials: groups,
      draft_name: draftName,
      draft_root_path: draftsDir,
      tm_draft_create: nowMs * 1000,
      tm_draft_modified: nowMs * 1000,
      tm_duration: totalUs,
    });
    await fsp.writeFile(metaFile, JSON.stringify(meta), 'utf8');
    await registerDraft(draftsDir, dir, draftId, draftName, mainFile, totalUs, nowMs);
    notes.push('音声・テロップ・エフェクトは元の CapCut のプロジェクトのままです。素材は「背景」「ワイプ」の映像トラックとして入っています(元のプロジェクトは変更していません)。');
    ctx.progress(1, '完了');
    return { draftName, draftDir: dir, appVersion: String(((draft.platform ?? {}) as Json).app_version ?? ''), notes };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

// ---- CapCut の声で台本を読み上げる(台本 → 読み上げ用の下書き → CapCut で読み上げ → 音声を読み込む) ----

async function seedFor(draftsDir: string): Promise<Seed> {
  if (!fs.existsSync(draftsDir)) {
    throw new Error(`CapCut の下書きフォルダが見つかりません: ${draftsDir}\nCapCut をインストールして一度起動するか、CapCut の「設定 → 下書きの場所」に表示される場所を指定してください。`);
  }
  if (await capcutRunning()) throw new Error('CapCut が起動しています。CapCut を終了してから、もう一度押してください。');
  const found = findSeed(draftsDir);
  if (!found.seed) {
    throw new Error(
      found.projects > 0
        ? `下書きフォルダのプロジェクト(${found.projects}件)を読み取れませんでした(暗号化されている可能性があります)。`
        : 'CapCut のプロジェクトが1つもありません。CapCut で「新しいプロジェクト」を1つ作ってそのまま閉じ、CapCut を終了してから、もう一度押してください。',
    );
  }
  return found.seed;
}

/** 台本の行を文字クリップとして並べた「読み上げ用」の下書きを作る(CapCut で全部選んで「テキスト読み上げ」する) */
export async function createTtsDraft(p: Project, lines: string[], draftsDir: string, ctx: JobContext): Promise<CapcutResult> {
  const seed = await seedFor(draftsDir);
  const { width: W, height: H, fps } = p.export;
  const baseName = safeName(`${p.name} 読み上げ用`);
  let draftName = baseName;
  for (let i = 2; fs.existsSync(path.join(draftsDir, draftName)); i++) draftName = `${baseName} (${i})`;
  const dir = path.join(draftsDir, draftName);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const b = new DraftBuilder(dir);
    const texts = b.track('text', '台本');
    let t = 0;
    for (const line of lines) {
      // 読み上げにかかりそうな長さ(CapCut が読み上げると、音声の長さに合わせて並ぶ)
      const durUs = Math.round(Math.max(1, Math.min(10, Array.from(line).length * 0.17)) * 1e6);
      const mat = textMaterial(line, { ...p.style, maxWidth: W * 0.9 }, W);
      b.add('texts', mat);
      const seg = segment(mat.id as string, t, durUs, null, { extra_material_refs: b.companions('text'), render_index: 14000 });
      seg.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } };
      texts.push(seg);
      t += durUs;
    }
    ctx.progress(0.8, 'プロジェクトファイルを書き込んでいます');
    const { draftId, mainFile, nowMs } = await writeDraftFromSeed(seed, b, dir, draftsDir, draftName, t, W, H, fps);
    await registerDraft(draftsDir, dir, draftId, draftName, mainFile, t, nowMs);
    ctx.progress(1, '完了');
    return { draftName, draftDir: dir, appVersion: seed.version, notes: [] };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

export interface TtsLine {
  text: string;
  /** つなげた音声の中での位置(マイクロ秒) */
  startUs: number;
  endUs: number;
}

/**
 * CapCut で読み上げた下書きから、行ごとの読み上げ音声を順につなげて1本の音声にする。
 * 行の間には少し無音を入れる(このアプリの無音カットで、好みの間に詰める)。
 */
export async function renderTtsAudio(draft: Json, dir: string, outFile: string, ctx: JobContext): Promise<{ lines: TtsLine[]; notes: string[] }> {
  const d = parseDraft(draft, dir);
  if (d.audio.length === 0) throw new Error('まだ読み上げの音声がありません。CapCut でこのプロジェクトを開き、文字クリップを全部選んで「テキスト読み上げ」をしてから、CapCut を終了してください。');
  if (d.captions.length === 0) throw new Error('台本の文字クリップが見つかりません。');
  // 行ごとに、その行の位置から始まる音声の区間を集める
  const lineAudio: DraftAudioPiece[][] = d.captions.map(() => []);
  for (const a of d.audio) {
    let best = 0;
    let bestD = Infinity;
    d.captions.forEach((c, i) => {
      const dist = a.dstStartUs >= c.startUs - 300_000 ? Math.abs(a.dstStartUs - c.startUs) : Infinity;
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    if (bestD === Infinity) best = 0;
    lineAudio[best]!.push(a);
  }
  const GAP_US = 350_000;
  const pieces: DraftAudioPiece[] = [];
  const lines: TtsLine[] = [];
  const notes: string[] = [];
  let cursor = 0;
  d.captions.forEach((c, i) => {
    const list = lineAudio[i]!;
    if (!list.length) {
      notes.push(`「${c.text.slice(0, 20)}」の読み上げ音声が見つかりませんでした(この行はテロップだけになります)。`);
      return;
    }
    const first = Math.min(...list.map((a) => a.dstStartUs));
    const last = Math.max(...list.map((a) => a.dstStartUs + a.dstDurUs));
    for (const a of list) pieces.push({ ...a, dstStartUs: cursor + (a.dstStartUs - first) });
    lines.push({ text: c.text, startUs: cursor, endUs: cursor + (last - first) });
    cursor += last - first + GAP_US;
  });
  const n = await renderDraftAudio({ ...d, audio: pieces, durationUs: cursor }, outFile, ctx);
  return { lines, notes: [...notes, ...n] };
}

// ---- CapCut で使っている素材(このアプリの素材ライブラリにコピーせず加える用) ----

export interface CapcutMediaFile {
  file: string;
  name: string;
  size: number;
  /** 使っている CapCut のプロジェクト名 */
  drafts: string[];
}

/** CapCut の各プロジェクトに取り込まれている素材ファイル(下書きフォルダの外にあり、今もあるもの) */
export function listCapcutMedia(draftsDir: string): CapcutMediaFile[] {
  const byFile = new Map<string, CapcutMediaFile>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(draftsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const root = path.resolve(draftsDir) + path.sep;
  for (const name of names) {
    const dir = path.join(draftsDir, name);
    const files: string[] = [];
    const meta = readJson(path.join(dir, 'draft_meta_info.json'));
    for (const g of (Array.isArray(meta?.draft_materials) ? meta!.draft_materials : []) as Json[]) {
      for (const v of (Array.isArray(g.value) ? g.value : []) as Json[]) if (typeof v.file_Path === 'string' && v.file_Path) files.push(resolveDraftPath(v.file_Path, dir));
    }
    const t = readDraftTimeline(dir);
    const mats = (t?.draft.materials ?? {}) as Record<string, unknown>;
    for (const kind of ['videos', 'audios']) {
      for (const m of (Array.isArray(mats[kind]) ? mats[kind] : []) as Json[]) if (typeof m.path === 'string' && m.path) files.push(resolveDraftPath(m.path, dir));
    }
    for (const f of files) {
      const abs = path.resolve(f);
      if (abs.startsWith(root)) continue; // 下書きの中のファイル(書き出したテロップ・読み上げ音声など)は除く
      const hit = byFile.get(abs);
      if (hit) {
        if (!hit.drafts.includes(name)) hit.drafts.push(name);
        continue;
      }
      let size = 0;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      byFile.set(abs, { file: abs, name: path.basename(abs), size, drafts: [name] });
    }
  }
  return [...byFile.values()];
}
