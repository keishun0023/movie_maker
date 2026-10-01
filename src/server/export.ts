// 完成動画の書き出し。
// 1) シーンごとに背景を 1080x1920/30fps の中間動画にする(フレーム数は絶対位置から計算)
// 2) 連結 3) テロップの透明PNG列を重ねる 4) ナレーション・BGM・背景音をまとめる
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SR, type Asset, type Project, type Scene, type Timeline } from '../shared/types.js';
import { cropScaleFor, placeBackground, placeInset } from '../shared/fit.js';
import { motionExprs, motionOf, toFfmpegExpr } from '../shared/motion.js';
import { frameToSample, sampleToFrame, sourcePiecesForOutput, srcToOut, totalFrames } from '../shared/timemap.js';
import { timelineOf } from '../shared/project.js';
import type { JobContext } from './jobs.js';
import { loadSourcePcm, probe, renderEdited, writeWav } from './media.js';
import { requireTool, run, runOk } from './proc.js';
import { sub } from './store.js';

export interface CaptionImage {
  id: string;
  outStart: number;
  outEnd: number;
  text: string;
  /** プロジェクトの一時フォルダ内のPNG */
  file: string;
}

export interface ExportJobInput {
  project: Project;
  captions: CaptionImage[];
  workDir: string;
  baseName: string;
}

export interface ExportResult {
  file: string;
  name: string;
  size: number;
  durationSec: number;
  width: number;
  height: number;
  extras: string[];
  frames: { file: string; timeSec: number; captionId: string | null }[];
}

function hexColor(c: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c.trim());
  return '0x' + (m ? m[1]! : '161616');
}

function assetOf(p: Project, id: string): Asset {
  const a = p.assets.find((x) => x.id === id);
  if (!a || a.status !== 'ok') throw new Error('シーンに割り当てた素材が見つかりません。素材を割り当て直してください。');
  return a;
}

/** 書き出しに使う素材ファイル(画像は向きをそろえた変換済みファイル) */
function mediaFile(projectId: string, a: Asset): string {
  if (a.kind === 'image' && a.proxy) return sub(projectId, a.proxy);
  return sub(projectId, a.file);
}

const x264Fast = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p'];

interface SceneSpan {
  scene: Scene;
  f0: number;
  f1: number;
}

export function sceneSpans(p: Project, tl: Timeline, fps: number): SceneSpan[] {
  const total = totalFrames(tl.outSamples, fps);
  const spans = p.scenes.map((s, i) => {
    const f0 = i === 0 ? 0 : sampleToFrame(srcToOut(tl, s.srcStart), fps);
    const f1 = i === p.scenes.length - 1 ? total : sampleToFrame(srcToOut(tl, s.srcEnd), fps);
    return { scene: s, f0, f1: Math.min(total, f1) };
  });
  return spans.filter((s) => s.f1 > s.f0);
}

async function renderSceneSegment(
  p: Project,
  tl: Timeline,
  span: SceneSpan,
  out: string,
  signal: AbortSignal,
): Promise<void> {
  const ffmpeg = requireTool('ffmpeg');
  const { width: W, height: H, fps } = p.export;
  const n = span.f1 - span.f0;
  const dur = n / fps;
  const bgc = `color=c=${hexColor(p.export.bgColor)}:s=${W}x${H}:r=${fps},format=yuv420p`;
  const args: string[] = ['-y', '-v', 'error'];
  const filters: string[] = [];
  let inputs = 0;
  let cur = '[base]';
  filters.push(`${bgc}[base]`);
  const bg = span.scene.bg;
  if (bg) {
    const a = assetOf(p, bg.assetId);
    const srcW = a.width ?? W;
    const srcH = a.height ?? H;
    const place = placeBackground(srcW, srcH, W, H, bg);
    const cs = cropScaleFor(srcW, srcH, W, H, place);
    const file = mediaFile(p.id, a);
    let chain: string;
    if (a.kind === 'image') {
      args.push('-loop', '1', '-framerate', String(fps), '-i', file);
      chain = `[${inputs}:v]`;
      inputs++;
    } else if (bg.mode === 'synced' && p.narration && p.narration.assetId === a.id) {
      args.push('-i', file);
      const o0 = frameToSample(span.f0, fps);
      const o1 = frameToSample(span.f1, fps);
      const pieces = sourcePiecesForOutput(tl, o0, o1);
      const offset = a.audioStartSec ?? 0;
      const labels: string[] = [];
      pieces.forEach((pc, k) => {
        const s = offset + pc.srcStart / SR;
        // 足した間の所は、その位置から映像をそのまま流す
        const e = pc.gap ? s + (pc.outEnd - pc.outStart) / SR : offset + pc.srcEnd / SR;
        // 話す速さを変えたシーンは映像も同じ速さにする(口の動きと音声をそろえる)
        const pts = pc.speed && pc.speed !== 1 ? `(PTS-STARTPTS)/${pc.speed}` : 'PTS-STARTPTS';
        filters.push(`[${inputs}:v]trim=start=${s.toFixed(6)}:end=${e.toFixed(6)},setpts=${pts}[pc${k}]`);
        labels.push(`[pc${k}]`);
      });
      if (labels.length === 0) {
        filters.push(`[${inputs}:v]trim=end_frame=1,setpts=PTS-STARTPTS[pc0]`);
        labels.push('[pc0]');
      }
      filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0,fps=${fps},tpad=stop_mode=clone:stop_duration=${(dur + 1).toFixed(3)}[syn]`);
      chain = '[syn]';
      inputs++;
    } else {
      if (bg.shortMode === 'loop') args.push('-stream_loop', '-1');
      if (bg.startSec > 0) args.push('-ss', bg.startSec.toFixed(3));
      args.push('-i', file);
      // 開始時刻がずれている動画(スマホのMOVなど)でも先頭フレームから表示されるよう、時刻を0からにそろえる
      chain = `[${inputs}:v]setpts=PTS-STARTPTS,fps=${fps}` + (bg.shortMode === 'freeze' ? `,tpad=stop_mode=clone:stop_duration=${(dur + 1).toFixed(3)}` : '') + '[vin]';
      filters.push(chain);
      chain = '[vin]';
      inputs++;
    }
    if (cs) {
      filters.push(
        `${chain}crop=${cs.cropW}:${cs.cropH}:${cs.cropX}:${cs.cropY},scale=${cs.outW}:${cs.outH}:flags=lanczos,setsar=1,format=yuva420p[fg]`,
      );
      filters.push(`${cur}[fg]overlay=x=${cs.outX}:y=${cs.outY}:format=yuv420:shortest=0[bgd]`);
      cur = '[bgd]';
    }
    // カット内の動き(プレビューと同じ式をフレームごとに評価する)
    const mex = motionExprs(motionOf(bg), dur, W, H);
    if (mex) {
      const S = toFfmpegExpr(mex.s, fps);
      const DX = toFfmpegExpr(mex.dx, fps);
      const DY = toFfmpegExpr(mex.dy, fps);
      filters.push(
        `${cur}format=gbrp,scale=w='ceil(${W}*(${S}))':h='ceil(${H}*(${S}))':eval=frame:flags=bicubic,` +
          `crop=${W}:${H}:x='max(0,min(iw-${W},(iw-${W})/2-(${DX})))':y='max(0,min(ih-${H},(ih-${H})/2-(${DY})))',format=yuv420p[mo]`,
      );
      cur = '[mo]';
    }
  }
  const inset = span.scene.inset;
  if (inset) {
    const a = assetOf(p, inset.assetId);
    if (a.kind === 'image' && a.width && a.height) {
      args.push('-loop', '1', '-framerate', String(fps), '-i', mediaFile(p.id, a));
      const pl = placeInset(a.width, a.height, W, H, inset);
      const end = inset.endSec == null ? dur + 1 : inset.endSec;
      filters.push(`[${inputs}:v]scale=${pl.w}:${pl.h}:flags=lanczos,format=yuva420p[ins]`);
      filters.push(`${cur}[ins]overlay=x=${pl.x}:y=${pl.y}:format=yuv420:enable='between(t,${inset.startSec.toFixed(3)},${end.toFixed(3)})'[wins]`);
      cur = '[wins]';
      inputs++;
    }
  }
  filters.push(`${cur}format=yuv420p[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-frames:v', String(n), '-r', String(fps), ...x264Fast, '-an', out);
  await runOk(ffmpeg, args, { signal });
}

/** 背景動画の元音声(有効にしたシーンのみ)を1本のPCMにまとめる */
async function buildBgAudio(p: Project, spans: SceneSpan[], totalSamples: number, file: string, signal: AbortSignal): Promise<boolean> {
  const ffmpeg = requireTool('ffmpeg');
  const fps = p.export.fps;
  const buf = new Int16Array(totalSamples * 2);
  let any = false;
  for (const sp of spans) {
    const bg = sp.scene.bg;
    if (!bg || !bg.audio || bg.mode === 'synced') continue;
    const a = assetOf(p, bg.assetId);
    if (a.kind !== 'video' || !a.audioStreams?.length) continue;
    const s0 = frameToSample(sp.f0, fps);
    const s1 = frameToSample(sp.f1, fps);
    const dur = (s1 - s0) / SR;
    const args = ['-v', 'error'];
    if (bg.shortMode === 'loop') args.push('-stream_loop', '-1');
    if (bg.startSec > 0) args.push('-ss', bg.startSec.toFixed(3));
    args.push('-i', sub(p.id, a.file), '-t', dur.toFixed(6), '-map', '0:a:0', '-ac', '2', '-ar', String(SR), '-f', 's16le', 'pipe:1');
    const chunks: Buffer[] = [];
    await runOk(ffmpeg, args, { signal, onStdout: (c) => chunks.push(c), collectStdout: false });
    const raw = Buffer.concat(chunks);
    const g = Math.pow(10, bg.volumeDb / 20);
    const frames = Math.min(s1 - s0, Math.floor(raw.length / 4));
    for (let i = 0; i < frames * 2; i++) {
      const v = raw.readInt16LE(i * 2) * g + buf[s0 * 2 + i]!;
      buf[s0 * 2 + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
    }
    any = true;
  }
  if (any) await writeWav(file, { sampleRate: SR, channels: 2, data: buf });
  return any;
}

function srtTime(samples: number): string {
  const ms = Math.round((samples / SR) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function buildSrt(caps: CaptionImage[]): string {
  return (
    caps
      .filter((c) => c.text.trim() && c.outEnd > c.outStart)
      .sort((a, b) => a.outStart - b.outStart)
      .map((c, i) => `${i + 1}\n${srtTime(c.outStart)} --> ${srtTime(c.outEnd)}\n${c.text.trim()}\n`)
      .join('\n') + '\n'
  );
}

export async function runExport(input: ExportJobInput, ctx: JobContext): Promise<ExportResult> {
  const ffmpeg = requireTool('ffmpeg');
  const p = input.project;
  const { signal } = ctx;
  if (!p.narration) throw new Error('ナレーション音声が設定されていません。');
  const tl = timelineOf(p)!;
  const { fps, width: W, height: H } = p.export;
  if (!Number.isInteger(SR / fps)) throw new Error('フレームレートは 24/25/30/60 などを指定してください。');
  const total = totalFrames(tl.outSamples, fps);
  const totalSamples = frameToSample(total, fps);
  const work = input.workDir;
  await fsp.mkdir(work, { recursive: true });

  // 1. ナレーション(フレーム境界まで無音で延長)
  ctx.progress(0.02, 'ナレーションを編集しています');
  const src = await loadSourcePcm(p.id, p.narration.sourceKey);
  const narr = renderEdited(src, tl, 0, totalSamples);
  const narrFile = path.join(work, 'narration.wav');
  await writeWav(narrFile, narr);

  // 2. シーンごとの背景
  const spans = sceneSpans(p, tl, fps);
  if (spans.length === 0) spans.push({ scene: { id: 'blank', srcStart: 0, srcEnd: tl.srcSamples, bg: null, inset: null }, f0: 0, f1: total });
  const segFiles: string[] = [];
  for (let i = 0; i < spans.length; i++) {
    ctx.progress(0.05 + 0.5 * (i / spans.length), `背景を作成中 (${i + 1}/${spans.length})`);
    const f = path.join(work, `seg-${String(i).padStart(4, '0')}.mp4`);
    await renderSceneSegment(p, tl, spans[i]!, f, signal);
    segFiles.push(f);
  }
  const segList = path.join(work, 'segments.txt');
  await fsp.writeFile(segList, segFiles.map((f) => `file '${path.basename(f)}'`).join('\n') + '\n');
  const bgFile = path.join(work, 'background.mp4');
  await runOk(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', segList, '-c', 'copy', bgFile], { signal, cwd: work });

  // 3. テロップ(透明PNGを表示時間つきで並べる)
  ctx.progress(0.58, 'テロップを配置しています');
  const blank = path.join(work, 'blank.png');
  await runOk(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`, '-frames:v', '1', blank], { signal });
  const lines: string[] = [];
  let cursor = 0;
  let lastFile = blank;
  const pushImg = (file: string, frames: number) => {
    lines.push(`file '${path.basename(file)}'`, `duration ${(frames / fps).toFixed(6)}`);
    lastFile = file;
  };
  const caps = [...input.captions].sort((a, b) => a.outStart - b.outStart);
  for (const c of caps) {
    let cf0 = sampleToFrame(c.outStart, fps);
    const cf1 = Math.min(total, sampleToFrame(c.outEnd, fps));
    cf0 = Math.max(cf0, cursor);
    if (cf1 <= cf0) continue;
    if (cf0 > cursor) pushImg(blank, cf0 - cursor);
    pushImg(c.file, cf1 - cf0);
    cursor = cf1;
  }
  if (cursor < total) pushImg(blank, total - cursor);
  // concat の仕様上、最後の画像をもう一度書くと最後の duration が守られる
  lines.push(`file '${path.basename(lastFile)}'`);
  const capList = path.join(work, 'captions.txt');
  await fsp.writeFile(capList, lines.join('\n') + '\n');

  // 4. 音声
  const bgAudioFile = path.join(work, 'bgaudio.wav');
  const hasBgAudio = await buildBgAudio(p, spans, totalSamples, bgAudioFile, signal);

  // 5. 仕上げ
  ctx.progress(0.62, '動画を書き出しています');
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', bgFile, '-f', 'concat', '-safe', '0', '-i', capList, '-i', narrFile];
  const af: string[] = [];
  const mixIn: string[] = [];
  af.push(`[2:a]volume=${p.mix.narrationDb.toFixed(2)}dB[a0]`);
  mixIn.push('[a0]');
  let idx = 3;
  if (p.bgm) {
    const a = assetOf(p, p.bgm.assetId);
    if (p.bgm.loop) args.push('-stream_loop', '-1');
    if (p.bgm.startSec > 0) args.push('-ss', p.bgm.startSec.toFixed(3));
    args.push('-i', sub(p.id, a.file));
    const T = totalSamples / SR;
    const fi = Math.max(0, p.bgm.fadeInSec);
    const fo = Math.max(0, p.bgm.fadeOutSec);
    let chain = `[${idx}:a]aresample=${SR},aformat=channel_layouts=stereo,atrim=end_sample=${totalSamples},asetpts=PTS-STARTPTS`;
    if (fi > 0) chain += `,afade=t=in:st=0:d=${fi.toFixed(3)}`;
    if (fo > 0) chain += `,afade=t=out:st=${Math.max(0, T - fo).toFixed(3)}:d=${fo.toFixed(3)}`;
    chain += `,volume=${p.bgm.volumeDb.toFixed(2)}dB[a1]`;
    af.push(chain);
    mixIn.push('[a1]');
    idx++;
  }
  if (hasBgAudio) {
    args.push('-i', bgAudioFile);
    af.push(`[${idx}:a]anull[a2]`);
    mixIn.push('[a2]');
    idx++;
  }
  // クリッピング防止のリミッター(-1dBFS)
  if (mixIn.length > 1) af.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.891:level=0:latency=1,atrim=end_sample=${totalSamples}[aout]`);
  else af.push(`[a0]alimiter=limit=0.891:level=0:latency=1,atrim=end_sample=${totalSamples}[aout]`);
  // RGBA のまま YUV に重ねると色が壊れる FFmpeg があるため、yuva420p にそろえてから重ねる
  const vf = `[1:v]fps=${fps},format=yuva420p[cap];[0:v]format=yuv420p[bgv];[bgv][cap]overlay=0:0:format=yuv420:eof_action=pass:shortest=0,format=yuv420p[vout]`;
  const tmpOut = path.join(work, 'output.mp4');
  args.push(
    '-filter_complex', [vf, ...af].join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-frames:v', String(total), '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(p.export.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR),
    '-movflags', '+faststart',
    tmpOut,
  );
  const totalSec = total / fps;
  await runOk(ffmpeg, args, {
    signal,
    cwd: work,
    collectStdout: false,
    onStdout: (c) => {
      const m = /out_time_us=(\d+)/.exec(c.toString());
      if (m) ctx.progress(0.62 + 0.33 * Math.min(1, Number(m[1]) / 1e6 / totalSec), '動画を書き出しています');
    },
  });

  // 6. 完成品を exports へ(成功したときだけ置く)
  const exportsDir = sub(p.id, 'exports');
  await fsp.mkdir(exportsDir, { recursive: true });
  const name = `${input.baseName}.mp4`;
  const finalFile = path.join(exportsDir, name);
  await fsp.rename(tmpOut, finalFile);
  const extras: string[] = [];
  if (p.export.alsoWav) {
    const wavName = `${input.baseName}_narration.wav`;
    const pure = renderEdited(src, tl, p.mix.narrationDb);
    await writeWav(path.join(exportsDir, wavName), pure);
    extras.push(wavName);
  }
  if (p.export.alsoSrt) {
    const srtName = `${input.baseName}.srt`;
    await fsp.writeFile(path.join(exportsDir, srtName), buildSrt(caps));
    extras.push(srtName);
  }

  // 7. 確認用の代表フレーム
  ctx.progress(0.97, '確認用フレームを取り出しています');
  const frameDir = sub(p.id, 'exports', 'frames');
  await fsp.mkdir(frameDir, { recursive: true });
  const frames: ExportResult['frames'] = [];
  const picks = pickFrames(caps, total, fps);
  for (let k = 0; k < picks.length; k++) {
    const pk = picks[k]!;
    const f = `${input.baseName}_f${k}.jpg`;
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-ss', pk.timeSec.toFixed(3), '-i', finalFile, '-frames:v', '1', '-q:v', '3', path.join(frameDir, f)], { signal });
    if (r.code === 0) frames.push({ file: f, timeSec: pk.timeSec, captionId: pk.captionId });
  }

  const pr = await probe(finalFile);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const st = await fsp.stat(finalFile);
  if (!process.env.TDM_KEEP_WORK) await fsp.rm(work, { recursive: true, force: true });
  return {
    file: name,
    name,
    size: st.size,
    durationSec: Number(pr.format.duration ?? 0),
    width: v?.width ?? W,
    height: v?.height ?? H,
    extras,
    frames,
  };
}

function pickFrames(caps: CaptionImage[], total: number, fps: number): { timeSec: number; captionId: string | null }[] {
  const out: { timeSec: number; captionId: string | null }[] = [];
  const withText = caps.filter((c) => c.text.trim());
  const idxs = withText.length <= 4 ? withText.map((_, i) => i) : [0, Math.floor(withText.length / 3), Math.floor((2 * withText.length) / 3), withText.length - 1];
  for (const i of idxs) {
    const c = withText[i]!;
    const mid = (c.outStart + c.outEnd) / 2 / SR;
    out.push({ timeSec: Math.min(mid, (total - 1) / fps), captionId: c.id });
  }
  if (out.length === 0) out.push({ timeSec: Math.min(1, (total - 1) / fps), captionId: null });
  return out;
}

export function exportBaseName(p: Project): string {
  const safe = p.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40) || 'video';
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return `${safe}_${stamp}`;
}

export function cleanupDir(dir: string) {
  return async () => {
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
  };
}

