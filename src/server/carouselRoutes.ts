// 写真投稿(比較カルーセル)の API。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Carousel, CarouselFormat, LibraryCategory } from '../shared/carousel.js';
import { applyFormat, captionText, creditLines } from '../shared/carousel.js';
import { generateAiImage, type AiStyle } from './carousel/ai.js';
import {
  addToLibrary,
  copyExportToLibrary,
  DEFAULT_LIBRARY_DIR,
  driveFolderCandidates,
  itemPath,
  libraryDir,
  libraryItem,
  libraryItems,
  libraryToCarousel,
  listFormats,
  removeLibraryItem,
  saveAndRegister,
  saveFormats,
  setLibraryDir,
  updateLibraryItem,
} from './carousel/library.js';
import { carouselDir, carouselFile, deleteCarousel, listCarousels, loadCarousel, newCarousel, readUpload, saveCarousel } from './carousel/store.js';
import { fetchStockImage, searchStock, type StockHit } from './carousel/stock.js';
import { fillImages, generateCarousel } from './carousel/write.js';
import { readJson, sendFile, sendJson } from './http.js';
import { enqueue } from './jobs.js';
import { run, runOk } from './proc.js';
import { cleanKey, router } from './routes.js';
import { anthropicKey, geminiKey, setStockKey, stockKeySource, type StockProvider } from './secrets.js';
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
  const body = await readJson<{ name?: string; theme?: string; formatId?: string }>(req);
  const c = await newCarousel(String(body.name ?? ''));
  if (body.theme) c.theme = String(body.theme).slice(0, 500);
  // フォーマットを選んで作ったときは、見た目・枚数・画像の方針を入れる
  const f = body.formatId ? (await listFormats()).find((x) => x.id === body.formatId) : undefined;
  sendJson(res, 200, await saveCarousel(f ? await withFormat(c, f) : c));
});

async function withFormat(c: Carousel, f: CarouselFormat): Promise<Carousel> {
  const img = async (id?: string) => (id ? await libraryToCarousel(c.id, id).catch(() => undefined) : undefined);
  return applyFormat(c, f, { backgroundImage: await img(f.backgroundImageId), leftCharacter: await img(f.leftCharacterId), rightCharacter: await img(f.rightCharacterId) });
}

/** 企画にフォーマットを当て直す(見た目・枚数・画像の方針) */
router.post('/api/carousels/:id/apply-format', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ carousel: Carousel; formatId: string }>(req, 10 * 1024 * 1024);
  if (!body.carousel || body.carousel.id !== id) throw new HttpError(400, 'IDが一致しません');
  const f = (await listFormats()).find((x) => x.id === body.formatId);
  if (!f) throw new HttpError(404, 'フォーマットが見つかりません');
  sendJson(res, 200, await withFormat(body.carousel, f));
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
    runner: async (ctx) => {
      const f = carousel.formatId ? (await listFormats()).find((x) => x.id === carousel.formatId) : undefined;
      return generateCarousel({ carousel, apiKey, signal: ctx.signal, progress: ctx.progress, formatInstructions: f?.instructions, geminiKey: geminiKey() });
    },
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
    runner: (ctx) => fillImages(carousel, ctx.signal, ctx.progress, { geminiKey: geminiKey() }),
  });
  sendJson(res, 200, job);
});

const category = (v: unknown): LibraryCategory => (typeof v === 'string' && v ? (decodeURIComponent(v) as LibraryCategory) : 'その他');
const tagList = (v: unknown): string[] => (Array.isArray(v) ? v.map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 20) : []);

/** 手元の画像を企画に入れる(素材ライブラリにも登録する) */
router.post('/api/carousels/:id/images', async (req, res) => {
  const id = assertId(req.params.id!);
  await loadCarousel(id);
  const up = await readUpload(req);
  sendJson(res, 200, await saveAndRegister(id, up.buf, up.ext, { name: path.basename(up.name, up.ext), category: category(req.headers['x-category']), source: 'upload' }));
});

/** 素材サイトの検索結果から1枚を取り込む */
router.post('/api/carousels/:id/stock', async (req, res) => {
  const id = assertId(req.params.id!);
  const hit = await readJson<StockHit & { tags?: string[] }>(req);
  provider(hit.provider);
  const img = await fetchStockImage(String(hit.full));
  const tags = tagList(hit.tags);
  sendJson(
    res,
    200,
    await saveAndRegister(id, img.buf, img.ext, {
      name: tags.join(' ').slice(0, 30) || `${hit.provider}-${hit.id}`,
      category: '写真',
      tags,
      source: hit.provider,
      credit: String(hit.credit ?? '').slice(0, 100),
      pageUrl: String(hit.pageUrl ?? '').slice(0, 300),
    }),
  );
});

/** 素材ライブラリの画像を企画に入れる */
router.post('/api/carousels/:id/from-library', async (req, res) => {
  const id = assertId(req.params.id!);
  const body = await readJson<{ itemId: string }>(req);
  sendJson(res, 200, await libraryToCarousel(id, String(body.itemId)));
});

interface AiBody {
  subject: string;
  style?: AiStyle;
  transparent?: boolean;
  aspectRatio?: '3:4' | '9:16' | '1:1' | '4:3';
  name?: string;
  category?: LibraryCategory;
  tags?: string[];
}

async function aiToLibrary(body: AiBody) {
  const key = geminiKey();
  if (!key) throw new HttpError(400, 'Gemini の APIキーが設定されていません');
  const style: AiStyle = body.style === 'photo' ? 'photo' : 'anime';
  const r = await generateAiImage({ apiKey: key, subject: String(body.subject ?? '').slice(0, 2000), style, transparent: !!body.transparent, aspectRatio: body.aspectRatio });
  const tags = tagList(body.tags);
  return { r, meta: { name: String(body.name || tags.join(' ') || 'AI画像').slice(0, 40), category: body.category ?? (style === 'anime' ? 'イラスト' : '写真'), tags, source: 'ai' as const, prompt: r.prompt } };
}

/** AI で画像を作って企画に入れる(素材ライブラリにも登録する) */
router.post('/api/carousels/:id/ai-image', async (req, res) => {
  const id = assertId(req.params.id!);
  const { r, meta } = await aiToLibrary(await readJson<AiBody>(req));
  sendJson(res, 200, await saveAndRegister(id, r.buf, r.ext, meta));
});

// ---- 素材ライブラリ ----

router.get('/api/carousel-library', async (_req, res) => {
  sendJson(res, 200, { dir: libraryDir(), defaultDir: DEFAULT_LIBRARY_DIR, driveCandidates: await driveFolderCandidates(), items: await libraryItems() });
});

router.post('/api/carousel-library', async (req, res) => {
  const up = await readUpload(req);
  const tags = String(decodeURIComponent(String(req.headers['x-tags'] ?? '')))
    .split(/[\s,、]+/)
    .filter(Boolean);
  sendJson(res, 200, await addToLibrary(up.buf, up.ext, { name: path.basename(up.name, up.ext), category: category(req.headers['x-category']), tags, source: 'upload' }));
});

/** AI で素材を作ってライブラリに入れる(キャラクターなど) */
router.post('/api/carousel-library/ai', async (req, res) => {
  const { r, meta } = await aiToLibrary(await readJson<AiBody>(req));
  sendJson(res, 200, await addToLibrary(r.buf, r.ext, meta));
});

router.put('/api/carousel-library/:itemId', async (req, res) => {
  const body = await readJson<{ name?: string; tags?: string[]; category?: LibraryCategory }>(req);
  sendJson(res, 200, await updateLibraryItem(req.params.itemId!, { name: body.name, tags: body.tags === undefined ? undefined : tagList(body.tags), category: body.category }));
});

router.del('/api/carousel-library/:itemId', async (req, res) => {
  await removeLibraryItem(req.params.itemId!);
  sendJson(res, 200, { ok: true });
});

router.get('/api/carousel-library/:itemId/file', async (req, res) => {
  const it = await libraryItem(req.params.itemId!);
  return sendFile(req, res, itemPath(it), { cache: 'private, max-age=3600' });
});

router.put('/api/carousel-library-dir', async (req, res) => {
  const body = await readJson<{ dir?: string | null }>(req);
  sendJson(res, 200, { dir: await setLibraryDir(body.dir ? String(body.dir) : null) });
});

/** Mac のフォルダ選択画面で、ライブラリのフォルダを選ぶ */
router.post('/api/carousel-library-dir/pick', async (_req, res) => {
  if (process.platform !== 'darwin') throw new HttpError(400, 'この機能は Mac でのみ使えます');
  const r = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "写真投稿の素材を置くフォルダを選んでください(Google ドライブのフォルダも可)")']);
  if (r.code !== 0) return sendJson(res, 200, { dir: libraryDir(), canceled: true });
  sendJson(res, 200, { dir: await setLibraryDir(r.stdout.trim()) });
});

router.post('/api/carousel-library-dir/reveal', async (_req, res) => {
  const dir = libraryDir();
  await fsp.mkdir(dir, { recursive: true });
  if (process.platform === 'darwin') await runOk('open', [dir]).catch(() => undefined);
  sendJson(res, 200, { path: dir });
});

// ---- フォーマット ----

router.get('/api/carousel-formats', async (_req, res) => sendJson(res, 200, await listFormats()));

router.put('/api/carousel-formats', async (req, res) => {
  const body = await readJson<CarouselFormat[]>(req, 2 * 1024 * 1024);
  if (!Array.isArray(body)) throw new HttpError(400, 'フォーマットの一覧ではありません');
  sendJson(res, 200, await saveFormats(body));
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
  // 素材ライブラリのフォルダ(Google ドライブの同期フォルダにしていれば Drive)にも置く
  const copied = await copyExportToLibrary(base, files).catch(() => null);
  sendJson(res, 200, { zip: zipName, files: files.map((f) => f.name), libraryPath: copied });
});

router.post('/api/carousels/:id/reveal', async (req, res) => {
  const dir = path.join(carouselDir(assertId(req.params.id!)), 'exports');
  await fsp.mkdir(dir, { recursive: true });
  if (process.platform === 'darwin') await runOk('open', [dir]).catch(() => undefined);
  sendJson(res, 200, { path: dir });
});
