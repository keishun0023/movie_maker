// 写真投稿(比較カルーセル)の API。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Carousel } from '../shared/carousel.js';
import { captionText, creditLines } from '../shared/carousel.js';
import { carouselDir, carouselFile, deleteCarousel, listCarousels, loadCarousel, newCarousel, saveCarousel, saveImage, uploadImage } from './carousel/store.js';
import { fetchStockImage, searchStock, type StockHit } from './carousel/stock.js';
import { fillImages, generateCarousel } from './carousel/write.js';
import { readJson, sendFile, sendJson } from './http.js';
import { enqueue } from './jobs.js';
import { runOk } from './proc.js';
import { cleanKey, router } from './routes.js';
import { anthropicKey, setStockKey, stockKeySource, type StockProvider } from './secrets.js';
import { assertId, atomicWrite, HttpError } from './store.js';
import { makeZip } from './zip.js';

const provider = (v: unknown): StockProvider => {
  if (v === 'pixabay' || v === 'pexels') return v;
  throw new HttpError(400, '素材サイトの指定が正しくありません');
};

router.put('/api/settings/stock-key', async (req, res) => {
  const body = await readJson<{ provider: string; key?: string | null }>(req);
  const p = provider(body.provider);
  await setStockKey(p, cleanKey(body.key) || null);
  sendJson(res, 200, { provider: p, source: stockKeySource(p) });
});

router.get('/api/carousels', async (_req, res) => sendJson(res, 200, await listCarousels()));

router.post('/api/carousels', async (req, res) => {
  const body = await readJson<{ name?: string }>(req);
  sendJson(res, 200, await newCarousel(String(body.name ?? '')));
});

router.get('/api/carousels/:id', async (req, res) => sendJson(res, 200, await loadCarousel(req.params.id!)));

router.put('/api/carousels/:id', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<Carousel>(req, 10 * 1024 * 1024);
  if (body.id !== id) throw new HttpError(400, 'IDが一致しません');
  await loadCarousel(id); // 存在確認
  const saved = await saveCarousel(body);
  sendJson(res, 200, { updatedAt: saved.updatedAt });
});

router.del('/api/carousels/:id', async (req, res) => {
  await deleteCarousel(assertId(req.params.id!));
  sendJson(res, 200, { ok: true });
});

/** Claude で中身を作り、画像を探して入れる */
router.post('/api/carousels/:id/generate', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ carousel: Carousel }>(req, 10 * 1024 * 1024);
  const carousel = body.carousel;
  if (!carousel || carousel.id !== id) throw new HttpError(400, 'IDが一致しません');
  const apiKey = anthropicKey();
  if (!apiKey) throw new HttpError(400, 'Claude の APIキーが設定されていません。');
  const job = enqueue({
    type: 'carousel-generate',
    label: `写真投稿「${carousel.theme.slice(0, 20)}」を作成`,
    queue: 'analysis',
    runner: (ctx) => generateCarousel({ carousel, apiKey, signal: ctx.signal, progress: ctx.progress }),
  });
  sendJson(res, 200, job);
});

/** 画像の入っていない枠に、素材サイトの画像を入れる */
router.post('/api/carousels/:id/fill-images', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ carousel: Carousel }>(req, 10 * 1024 * 1024);
  const carousel = body.carousel;
  if (!carousel || carousel.id !== id) throw new HttpError(400, 'IDが一致しません');
  const job = enqueue({
    type: 'carousel-images',
    label: '写真投稿の画像を探す',
    queue: 'download',
    runner: (ctx) => fillImages(carousel, ctx.signal, ctx.progress),
  });
  sendJson(res, 200, job);
});

router.post('/api/carousels/:id/images', async (req, res) => {
  const id = assertId(req.params.id!);
  await loadCarousel(id);
  sendJson(res, 200, await uploadImage(id, req));
});

/** 素材サイトの検索結果から1枚を取り込む */
router.post('/api/carousels/:id/stock', async (req, res) => {
  const id = assertId(req.params.id!);
  const hit = await readJson<StockHit>(req);
  provider(hit.provider);
  const img = await fetchStockImage(String(hit.full));
  sendJson(res, 200, await saveImage(id, img.buf, img.ext, { source: hit.provider, credit: String(hit.credit ?? '').slice(0, 100), pageUrl: String(hit.pageUrl ?? '').slice(0, 300) }));
});

router.get('/api/carousels/:id/files/:dir/:name', async (req, res) => {
  const dir = req.params.dir;
  if (dir !== 'images' && dir !== 'exports') throw new HttpError(404, 'ファイルが見つかりません');
  const file = carouselFile(req.params.id!, dir, req.params.name!);
  const dl = req.query.get('download') === '1';
  return sendFile(req, res, file, { cache: dir === 'images' ? 'private, max-age=86400' : 'no-cache', ...(dl ? { download: path.basename(file) } : {}) });
});

router.get('/api/stock/search', async (req, res) => {
  const p = provider(req.query.get('provider'));
  const kind = req.query.get('kind') === 'illustration' ? 'illustration' : 'photo';
  sendJson(res, 200, await searchStock(p, { q: req.query.get('q') ?? '', kind }));
});

/** 検索結果の縮小画像(画面は外部の画像を直接表示しないので、ここを通す) */
router.get('/api/stock/thumb', async (req, res) => {
  const img = await fetchStockImage(req.query.get('url') ?? '');
  res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.buf.length, 'Cache-Control': 'private, max-age=3600' });
  res.end(img.buf);
});

function fileBase(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 60) || 'photo';
}

/** 画面で描いたページの PNG を保存し、まとめた ZIP(本文の文章も入れる)も作る */
router.post('/api/carousels/:id/export', async (req, res) => {
  const id = assertId(req.params.id!);
  const c = await loadCarousel(id);
  const body = await readJson<{ pngs: string[] }>(req, 200 * 1024 * 1024);
  const pngs = (Array.isArray(body.pngs) ? body.pngs : []).map((s) => Buffer.from(String(s).replace(/^data:image\/png;base64,/, ''), 'base64'));
  if (pngs.length === 0) throw new HttpError(400, 'ページがありません');
  if (pngs.some((b) => b.length < 8 || b.readUInt32BE(0) !== 0x89504e47)) throw new HttpError(400, 'PNG ではないデータが含まれています');
  const dir = path.join(carouselDir(id), 'exports');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const base = `${fileBase(c.name)}_${stamp}`;
  const files: { name: string; data: Buffer }[] = pngs.map((data, i) => ({ name: `${base}_${String(i + 1).padStart(2, '0')}.png`, data }));
  const credits = creditLines(c);
  const text = captionText(c) + (credits.length ? `\n\n---\n画像: ${credits.join(', ')}\n` : '\n');
  files.push({ name: `${base}_本文.txt`, data: Buffer.from(text, 'utf8') });
  for (const f of files) await atomicWrite(path.join(dir, f.name), f.data);
  const zipName = `${base}.zip`;
  await atomicWrite(path.join(dir, zipName), makeZip(files));
  sendJson(res, 200, { zip: zipName, files: files.map((f) => f.name) });
});

router.post('/api/carousels/:id/reveal', async (req, res) => {
  const dir = path.join(carouselDir(assertId(req.params.id!)), 'exports');
  await fsp.mkdir(dir, { recursive: true });
  if (process.platform === 'darwin') await runOk('open', [dir]).catch(() => undefined);
  sendJson(res, 200, { path: dir });
});
