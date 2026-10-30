#!/usr/bin/env node
// 写真投稿を、画面を開かずに JSON の指定から PNG に書き出す(チャット・自動化用)。
// アプリの画面(/carousel)をヘッドレスの Chromium で開いて描くので、見た目はアプリの書き出しと同じになる。
//
// 使い方: npm run build してから
//   node scripts/carousel-render.mjs 指定.json 出力フォルダ
// 必要なもの: Playwright と Chromium(このリポジトリの依存には入れていない)。
//
// 指定.json の形(画像はファイルのパス。指定.json からの相対パスも可。省略すると点線の枠になる。
// image の代わりに "query": "pillow", "kind": "photo" | "illustration" を書くと、素材サイトで探して入れる。
// style の backgroundImage・leftCharacter・rightCharacter は、ファイルのパスの代わりに { "query": ..., "kind": ... } も書ける。
// その場合は環境変数 PIXABAY_API_KEY か PEXELS_API_KEY が必要):
// {
//   "name": "ニキビ習慣",
//   "style": { "heads": "marks" | "words", "leftWord": "ドブス", "rightWord": "爆美女",
//              "background": "lavender" | "pink-water" | "mint" | "cream",
//              "backgroundImage": "bg.jpg", "leftCharacter": "bad.png", "rightCharacter": "good.png" },
//   "cover": { "kicker": "皮膚科行く前にこれみて‼️", "title": "ニキビがガチで消えた神習慣", "image": "face.jpg", "titleY": 0.46(見出しの高さ 0〜1。省略可) },
//   "pages": [ { "label": "", "title": "顔の毛", "subtitle": "",
//                "left": { "text": "ボーボー", "note": "", "image": "a.jpg" },
//                "right": { "text": "ツルツル", "note": "", "image": "b.jpg" } } ],
//   (商品ページ: { "kind": "product", "title": ..., "body": "紹介文", "image": "商品.png", "priceBefore": "打ち消し線の値段", "priceAfter": "赤字の一言" })
//   "caption": "みんなはどれくらい当てはまった?👀", "hashtags": ["美容", "垢抜け"]
// }
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [specPath, outDir] = process.argv.slice(2);
if (!specPath || !outDir) {
  console.error('使い方: node scripts/carousel-render.mjs 指定.json 出力フォルダ');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'dist/server/main.js'))) {
  console.error('先に npm run build を実行してください');
  process.exit(2);
}

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const paths = [root];
  try {
    paths.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    /* npm がなければ、このリポジトリの中だけを探す */
  }
  try {
    return req(req.resolve('playwright', { paths }));
  } catch {
    console.error('Playwright が見つかりません(npm i -g playwright && npx playwright install chromium)');
    process.exit(2);
  }
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const specDir = path.dirname(path.resolve(specPath));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-carousel-'));
const port = 5300 + Math.floor(Math.random() * 600);
const base = `http://127.0.0.1:${port}`;
const H = { 'X-TDM': '1', Origin: base, 'Content-Type': 'application/json' };

const server = spawn(process.execPath, [path.join(root, 'dist/server/main.js')], {
  // プロキシのある環境では、Node の fetch もプロキシを通す
  env: { ...process.env, TDM_DATA_DIR: dataDir, PORT: String(port), ...(process.env.HTTPS_PROXY ? { NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } : {}) },
  stdio: 'ignore',
});
const cleanup = () => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
};

async function api(method, url, body, headers = H) {
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url}: ${j?.error ?? res.status}`);
  return j;
}

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/api/ping`);
      break;
    } catch {
      if (i > 50) throw new Error('サーバーが起動しませんでした');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c = await api('POST', '/api/carousels', { name: spec.name ?? '写真投稿' });
  // 画像はファイルのパスか、{ "query": "検索語", "kind": "photo" | "illustration" }(素材サイトの1件目を使う)
  const upload = async (p) => {
    if (!p) return undefined;
    if (typeof p === 'object') {
      const kind = p.kind === 'illustration' ? 'illustration' : 'photo';
      const provider = process.env.PIXABAY_API_KEY || kind === 'illustration' ? 'pixabay' : 'pexels';
      const hits = await api('GET', `/api/stock/search?provider=${provider}&kind=${kind}&q=${encodeURIComponent(String(p.query ?? ''))}`);
      if (!hits.length) {
        console.error(`画像が見つかりませんでした: ${p.query}`);
        return undefined;
      }
      return api('POST', `/api/carousels/${c.id}/stock`, hits[0]);
    }
    const file = path.resolve(specDir, p);
    return api('POST', `/api/carousels/${c.id}/images`, fs.readFileSync(file), { ...H, 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(path.basename(file)) });
  };
  const query = (o = {}) => ({ q: String(o.query ?? ''), kind: o.kind === 'illustration' ? 'illustration' : 'photo' });
  const side = async (s = {}) => ({ text: s.text ?? '', note: s.note ?? '', query: query(s), image: await upload(s.image) });
  const st = spec.style ?? {};
  c.style = {
    ...c.style,
    ...Object.fromEntries(Object.entries(st).filter(([k]) => !['backgroundImage', 'leftCharacter', 'rightCharacter'].includes(k))),
    backgroundImage: await upload(st.backgroundImage),
    leftCharacter: await upload(st.leftCharacter),
    rightCharacter: await upload(st.rightCharacter),
  };
  const cov = spec.cover ?? {};
  c.pages = [{ id: 'p0', kind: 'cover', kicker: cov.kicker ?? '', title: cov.title ?? '', query: query(cov), image: await upload(cov.image), ...(typeof cov.titleY === 'number' ? { titleY: cov.titleY } : {}) }];
  for (const [i, p] of (spec.pages ?? []).entries()) {
    if (p.kind === 'product') {
      c.pages.push({ id: `p${i + 1}`, kind: 'product', title: p.title ?? '', body: p.body ?? '', query: query(p), image: await upload(p.image), priceBefore: p.priceBefore ?? '', priceAfter: p.priceAfter ?? '' });
      continue;
    }
    c.pages.push({ id: `p${i + 1}`, kind: 'compare', label: p.label ?? '', title: p.title ?? '', subtitle: p.subtitle ?? '', left: await side(p.left), right: await side(p.right) });
  }
  c.caption = spec.caption ?? '';
  c.hashtags = (spec.hashtags ?? []).map((t) => String(t).replace(/^#+/, ''));
  // 検索語だけが書かれた枠は、素材サイトで探して入れる
  const wanted = c.pages.some((p) => (p.kind !== 'compare' ? [p] : [p.left, p.right]).some((x) => !x.image && x.query.q));
  if (wanted) {
    // 検索語のない枠は探さない(画像を入れたことにして外す)
    const empty = [];
    for (const p of c.pages) for (const x of p.kind !== 'compare' ? [p] : [p.left, p.right]) if (!x.image && !x.query.q) empty.push(x);
    for (const x of empty) x.image = { file: 'images/none', source: 'upload' };
    let job = await api('POST', `/api/carousels/${c.id}/fill-images`, { carousel: c });
    while (job.status !== 'done' && job.status !== 'failed' && job.status !== 'canceled') {
      await new Promise((r) => setTimeout(r, 400));
      job = await api('GET', `/api/jobs/${job.id}`);
    }
    for (const x of empty) delete x.image;
    if (job.status !== 'done') throw new Error(`画像を探せませんでした: ${job.error ?? job.status}`);
    for (const f of job.result.images) {
      const p = c.pages.find((x) => x.id === f.pageId);
      if (p) (p.kind !== 'compare' ? p : p[f.slot]).image = f.image;
    }
    for (const n of job.result.notes) console.error(n);
  }
  await api('PUT', `/api/carousels/${c.id}`, c);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/carousel?c=${c.id}`);
    await page.getByText('枚の画像を書き出す').click();
    await page.getByText('ZIP をダウンロード').waitFor({ timeout: 60000 });
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await browser.close();
  }
  const exp = path.join(dataDir, '写真投稿素材', '企画', c.id, 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(exp)) fs.copyFileSync(path.join(exp, f), path.join(outDir, f));
  console.log(fs.readdirSync(exp).map((f) => path.join(outDir, f)).join('\n'));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  cleanup();
}
