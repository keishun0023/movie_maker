// ローカルサーバーの起動。127.0.0.1 のみで待ち受け、外部サイトからの操作を拒否する。
import http from 'node:http';
import path from 'node:path';
import { HOST, PORT, SHARED_JS_DIR, WEB_JS_DIR, WEB_STATIC_DIR } from './config.js';
import { safeJoin, sendFile, sendJson, type Req } from './http.js';
import { router } from './routes.js';
import { HttpError } from './store.js';
import { scanFonts } from './fonts.js';
import { systemInfo } from './system.js';

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

function checkRequest(req: http.IncomingMessage): string | null {
  // DNS リバインディング対策: Host ヘッダーを確認
  const host = req.headers.host ?? '';
  if (!allowedHosts.has(host)) return 'Host が許可されていません';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return '外部サイトからのリクエストは受け付けません';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return 'Origin が許可されていません';
    // 独自ヘッダー必須(単純なフォーム送信などを防ぐ)
    if (req.headers['x-tdm'] !== '1') return '不正なリクエストです';
  }
  return null;
}

const server = http.createServer(async (rawReq, res) => {
  const req = rawReq as Req;
  const url = new URL(req.url ?? '/', 'http://localhost');
  req.pathname = url.pathname;
  req.query = url.searchParams;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const bad = checkRequest(req);
    if (bad) throw new HttpError(403, bad);
    if (url.pathname.startsWith('/api/')) {
      const m = router.match(req.method ?? 'GET', url.pathname);
      if (!m) throw new HttpError(404, 'APIが見つかりません');
      req.params = m.params;
      await m.handler(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '許可されていない操作です');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    if (url.pathname === '/' || url.pathname === '/index.html') return await sendFile(req, res, path.join(WEB_STATIC_DIR, 'index.html'));
    let file: string | null = null;
    if (url.pathname.startsWith('/static/')) file = safeJoin(WEB_STATIC_DIR, url.pathname.slice('/static/'.length));
    else if (url.pathname.startsWith('/js/web/')) file = safeJoin(WEB_JS_DIR, url.pathname.slice('/js/web/'.length));
    else if (url.pathname.startsWith('/js/shared/')) file = safeJoin(SHARED_JS_DIR, url.pathname.slice('/js/shared/'.length));
    if (!file) throw new HttpError(404, 'ページが見つかりません');
    await sendFile(req, res, file);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\n縦型動画メーカーを起動しました: ${url}`);
  console.log('終了するにはこのウィンドウで Ctrl+C を押してください。\n');
  const sys = await systemInfo();
  console.log(`CPU: ${sys.cpuModel} (${sys.cpuKind}${sys.rosetta ? ', Rosetta' : ''}) / メモリ ${sys.memGB}GB / 空き ${sys.diskFreeGB ?? '?'}GB`);
  console.log(`ffmpeg: ${sys.tools.ffmpeg ?? '未検出'} / whisper.cpp: ${sys.tools.whisper ?? '未検出'}`);
  console.log(`データ保存先: ${sys.dataDir}`);
  void scanFonts();
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中です。既に起動していないか確認するか、PORT=5179 npm run serve のように別のポートを指定してください。`);
    process.exit(1);
  }
  throw e;
});
