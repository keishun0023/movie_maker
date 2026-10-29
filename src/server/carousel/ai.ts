// Gemini の画像生成で、写真投稿の画像を作る(任意・利用者の APIキーで)。
// キャラクターのように背景を抜きたい画像は、緑一色の背景で作らせてから FFmpeg で透明にする。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { friendlyError, GEMINI_BASE_URL, listGeminiModels } from '../asr/gemini.js';
import { CanceledError, requireTool, runOk } from '../proc.js';
import { HttpError } from '../store.js';

export type AiStyle = 'anime' | 'photo';

export const AI_STYLE_PROMPTS: Record<AiStyle, string> = {
  anime:
    'Japanese anime style like a modern TV anime or light novel illustration: large expressive anime eyes with bright highlights, small nose and mouth, clean thin lineart, flat cel shading with crisp shadow edges, soft pastel colors.',
  photo: 'Photorealistic, natural soft light, clean modern Japanese beauty magazine look, sharp focus, no text or logos in the image.',
};

const GREEN = 'The ENTIRE background must be one solid flat chroma-key green color #00FF00 from edge to edge, with no frame, no panel, no shadow, no other color behind the subject.';

/** 使う画像生成モデル(新しいものから、使えるものを選ぶ) */
const PREFERRED = ['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
let modelCache: { key: string; model: string } | null = null;

export async function imageModel(apiKey: string): Promise<string> {
  if (process.env.TDM_GEMINI_IMAGE_MODEL) return process.env.TDM_GEMINI_IMAGE_MODEL;
  if (modelCache?.key === apiKey) return modelCache.model;
  let models: string[] = [];
  try {
    models = await listGeminiModels(apiKey);
  } catch {
    /* 一覧が取れなくても、既定のモデルで試す */
  }
  const model = PREFERRED.find((m) => models.includes(m)) ?? models.find((m) => /image/.test(m) && !/lite/.test(m)) ?? PREFERRED[0]!;
  modelCache = { key: apiKey, model };
  return model;
}

/** 生成の指示文を組み立てる(内容 + 画風 + 背景) */
export function buildPrompt(subject: string, style: AiStyle, transparent: boolean): string {
  return [subject.trim(), AI_STYLE_PROMPTS[style], transparent ? GREEN : 'Fill the whole frame; no border.', 'No text, no letters, no watermark.'].join(' ');
}

export interface AiImageOptions {
  apiKey: string;
  subject: string;
  style: AiStyle;
  transparent?: boolean;
  aspectRatio?: '3:4' | '9:16' | '1:1' | '4:3';
  signal?: AbortSignal;
}

export async function generateAiImage(opt: AiImageOptions): Promise<{ buf: Buffer; ext: '.png'; prompt: string; model: string }> {
  if (!opt.subject.trim()) throw new HttpError(400, '作りたい画像の内容を入れてください');
  const model = await imageModel(opt.apiKey);
  const prompt = buildPrompt(opt.subject, opt.style, !!opt.transparent);
  // 画像を返さないこと(NO_IMAGE)がときどきあるので、1回だけ言い方を変えてやり直す
  let data: { data: string } | undefined;
  let why = '';
  for (const text of [prompt, `Generate one image (not text). ${prompt}`]) {
    const body = { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: opt.aspectRatio ?? '3:4' } } };
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opt.apiKey },
        body: JSON.stringify(body),
        signal: opt.signal,
      });
    } catch (e) {
      if (opt.signal?.aborted) throw new CanceledError();
      throw new HttpError(502, `Gemini API に接続できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
    const raw = await res.text();
    if (!res.ok) throw friendlyError(res.status, raw);
    const j = JSON.parse(raw) as { candidates?: { finishReason?: string; content?: { parts?: { inlineData?: { data: string; mimeType?: string } }[] } }[]; promptFeedback?: { blockReason?: string } };
    data = j.candidates?.flatMap((c) => c.content?.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (data) break;
    why = j.promptFeedback?.blockReason ?? j.candidates?.[0]?.finishReason ?? '';
    // 安全判定で断られたときは、言い方を変えても同じなのでやめる
    if (j.promptFeedback?.blockReason) break;
  }
  if (!data) throw new HttpError(502, `Gemini が画像を返しませんでした${why ? `(${why})` : ''}。内容の書き方を変えて試してください`);
  let buf: Buffer = Buffer.from(data.data, 'base64');
  if (opt.transparent) buf = await removeGreen(buf, opt.signal);
  return { buf, ext: '.png', prompt, model };
}

/** 緑の背景を透明にする */
async function removeGreen(buf: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const ffmpeg = requireTool('ffmpeg');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdm-ai-'));
  try {
    const src = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.png`);
    const out = path.join(dir, 'out.png');
    await fsp.writeFile(src, buf);
    await runOk(ffmpeg, ['-v', 'error', '-y', '-i', src, '-vf', 'colorkey=0x00FF00:0.28:0.08,despill=type=green,format=rgba', '-frames:v', '1', out], { signal });
    return await fsp.readFile(out);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
