// Google Gemini API による文字起こし(任意・利用者が同意した場合のみ)。
// 無音で区切った音声片をまとめて送り、音声片ごとの書き起こしを JSON で受け取る。
// Gemini は語ごとの時刻を返さないので、時刻は音声片の区切りを使う(tokensFromChunks)。
import { SR } from '../../shared/types.js';
import type { SpeechChunk } from '../../shared/chunks.js';
import { wavHeader } from '../media.js';
import { CanceledError } from '../proc.js';

export const GEMINI_BASE_URL = process.env.TDM_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com';

const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function assertGeminiModel(m: string): string {
  if (!MODEL_RE.test(m)) throw new Error('Gemini のモデル名が正しくありません');
  return m;
}

function friendlyError(status: number, body: string): Error {
  let msg = '';
  try {
    msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    msg = body.slice(0, 200);
  }
  if (status === 400 && /API key/i.test(msg)) return new Error('Gemini の APIキーが正しくありません。設定し直してください。');
  if (status === 401 || status === 403) return new Error(`Gemini API の利用が許可されていません(${status})。APIキーと、Google AI Studio 側の設定を確認してください。\n${msg}`);
  if (status === 404) return new Error(`指定した Gemini モデルが使えません(提供終了など)。モデルを「自動(最新の flash)」にするか、「モデル一覧を取得」から選び直してください。\n${msg}`);
  if (status === 429) return new Error(`Gemini API の利用上限に達しました(429)。少し待ってから再試行してください。\n${msg}`);
  return new Error(`Gemini API がエラーを返しました(${status})。\n${msg}`);
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
  const body = await res.text();
  if (!res.ok) throw friendlyError(res.status, body);
  const j = JSON.parse(body) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  return (j.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
}

/**
 * モデル一覧から最新の flash モデルを選ぶ(モデルは入れ替わるので名前を決め打ちしない)。
 * 安定版(-preview などの付かないもの)を優先し、lite は避ける。
 */
export function pickLatestFlash(models: string[]): string | null {
  const scored = models
    .map((m) => {
      const r = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?(?:-(.+))?$/.exec(m);
      if (!r) return null;
      const version = Number(r[1]) * 100 + Number(r[2] ?? 0);
      const stable = !r[4];
      const lite = !!r[3];
      // 安定版 > 新しいバージョン > lite でない の順に優先(preview は提供終了が早いことがある)
      return { m, score: (stable ? 1_000_000 : 0) + version * 10 + (lite ? 0 : 2) };
    })
    .filter((x): x is { m: string; score: number } => !!x)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.m ?? null;
}

/** 'auto' なら API のモデル一覧から最新の flash を選ぶ */
export async function resolveGeminiModel(model: string, apiKey: string): Promise<string> {
  if (model !== 'auto') return assertGeminiModel(model);
  const list = await listGeminiModels(apiKey);
  const picked = pickLatestFlash(list);
  if (!picked) throw new Error('使える Gemini の flash モデルが見つかりませんでした。「モデル一覧を取得」から選んでください。');
  return picked;
}

export interface GeminiRequest {
  /** 16kHz モノラル PCM */
  pcm16k: Int16Array;
  /** 48kHz 基準のサンプル位置 */
  chunks: SpeechChunk[];
  model: string;
  apiKey: string;
  hints: string[];
  signal: AbortSignal;
  progress: (p: number, m?: string) => void;
}

/** 1回のリクエストに入れる音声の長さの上限(インラインデータの上限 20MB に余裕を持たせる) */
const MAX_BATCH_SEC = 240;

function chunkWav(pcm: Int16Array, c: SpeechChunk): Buffer {
  const a = Math.max(0, Math.floor((c.start * 16000) / SR));
  const b = Math.min(pcm.length, Math.ceil((c.end * 16000) / SR));
  const data = Buffer.from(pcm.buffer, pcm.byteOffset + a * 2, Math.max(0, b - a) * 2);
  return Buffer.concat([wavHeader(data.length, 16000, 1), data]);
}

export function buildPrompt(hints: string[]): string {
  return [
    'あなたは日本語ナレーションの書き起こし担当です。',
    'このあとに「音声片 N」というラベルと音声が順番に続きます。各音声片で実際に話されている言葉だけを、正確に日本語で書き起こしてください。',
    '規則:',
    '- 言い換え・要約・補完・宣伝文の追加はしない。聞こえた言葉をそのまま書く。',
    '- 句読点(、。)と「？」「！」は自然に付ける。フィラー(えー、あのー)は話されていれば残す。',
    '- 数字は話し言葉どおりの意味で、読みやすいアラビア数字で書く(例: 3000円)。',
    '- 言葉が聞こえない音声片は空文字にする。',
    '- 音声片の境目で文が続いていても、その音声片で聞こえた部分だけを書く。',
    hints.length ? `- 固有名詞・用語のヒント(聞こえた場合の表記の参考。聞こえていない語は書かない): ${hints.join('、')}` : '',
    '出力は、すべての音声片について {"id": 番号, "text": 書き起こし} を並べた JSON 配列だけにしてください。',
  ]
    .filter(Boolean)
    .join('\n');
}

async function callGemini(req: GeminiRequest, ids: number[], attempt = 0): Promise<Map<number, string>> {
  const parts: unknown[] = [{ text: buildPrompt(req.hints) }];
  for (const id of ids) {
    parts.push({ text: `音声片 ${id}` });
    parts.push({ inline_data: { mime_type: 'audio/wav', data: chunkWav(req.pcm16k, req.chunks[id]!).toString('base64') } });
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } }, required: ['id', 'text'] },
      },
    },
  };
  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e) {
    if (req.signal.aborted) throw new CanceledError();
    throw new Error('Gemini API に接続できませんでした。ネットワークを確認してください。' + (e instanceof Error ? `(${e.message})` : ''));
  }
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      if (req.signal.aborted) throw new CanceledError();
      return callGemini(req, ids, attempt + 1);
    }
    throw friendlyError(res.status, text);
  }
  const j = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  if (j.promptFeedback?.blockReason) throw new Error(`Gemini が処理を拒否しました(${j.promptFeedback.blockReason})`);
  const cand = j.candidates?.[0];
  const out = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  let arr: { id: number; text: string }[];
  try {
    arr = JSON.parse(out) as { id: number; text: string }[];
  } catch {
    throw new Error(`Gemini の応答を読み取れませんでした(${cand?.finishReason ?? '不明'})。再試行してください。`);
  }
  const map = new Map<number, string>();
  for (const it of Array.isArray(arr) ? arr : []) {
    if (typeof it?.id === 'number' && typeof it.text === 'string' && ids.includes(it.id)) map.set(it.id, it.text);
  }
  return map;
}

/** 音声片ごとの書き起こしを返す(音声片の順番どおり)。欠けた音声片は notes で知らせる */
export async function geminiTranscribe(req: GeminiRequest): Promise<{ texts: string[]; missing: number[] }> {
  const batches: number[][] = [];
  let cur: number[] = [];
  let sec = 0;
  req.chunks.forEach((c, i) => {
    const d = (c.end - c.start) / SR;
    if (cur.length && sec + d > MAX_BATCH_SEC) {
      batches.push(cur);
      cur = [];
      sec = 0;
    }
    cur.push(i);
    sec += d;
  });
  if (cur.length) batches.push(cur);
  const texts: string[] = new Array(req.chunks.length).fill('');
  const missing: number[] = [];
  for (let b = 0; b < batches.length; b++) {
    if (req.signal.aborted) throw new CanceledError();
    req.progress(0.05 + (0.9 * b) / batches.length, `Gemini で文字起こし中 (${b + 1}/${batches.length})`);
    const ids = batches[b]!;
    const map = await callGemini(req, ids);
    for (const id of ids) {
      if (map.has(id)) texts[id] = map.get(id)!;
      else missing.push(id);
    }
  }
  return { texts, missing };
}
