import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 模擬 Claude API の応答(SSE) */
function sendMessage(res: http.ServerResponse, req: { model: string }, text: string) {
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: req.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 321, output_tokens: 0 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 40) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 99 } });
  send('message_stop', {});
  res.end();
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('写真投稿: Claude で中身を書き、素材サイトの画像を重ならないように入れる(模擬サーバー)', async () => {
  // データフォルダとキーは、サーバーのモジュールを読み込む前に決める
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-cr-'));
  process.env.TDM_DATA_DIR = dataDir;
  process.env.PEXELS_API_KEY = 'pexels-test-key';
  delete process.env.PIXABAY_API_KEY;
  let seen: { model?: string; system?: string; user?: string; format?: string } = {};
  const draft = {
    cover: { kicker: '皮膚科行く前にこれみて‼️', title: 'ニキビがガチで消えた神習慣', image: { q: 'woman face', kind: 'photo' } },
    pages: [
      { label: '', title: '顔の毛', subtitle: '', left: { text: 'ボーボー', note: '', image: { q: 'hairy face', kind: 'photo' } }, right: { text: 'ツルツル', note: '', image: { q: 'smooth face', kind: 'photo' } } },
      { label: '', title: '枕カバー', subtitle: '', left: { text: '1か月そのまま', note: '', image: { q: 'nothing here at all', kind: 'photo' } }, right: { text: '毎日替える', note: '', image: { q: 'pillow', kind: 'photo' } } },
    ],
    caption: 'みんなはどれくらい当てはまった?👀',
    hashtags: ['美容', '垢抜け'],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      seen = { model: j.model, system: j.system, user: j.messages[0].content, format: j.output_config?.format?.type };
      sendMessage(res, j, JSON.stringify(draft));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // 素材サイトは fetch を差し替えて模擬する(どの検索でも同じ3枚を返す。「nothing」は0件)
  const realFetch = globalThis.fetch;
  const searches: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.hostname === 'api.pexels.com') {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'pexels-test-key');
      const q = u.searchParams.get('query')!;
      searches.push(q);
      const photos = q.startsWith('nothing') ? [] : [1, 2, 3].map((n) => ({ id: n, url: `https://www.pexels.com/photo/${n}`, width: 800, height: 1200, photographer: `P${n}`, src: { medium: `https://images.pexels.com/m${n}.png`, large: `https://images.pexels.com/l${n}.png`, large2x: `https://images.pexels.com/x${n}.png` } }));
      return new Response(JSON.stringify({ photos }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.hostname === 'images.pexels.com') return new Response(Buffer.concat([PNG, Buffer.from(u.pathname)]), { status: 200, headers: { 'content-type': 'image/png' } });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { createCarousel } = await import('../shared/carousel.js');
    const { generateCarousel } = await import('../server/carousel/write.js');
    const c = createCarousel('ctest-1', 'テスト');
    c.theme = 'ニキビが消えた習慣';
    c.pageCount = 2;
    c.notes = '語尾はやさしく';
    c.style.heads = 'words';
    const r = await generateCarousel({ carousel: c, apiKey: 'sk-ant-test', signal: new AbortController().signal, progress: () => undefined });
    assert.equal(seen.model, 'claude-opus-5-5');
    assert.equal(seen.format, 'json_schema');
    assert.ok(seen.system!.includes('左: ドブス') && seen.system!.includes('右: 爆美女'));
    assert.ok(seen.user!.includes('ニキビが消えた習慣') && seen.user!.includes('2 枚') && seen.user!.includes('語尾はやさしく'));
    assert.equal(r.pages.length, 3);
    assert.deepEqual(r.hashtags, ['美容', '垢抜け']);
    // 3枚しかない検索結果を、表紙と各ページで重ならないように使う
    const imgs = r.pages.flatMap((p) => (p.kind !== 'compare' ? [p.image] : [p.left.image, p.right.image]));
    const used = imgs.filter((x) => !!x);
    assert.equal(used.length, 3, JSON.stringify(imgs));
    assert.equal(new Set(used.map((x) => x!.pageUrl)).size, 3);
    assert.ok(used.every((x) => x!.source === 'pexels' && /^P\d$/.test(x!.credit ?? '') && fs.existsSync(path.join(dataDir, '写真投稿素材', '企画', 'ctest-1', x!.file))));
    // 見つからなかった検索語は、短くしてもう一度探す
    assert.ok(searches.includes('nothing here at all') && searches.includes('nothing here at'));
    assert.ok(r.notes.some((n) => n.includes('画像を入れられませんでした')), r.notes.join('\n'));
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.PEXELS_API_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
