import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { computeAnalysis } from '../shared/silence.js';
import { speechChunks, splitJaText, tokensFromChunks } from '../shared/chunks.js';
import { buildCaptions } from '../shared/segment.js';
import { SR } from '../shared/types.js';

function synth(totalSec: number, spans: [number, number][]): Float32Array {
  const a = new Float32Array(Math.round(totalSec * SR));
  for (const [s, e] of spans) for (let i = Math.round(s * SR); i < Math.round(e * SR); i++) a[i] = 0.4 * Math.sin((2 * Math.PI * 200 * i) / SR);
  return a;
}

test('無音で区切って音声片を作り、発話の前後に余白を付ける', () => {
  const a = computeAnalysis(synth(8, [[0.5, 2.0], [2.6, 4.0], [6.0, 7.5]]));
  const cs = speechChunks(a);
  assert.equal(cs.length, 3);
  assert.ok(Math.abs(cs[0]!.start / SR - 0.42) < 0.03);
  assert.ok(Math.abs(cs[1]!.start / SR - 2.52) < 0.03);
  assert.ok(Math.abs(cs[2]!.end / SR - 7.58) < 0.03);
});

test('長い音声片は中の静かな所で分ける', () => {
  const a = computeAnalysis(synth(30, [[0.2, 29.8]]));
  const cs = speechChunks(a, 0, { minGapMs: 180, padMs: 80, maxSec: 12, minSpeechMs: 120 });
  assert.ok(cs.length >= 3);
  for (const c of cs) assert.ok((c.end - c.start) / SR <= 12.2);
});

test('音声片の文章から、音声片の中に収まるトークンを作る', () => {
  const words = splitJaText('本当に必要なものかどうか冷静に考えられます。');
  assert.equal(words.join(''), '本当に必要なものかどうか冷静に考えられます。');
  assert.ok(words.includes('もの') && words[words.length - 1]!.endsWith('。'), words.join('|'));
  const chunks = [{ start: 1 * SR, end: 3 * SR }, { start: 4 * SR, end: 5 * SR }];
  const toks = tokensFromChunks(chunks, ['今日は節約術を紹介します。', 'まず一つ目。']);
  const first = toks.filter((t) => t.seg === 0);
  assert.equal(first[0]!.start, 1 * SR);
  assert.equal(first[first.length - 1]!.end, 3 * SR);
  assert.ok(toks.every((t) => t.timing === 'chunk'));
  // 音声片の境目(発話の間)でテロップが切れる
  const caps = buildCaptions(toks, null);
  assert.ok(caps.some((c) => c.rawText.endsWith('紹介します。') && c.srcEnd === 3 * SR));
  assert.ok(caps.every((c) => !c.review));
});

test('Gemini API へ音声片をまとめて送り、音声片ごとの結果を受け取る(模擬サーバー)', async () => {
  let seen: { key?: string; url?: string; audio: number; labels: string[] } = { audio: 0, labels: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const parts = j.contents[0].parts as { text?: string; inline_data?: { mime_type: string; data: string } }[];
      seen = {
        key: String(req.headers['x-goog-api-key']),
        url: req.url ?? '',
        audio: parts.filter((p) => p.inline_data?.mime_type === 'audio/wav').length,
        labels: parts.filter((p) => p.text?.startsWith('音声片 ')).map((p) => p.text!),
      };
      assert.equal(j.generationConfig.responseMimeType, 'application/json');
      const out = [{ id: 0, text: 'こんにちは。' }, { id: 1, text: '今日はいい天気です。' }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  process.env.TDM_GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
  const { geminiTranscribe } = await import('../server/asr/gemini.js');
  const pcm = new Int16Array(16000 * 4);
  const r = await geminiTranscribe({
    pcm16k: pcm,
    chunks: [{ start: 0, end: SR }, { start: 2 * SR, end: 3 * SR }, { start: 3 * SR, end: 4 * SR }],
    model: 'gemini-test',
    apiKey: 'test-key-123',
    hints: ['アハモ'],
    signal: new AbortController().signal,
    progress: () => undefined,
  });
  server.close();
  assert.equal(seen.key, 'test-key-123');
  assert.ok(seen.url!.includes('/v1beta/models/gemini-test:generateContent'));
  assert.equal(seen.audio, 3);
  assert.deepEqual(seen.labels, ['音声片 0', '音声片 1', '音声片 2']);
  assert.deepEqual(r.texts, ['こんにちは。', '今日はいい天気です。', '']);
  assert.deepEqual(r.missing, [2]);
});

test('モデル「自動」は一覧から最新の安定版 flash を選ぶ(lite・preview・pro は避ける)', async () => {
  const { pickLatestFlash } = await import('../server/asr/gemini.js');
  const list = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.9-flash-preview-09-2026', 'gemini-3.8-pro', 'text-embedding-004'];
  assert.equal(pickLatestFlash(list), 'gemini-3.8-flash');
  // 安定版がなければ preview でも使う
  assert.equal(pickLatestFlash(['gemini-3.9-flash-preview-09-2026', 'gemini-3.8-pro']), 'gemini-3.9-flash-preview-09-2026');
  // 同じバージョンなら安定版を優先
  assert.equal(pickLatestFlash(['gemini-3.8-flash-preview-01', 'gemini-3.8-flash', 'gemini-3.8-flash-lite']), 'gemini-3.8-flash');
  assert.equal(pickLatestFlash(['gemini-3.8-pro']), null);
});
