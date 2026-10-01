// FFmpeg / ffprobe を使った素材の解析・変換と、WAV の読み書き。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisData, Asset, AssetKind, AudioStreamInfo, Timeline } from '../shared/types.js';
import { computeAnalysis, FRAME_SAMPLES } from '../shared/silence.js';
import { timeStretch } from '../shared/stretch.js';
import { SR } from '../shared/types.js';
import { requireTool, run, runOk } from './proc.js';
import { atomicWrite, sub } from './store.js';

export const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.aif', '.aiff', '.ogg', '.caf'];
export const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tif', '.tiff'];
export const FONT_EXT = ['.ttf', '.otf', '.ttc'];
/** ブラウザでそのまま表示できる画像 */
export const BROWSER_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

export function allowedExt(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  return [...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT, ...FONT_EXT].includes(ext) ? ext : null;
}

interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

interface ProbeResult {
  streams: ProbeStream[];
  format: { format_name?: string; duration?: string; start_time?: string };
}

export async function probe(file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const ffprobe = requireTool('ffprobe');
  const opt = signal ? { signal } : {};
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], opt);
  if (r.code !== 0) {
    throw new Error('ファイルを読み込めませんでした(壊れているか、対応していない形式です)。' + (r.stderr.trim() ? `\n${r.stderr.trim().split('\n').slice(-2).join('\n')}` : ''));
  }
  return JSON.parse(r.stdout) as ProbeResult;
}

function parseRate(r?: string): number | undefined {
  if (!r) return undefined;
  const [a, b] = r.split('/').map(Number);
  if (!a || !b) return undefined;
  return a / b;
}

function rotationOf(s: ProbeStream): number {
  const sd = s.side_data_list?.find((d) => typeof d.rotation === 'number');
  let rot = sd?.rotation ?? (s.tags?.rotate ? Number(s.tags.rotate) : 0);
  rot = ((Math.round(rot) % 360) + 360) % 360;
  return rot;
}

/** ffprobe の結果から素材情報を組み立てる */
export function describeMedia(pr: ProbeResult, ext: string): Omit<Asset, 'id' | 'name' | 'file' | 'size' | 'hash' | 'importedAt'> {
  const warnings: string[] = [];
  const video = pr.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = pr.streams.filter((s) => s.codec_type === 'audio');
  const duration = Number(pr.format.duration ?? video?.duration ?? audios[0]?.duration ?? 0) || undefined;
  const isImageExt = IMAGE_EXT.includes(ext);
  const isImageFormat = /image2|_pipe|png|mjpeg|webp|gif/.test(pr.format.format_name ?? '') && !VIDEO_EXT.includes(ext);
  let kind: AssetKind;
  if (video && (isImageExt || isImageFormat) && (!duration || duration < 0.2 || isImageExt)) kind = 'image';
  else if (video) kind = 'video';
  else if (audios.length > 0) kind = 'audio';
  else throw new Error('映像も音声も含まれていないファイルです。');

  const audioStreams: AudioStreamInfo[] = audios.map((s, i) => {
    const info: AudioStreamInfo = {
      index: s.index,
      audioIndex: i,
      codec: s.codec_name ?? '?',
      channels: s.channels ?? 0,
      sampleRate: Number(s.sample_rate ?? 0),
    };
    if (s.tags?.language) info.language = s.tags.language;
    if (s.tags?.title ?? s.tags?.handler_name) info.title = s.tags?.title ?? s.tags?.handler_name;
    return info;
  });

  const out: Omit<Asset, 'id' | 'name' | 'file' | 'size' | 'hash' | 'importedAt'> = { kind, status: 'ok', warnings };
  if (duration && kind !== 'image') out.durationSec = duration;
  if (video) {
    const rot = rotationOf(video);
    const w = video.width ?? 0;
    const h = video.height ?? 0;
    const swap = rot === 90 || rot === 270;
    out.width = swap ? h : w;
    out.height = swap ? w : h;
    if (rot) out.rotation = rot;
    if (kind === 'video') {
      const r = parseRate(video.r_frame_rate);
      const avg = parseRate(video.avg_frame_rate);
      if (avg) out.fps = Math.round(avg * 1000) / 1000;
      if (r && avg && Math.abs(r - avg) / r > 0.01) {
        out.vfr = true;
        warnings.push('可変フレームレートの動画です。書き出し時に30fpsへそろえます。');
      }
      if (video.codec_name) out.videoCodec = video.codec_name;
      out.videoStartSec = Number(video.start_time ?? 0) || 0;
      if (audios[0]) out.audioStartSec = Number(audios[0].start_time ?? 0) || 0;
      if (audios.length === 0) warnings.push('音声トラックがありません。背景素材としてのみ使えます。');
      if (w && h && w > h && !swap) warnings.push('横向きの動画です。背景に使う場合はトリミング位置を確認してください。');
    }
  }
  if (audioStreams.length) out.audioStreams = audioStreams;
  if (audioStreams.length > 1) warnings.push(`音声トラックが${audioStreams.length}本あります。ナレーションに使うトラックを選んでください。`);
  return out;
}

/** ストリームを書き込みながらハッシュを計算する */
export async function sha1File(file: string): Promise<string> {
  const h = crypto.createHash('sha1');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

export const proxyPath = (projectId: string, assetId: string, ext = '.mp4') => sub(projectId, 'work', `proxy-${assetId}${ext}`);
export const thumbPath = (projectId: string, assetId: string) => sub(projectId, 'work', `thumb-${assetId}.jpg`);

/** プレビュー用の軽い動画(回転適用・30fps・H.264)とサムネイルを作る */
export async function makePreviewFiles(projectId: string, asset: Asset, signal?: AbortSignal, onProgress?: (p: number) => void): Promise<void> {
  const ffmpeg = requireTool('ffmpeg');
  const src = sub(projectId, asset.file);
  const opt = signal ? { signal } : {};
  if (asset.kind === 'video') {
    const t = Math.min(1, (asset.durationSec ?? 0) / 2);
    await run(ffmpeg, ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumbPath(projectId, asset.id)], opt);
    const tmp = proxyPath(projectId, asset.id) + '.part.mp4';
    const dur = asset.durationSec ?? 0;
    // Mac ではハードウェアの読み込み・書き出しを使う(大きな動画でも速い)。失敗したら通常の方法でやり直す
    const mac = process.platform === 'darwin';
    const encode = (hw: boolean) =>
      runOk(
        ffmpeg,
        [
          '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats',
          ...(hw ? ['-hwaccel', 'videotoolbox'] : []),
          '-i', src,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', "fps=30,scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
          ...(hw ? ['-c:v', 'h264_videotoolbox', '-b:v', '3M'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28']),
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
          '-movflags', '+faststart',
          tmp,
        ],
        {
          ...opt,
          onStdout: (c) => {
            const m = /out_time_us=(\d+)/.exec(c.toString());
            if (m && dur > 0 && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / dur));
          },
          collectStdout: false,
        },
      );
    try {
      await encode(mac);
    } catch (e) {
      if (!mac || signal?.aborted) throw e;
      await encode(false);
    }
    await fsp.rename(tmp, proxyPath(projectId, asset.id));
  } else if (asset.kind === 'image') {
    await runOk(ffmpeg, ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumbPath(projectId, asset.id)], opt);
    const ext = path.extname(asset.file).toLowerCase();
    if (!BROWSER_IMAGE_EXT.includes(ext)) {
      await runOk(ffmpeg, ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', "scale=w='min(2160,iw)':h='min(2160,ih)':force_original_aspect_ratio=decrease", '-q:v', '2', proxyPath(projectId, asset.id, '.jpg')], opt);
    }
  }
}

// ---- WAV ----

export interface Pcm16 {
  sampleRate: number;
  channels: number;
  data: Int16Array; // インターリーブ
}

export function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export async function writeWav(file: string, pcm: Pcm16): Promise<void> {
  const body = Buffer.from(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength);
  await atomicWrite(file, Buffer.concat([wavHeader(body.length, pcm.sampleRate, pcm.channels), body]));
}

export async function readWav(file: string): Promise<Pcm16> {
  const buf = await fsp.readFile(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAVではありません');
  let off = 12;
  let channels = 2;
  let sampleRate = SR;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      if (bits !== 16) throw new Error('16bit PCM のみ対応');
    } else if (id === 'data') {
      if (size === 0xffffffff || off + 8 + size > buf.length) size = buf.length - off - 8;
      const bytes = size - (size % (2 * channels));
      // Mac/x86 はリトルエンディアンなのでそのままコピーできる
      const ab = new ArrayBuffer(bytes);
      new Uint8Array(ab).set(buf.subarray(off + 8, off + 8 + bytes));
      return { sampleRate, channels, data: new Int16Array(ab) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAVのデータが見つかりません');
}

export function toMonoFloat(pcm: Pcm16): Float32Array {
  const n = pcm.data.length / pcm.channels;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < pcm.channels; c++) s += pcm.data[i * pcm.channels + c]!;
    out[i] = s / pcm.channels / 32768;
  }
  return out;
}

// ---- ナレーション ----

export function narrationKey(asset: Asset, audioIndex: number): string {
  return crypto.createHash('sha1').update(`${asset.hash}:${audioIndex}`).digest('hex').slice(0, 16);
}

export const sourceWavPath = (projectId: string, key: string) => sub(projectId, 'work', `source-${key}.wav`);
export const asrWavPath = (projectId: string, key: string) => sub(projectId, 'work', `asr16k-${key}.wav`);
export const analysisPath = (projectId: string, key: string) => sub(projectId, 'work', `analysis-${key}.json`);

/** ナレーション音声を抽出(48kHz/16bit/ステレオ と 認識用16kHzモノラル)し、音量を解析する */
export async function prepareNarration(
  projectId: string,
  asset: Asset,
  audioIndex: number,
  signal: AbortSignal,
  progress: (p: number, m?: string) => void,
): Promise<{ key: string; durationSamples: number; warnings: string[] }> {
  const ffmpeg = requireTool('ffmpeg');
  const key = narrationKey(asset, audioIndex);
  const src = sub(projectId, asset.file);
  const wav = sourceWavPath(projectId, key);
  const asr = asrWavPath(projectId, key);
  const warnings: string[] = [];
  if (!asset.audioStreams || asset.audioStreams.length <= audioIndex) throw new Error('この素材には選択した音声トラックがありません。');
  if (!fs.existsSync(wav)) {
    progress(0.05, '音声を取り出しています');
    const tmp = wav + '.part.wav';
    await runOk(ffmpeg, ['-y', '-v', 'error', '-i', src, '-map', `0:a:${audioIndex}`, '-vn', '-ac', '2', '-ar', String(SR), '-c:a', 'pcm_s16le', '-f', 'wav', tmp], { signal });
    await fsp.rename(tmp, wav);
  }
  if (!fs.existsSync(asr)) {
    progress(0.3, '認識用の音声を作っています');
    const tmp = asr + '.part.wav';
    await runOk(ffmpeg, ['-y', '-v', 'error', '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', tmp], { signal });
    await fsp.rename(tmp, asr);
  }
  progress(0.5, '音量を解析しています');
  const pcm = await readWav(wav);
  const mono = toMonoFloat(pcm);
  const analysis = computeAnalysis(mono, FRAME_SAMPLES);
  await atomicWrite(analysisPath(projectId, key), JSON.stringify(analysis));
  const maxPeak = analysis.peak.reduce((a, b) => Math.max(a, b), 0);
  if (maxPeak < 0.002) warnings.push('音声がほぼ無音です。正しいトラックを選んでいるか確認してください。');
  if (mono.length < SR * 0.5) warnings.push('音声が非常に短いです。');
  progress(1, '完了');
  return { key, durationSamples: mono.length, warnings };
}

export async function loadAnalysis(projectId: string, key: string): Promise<AnalysisData> {
  return JSON.parse(await fsp.readFile(analysisPath(projectId, key), 'utf8')) as AnalysisData;
}

/**
 * 対応表に従って編集後のナレーションを作る。
 * - カット点には短いフェードをかける(区間の内側だけで行うので尺は変わらない)
 * - 被せ(xfadeMs)がある場合は、カットで削った前後の音声を少しだけ使ってクロスフェードで重ねる
 * - 速さを変えた区間は音程を保ったまま伸縮する
 * padToSamples を指定すると末尾を無音で延ばす。
 */
export function renderEdited(source: Pcm16, tl: Timeline, gainDb = 0, padToSamples?: number): Pcm16 {
  const ch = source.channels;
  const total = Math.max(tl.outSamples, padToSamples ?? 0);
  const acc = new Float32Array(total * ch);
  const sr = source.sampleRate;
  const fade = Math.round((tl.fadeMs / 1000) * sr);
  const xf = Math.round(((tl.xfadeMs ?? 0) / 1000) * sr);
  const gain = Math.pow(10, gainDb / 20);
  const srcFrames = source.data.length / ch;
  const segs = tl.segments;
  const outLen = (i: number) => segs[i]!.outEnd - segs[i]!.outStart;
  // 区間 i と i+1 の境目で重ねる長さ(出力サンプル、片側)
  const half: number[] = segs.map((seg, i) => {
    const next = segs[i + 1];
    if (!xf || !next || next.srcStart <= seg.srcEnd) return 0;
    const gapOut = Math.floor((next.srcStart - seg.srcEnd) / 2 / Math.max(seg.speed ?? 1, next.speed ?? 1));
    return Math.max(0, Math.min(Math.floor(xf / 2), gapOut, Math.floor(outLen(i) / 2), Math.floor(outLen(i + 1) / 2)));
  });
  segs.forEach((seg, i) => {
    const prev = segs[i - 1];
    const next = segs[i + 1];
    const speed = seg.speed ?? 1;
    const cutBefore = prev ? prev.srcEnd < seg.srcStart : seg.srcStart > 0;
    const cutAfter = next ? seg.srcEnd < next.srcStart : seg.srcEnd < tl.srcSamples;
    const hL = i > 0 ? half[i - 1]! : 0;
    const hR = half[i]!;
    // 重ねる分だけ前後に広げて取り出す
    const a = Math.max(0, Math.min(srcFrames, seg.srcStart - Math.round(hL * speed)));
    const b = Math.max(a, Math.min(srcFrames, seg.srcEnd + Math.round(hR * speed)));
    const want = outLen(i) + hL + hR;
    const raw = source.data.subarray(a * ch, b * ch);
    const piece = speed !== 1 || raw.length / ch !== want ? (speed !== 1 ? timeStretch(raw, ch, want) : raw) : raw;
    const len = Math.min(want, piece.length / ch);
    const o0 = seg.outStart - hL;
    const f = Math.min(fade, Math.floor(len / 2));
    for (let k = 0; k < len; k++) {
      const oi = o0 + k;
      if (oi < 0 || oi >= total) continue;
      let g = gain;
      if (hL > 0 && k < 2 * hL) g *= Math.sin(((k + 0.5) / (2 * hL)) * (Math.PI / 2));
      else if (hL === 0 && cutBefore && f > 0 && k < f) g *= k / f;
      const fromEnd = len - 1 - k;
      if (hR > 0 && fromEnd < 2 * hR) g *= Math.sin(((fromEnd + 0.5) / (2 * hR)) * (Math.PI / 2));
      else if (hR === 0 && cutAfter && f > 0 && fromEnd < f) g *= fromEnd / f;
      for (let c = 0; c < ch; c++) acc[oi * ch + c]! += piece[k * ch + c]! * g;
    }
  });
  const out = new Int16Array(total * ch);
  for (let i = 0; i < out.length; i++) {
    const v = acc[i]!;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }
  return { sampleRate: source.sampleRate, channels: ch, data: out };
}

const pcmCache = new Map<string, { at: number; pcm: Pcm16 }>();

export async function loadSourcePcm(projectId: string, key: string): Promise<Pcm16> {
  const k = `${projectId}:${key}`;
  const hit = pcmCache.get(k);
  if (hit) {
    hit.at = Date.now();
    return hit.pcm;
  }
  const pcm = await readWav(sourceWavPath(projectId, key));
  pcmCache.set(k, { at: Date.now(), pcm });
  if (pcmCache.size > 3) {
    const oldest = [...pcmCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pcmCache.delete(oldest[0]);
  }
  return pcm;
}

export const editedWavPath = (projectId: string, hash: string) => sub(projectId, 'work', `edited-${hash}.wav`);

const editedInFlight = new Map<string, Promise<string>>();

export async function ensureEditedWav(projectId: string, key: string, tl: Timeline): Promise<string> {
  const file = editedWavPath(projectId, tl.hash + '-' + key.slice(0, 6));
  if (fs.existsSync(file)) {
    // 使い回すときは更新日時を新しくして、掃除で消されないようにする(再生中の音声が消えるのを防ぐ)
    const now = new Date();
    await fsp.utimes(file, now, now).catch(() => undefined);
    return file;
  }
  // 同じ音声を同時に頼まれたら、作るのは1回だけ
  const running = editedInFlight.get(file);
  if (running) return running;
  const job = buildEditedWav(projectId, key, tl, file).finally(() => editedInFlight.delete(file));
  editedInFlight.set(file, job);
  return job;
}

async function buildEditedWav(projectId: string, key: string, tl: Timeline, file: string): Promise<string> {
  const src = await loadSourcePcm(projectId, key);
  await writeWav(file, renderEdited(src, tl));
  // 古い編集音声を掃除(最新20件だけ残す)
  const dir = path.dirname(file);
  const files = (await fsp.readdir(dir)).filter((f) => f.startsWith('edited-'));
  if (files.length > 20) {
    const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fsp.stat(path.join(dir, f))).mtimeMs })));
    stats.sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, stats.length - 20)) await fsp.rm(path.join(dir, s.f), { force: true });
  }
  return file;
}
