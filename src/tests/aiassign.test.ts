import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { splitLongScenes, DEFAULT_SEGMENT_OPTIONS } from '../shared/segment.js';
import { buildTimeline, srcToOut } from '../shared/timemap.js';
import { SR, type Scene, type Token } from '../shared/types.js';

test('1〜2秒のカット割り: 長いシーンを語の切れ目で分ける', () => {
  const tl = buildTimeline(10 * SR, [{ start: 4 * SR, end: 4.5 * SR }]);
  const scenes: Scene[] = [{ id: 's1', srcStart: 0, srcEnd: 10 * SR, bg: null, inset: null }];
  // 0.37秒ごとに語が始まる
  const tokens: Token[] = [];
  for (let t = 0.1, i = 0; t < 9.8; t += 0.37, i++) tokens.push({ id: `t${i}`, text: 'あ', start: Math.round(t * SR), end: Math.round((t + 0.3) * SR), p: 0.9, seg: 0, timing: 'token' });
  const out = splitLongScenes(scenes, tokens, tl, { ...DEFAULT_SEGMENT_OPTIONS, sceneMinSec: 1, sceneMaxSec: 2 });
  assert.ok(out.length >= 5, `${out.length}`);
  assert.equal(out[0]!.srcStart, 0);
  assert.equal(out[out.length - 1]!.srcEnd, 10 * SR);
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i]!.srcStart, out[i - 1]!.srcEnd);
    // 境界は語の開始位置
    assert.ok(tokens.some((t) => t.start === out[i]!.srcStart), `境界 ${out[i]!.srcStart / SR}`);
  }
  for (const s of out) {
    const d = (srcToOut(tl, s.srcEnd) - srcToOut(tl, s.srcStart)) / SR;
    assert.ok(d > 0.9 && d < 2.5, `カット ${d}s`);
  }
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** 模擬 Claude API の応答(ストリーミングの要求には SSE で返す) */
function sendMessage(res: http.ServerResponse, req: { model: string; stream?: boolean }, text: string) {
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: req.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1234, output_tokens: 0 } };
  if (!req.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1234, output_tokens: 56 } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 40) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 56 } });
  send('message_stop', {});
  res.end();
}

test('Claude API へ素材のフレームとカットの文章を送り、提案を検証して受け取る(模擬サーバー)', { skip: !hasFfmpeg }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-ai-'));
  process.env.TDM_DATA_DIR = dataDir;
  let seen: { path?: string; model?: string; beta?: string; images: number; fallbacks?: unknown; format?: string; text: string } = { images: 0, text: '' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const content = j.messages[0].content as { type: string; text?: string }[];
      seen = {
        path: req.url,
        model: j.model,
        beta: String(req.headers['anthropic-beta'] ?? ''),
        images: content.filter((c) => c.type === 'image').length,
        fallbacks: j.fallbacks,
        format: j.output_config?.format?.type,
        text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      };
      // 同じ場面ばかり挙げても、近いカットでは重ならないように選び直される
      const out = {
        assignments: [
          { scene: 1, choices: [{ shot: 'V1-2', reason: '青い場面' }] },
          { scene: 2, choices: [{ shot: 'V1-2', reason: '青い場面' }, { shot: 'I1', reason: '料理の写真' }] },
          { scene: 3, choices: [{ shot: 'nope', reason: '存在しない場面' }] },
        ],
      };
      sendMessage(res, j, JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { createProject } = await import('../shared/project.js');
    const { aiAssign } = await import('../server/ai/assign.js');
    const p = createProject('pai-test', 'AI');
    const dir = path.join(dataDir, 'projects', p.id, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    // 赤 → 青 → 模様 → 緑 と切り替わる動画(場面が4つ)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=10:d=1.5', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10:d=1.5', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=10:d=1.5', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=10:d=1.5', '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0', '-pix_fmt', 'yuv420p', path.join(dir, 'vid1.mp4')]);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x300', '-frames:v', '1', path.join(dir, 'img1.png')]);
    const base = { size: 1, hash: 'x', importedAt: '', status: 'ok' as const, warnings: [] };
    p.assets = [
      { ...base, id: 'vid1', kind: 'video', name: 'run.mp4', file: 'assets/vid1.mp4', durationSec: 6, width: 320, height: 240 },
      { ...base, id: 'img1', kind: 'image', name: 'food.png', file: 'assets/img1.png', width: 200, height: 300 },
    ];
    p.narration = { assetId: 'n', audioIndex: 0, durationSamples: 6 * SR, sourceKey: 'k', preparedAt: '', warnings: [] };
    p.timeline = buildTimeline(6 * SR, []);
    p.scenes = [0, 2, 4].map((s, i) => ({ id: `s${i}`, srcStart: s * SR, srcEnd: (s + 2) * SR, bg: null, inset: null }));
    p.captions = [{ id: 'c1', srcStart: 0.2 * SR, srcEnd: 1.8 * SR, tokenIds: [], rawText: '', text: '朝ランニングをします', textEdited: true, timingEdited: false }];
    p.aiAssign.consent = true;
    p.aiAssign.useReference = true;
    p.aiAssign.reference = '朝ランニングをします\t"走っている動画\n※朝の雰囲気"\nまとめ\t料理';
    const r = await aiAssign({ project: p, apiKey: 'sk-ant-test', signal: new AbortController().signal, progress: () => undefined });
    assert.equal(seen.model, 'claude-opus-5-5');
    assert.ok(seen.path?.startsWith('/v1/messages'));
    assert.ok(seen.beta!.includes('server-side-fallback-2026-07-01'));
    assert.equal(seen.fallbacks, 'default');
    assert.equal(seen.format, 'json_schema');
    // 動画は場面の切り替わりで4つの場面に分け、場面ごとに画像を送る
    assert.equal(seen.images, 5, `images ${seen.images}`);
    for (const id of ['V1-1', 'V1-2', 'V1-3', 'V1-4', 'I1']) assert.ok(seen.text.includes(id), id);
    assert.ok(seen.text.includes('カット1 (2秒): 朝ランニングをします 【素材の指定: 走っている動画 ※朝の雰囲気】'));
    assert.ok(seen.text.includes('# 素材の指定(参考)'));
    assert.ok(r.notes.some((n) => n.includes('素材の指定(2 行)')));
    // カット1 は V1-2(1.5秒〜)。カット2 は同じ場面を避けて第2候補の画像。カット3 は近くと重ならない場面
    const got = r.assignments.map((a) => [a.sceneId, a.assetId, a.startSec]);
    assert.deepEqual(got.slice(0, 2), [
      ['s0', 'vid1', 1.5],
      ['s1', 'img1', 0],
    ]);
    assert.equal(got[2]![1], 'vid1');
    assert.notEqual(r.assignments[2]!.reason.split(' ')[0], 'V1-2');
    assert.ok(r.notes.some((n) => n.includes('1 カットは提案が返らなかった')));
  } finally {
    server.close();
    delete process.env.ANTHROPIC_BASE_URL;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('自動編集をしていない(カット1つ・テロップなし)場合も、1カットの長さに合わせて均等に分ける', async () => {
  const { createProject, splitScenesToCutLength } = await import('../shared/project.js');
  const p = createProject('psplit', 't');
  p.narration = { assetId: 'n', audioIndex: 0, durationSamples: 20 * SR, sourceKey: 'k', preparedAt: '', warnings: [] };
  p.timeline = buildTimeline(20 * SR, []);
  p.scenes = [{ id: 'only', srcStart: 0, srcEnd: 20 * SR, bg: null, inset: null }];
  p.sceneLen = { minSec: 1, maxSec: 2 };
  const q = splitScenesToCutLength(p);
  assert.equal(q.scenes.length, 10);
  assert.equal(q.scenes[0]!.srcStart, 0);
  assert.equal(q.scenes[9]!.srcEnd, 20 * SR);
  for (const s of q.scenes) assert.ok(Math.abs((s.srcEnd - s.srcStart) / SR - 2) < 0.01);
});
