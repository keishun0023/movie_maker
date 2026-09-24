// whisper.cpp (whisper-cli) によるローカル文字起こし。
// -ojf の JSON からトークン単位の時刻を取り出す。取れない場合はセグメント時刻であることを明示する。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SR, type Token } from '../../shared/types.js';
import { requireTool, runOk, tools } from '../proc.js';
import type { AsrAdapter, AsrRequest, AsrResult } from './adapter.js';

interface WToken {
  text: string;
  offsets?: { from: number; to: number };
  id: number;
  p: number;
  t_dtw?: number;
}

interface WSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WToken[];
}

const SPECIAL = /^(\[_.*\]|<\|.*\|>)$/;

export function parseWhisperJson(jsonText: string, useDtw: boolean): AsrResult {
  // whisper-cli は制御文字をエスケープしないことがあるので取り除く
  const clean = jsonText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const j = JSON.parse(clean) as { transcription?: WSegment[] };
  const segs = j.transcription ?? [];
  const tokens: Token[] = [];
  const notes: string[] = [];
  let segmentOnly = 0;
  let dtwUsed = 0;
  const ms = (v: number) => Math.round((v * SR) / 1000);
  segs.forEach((seg, si) => {
    const raw = (seg.tokens ?? []).filter((t) => !SPECIAL.test(t.text.trim()) && t.text.replace(/�/g, '') !== '');
    if (raw.length === 0 && seg.text.trim()) {
      tokens.push({ id: `w${si}-0`, text: seg.text, start: ms(seg.offsets.from), end: ms(seg.offsets.to), p: 0.5, seg: si, timing: 'segment' });
      segmentOnly++;
      return;
    }
    raw.forEach((t, ti) => {
      const text = t.text.replace(/�/g, '');
      let start: number;
      let end: number;
      let timing: Token['timing'];
      if (useDtw && typeof t.t_dtw === 'number' && t.t_dtw >= 0) {
        start = ms(t.t_dtw * 10);
        const nx = raw[ti + 1];
        end = nx && typeof nx.t_dtw === 'number' && nx.t_dtw >= 0 ? ms(nx.t_dtw * 10) : ms(t.offsets?.to ?? seg.offsets.to);
        timing = 'dtw';
        dtwUsed++;
      } else if (t.offsets) {
        start = ms(t.offsets.from);
        end = ms(t.offsets.to);
        timing = 'token';
      } else {
        start = ms(seg.offsets.from);
        end = ms(seg.offsets.to);
        timing = 'segment';
        segmentOnly++;
      }
      tokens.push({ id: `w${si}-${ti}`, text, start, end, p: Math.round((t.p ?? 0) * 1000) / 1000, seg: si, timing });
    });
  });
  // 時刻を単調にそろえる
  let last = 0;
  for (const t of tokens) {
    if (t.start < last && t.timing !== 'segment') t.start = last;
    if (t.end < t.start + 480) t.end = t.start + 480;
    last = t.timing === 'segment' ? last : t.start;
  }
  if (segmentOnly > 0) notes.push(`${segmentOnly}個の語は区間単位の時刻しか取得できませんでした(確認対象)。`);
  if (useDtw) notes.push(dtwUsed > 0 ? 'DTWによるトークン時刻を使用しました(実験的)。' : 'DTWの時刻が取得できなかったため通常のトークン時刻を使用しました。');
  notes.push('whisper.cpp のトークン時刻は実験的な機能です。テロップ位置は音量の立ち上がりで補正しています。');
  return { tokens, notes };
}

export class WhisperCppAdapter implements AsrAdapter {
  readonly name = 'whisper.cpp';

  available(): boolean {
    return !!tools().whisper;
  }

  async transcribe(req: AsrRequest): Promise<AsrResult> {
    const bin = requireTool('whisper');
    await fsp.mkdir(req.workDir, { recursive: true });
    const outBase = path.join(req.workDir, `asr-${Date.now()}`);
    const threads = Math.max(1, Math.min(8, os.cpus().length));
    const args = ['-m', req.modelPath, '-f', req.wavPath, '-l', req.language, '-ojf', '-of', outBase, '-pp', '-t', String(threads)];
    if (req.prompt) args.push('--prompt', req.prompt);
    if (req.dtwPreset) args.push('-dtw', req.dtwPreset);
    req.progress(0.02, '音声認識を開始しています(初回はモデルの読み込みに時間がかかります)');
    try {
      await runOk(bin, args, {
        signal: req.signal,
        onStderrLine: (line) => {
          const m = /progress\s*=\s*(\d+)%/.exec(line);
          if (m) req.progress(Number(m[1]) / 100, `音声認識 ${m[1]}%`);
        },
      });
      const json = await fsp.readFile(outBase + '.json', 'utf8');
      return parseWhisperJson(json, !!req.dtwPreset);
    } finally {
      await fsp.rm(outBase + '.json', { force: true }).catch(() => undefined);
    }
  }
}
