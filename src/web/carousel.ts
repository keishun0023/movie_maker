// 写真投稿(比較カルーセル)の画面。テーマから Claude が中身を書き、素材サイトの画像を入れて、
// 1080×1920 の PNG(と本文)を書き出す。
import {
  captionText,
  creditLines,
  pageId,
  type BackgroundPreset,
  type Carousel,
  type CarouselImage,
  type CarouselPage,
  type CompareSide,
  type ImageQuery,
} from '../shared/carousel.js';
import type { FontInfo, JobInfo } from '../shared/types.js';
import { call, waitJob } from './api.js';
import { drawCarouselPage, HEAD_FONT_ID, imageUrl, setImageLoadedCallback, TEXT_FONT_ID, waitImages } from './carouselRender.js';
import { button, field, h, mount, numInput, select, toast } from './dom.js';
import { ensureFont, setFontInfos, setFontLoadedCallback } from './fonts.js';

type KeySource = 'env' | 'file' | null;
type Provider = 'pixabay' | 'pexels';
interface Settings {
  anthropicKeySource: KeySource;
  pixabayKeySource: KeySource;
  pexelsKeySource: KeySource;
}
interface StockHit {
  provider: Provider;
  id: string;
  thumb: string;
  full: string;
  width: number;
  height: number;
  credit: string;
  pageUrl: string;
}
type FilledImage = { pageId: string; slot: 'cover' | 'left' | 'right'; image: CarouselImage };

const capi = {
  list: () => call<{ id: string; name: string; updatedAt: string; pages: number }[]>('GET', '/api/carousels'),
  create: (name: string) => call<Carousel>('POST', '/api/carousels', { name }),
  get: (id: string) => call<Carousel>('GET', `/api/carousels/${id}`),
  save: (c: Carousel) => call<{ updatedAt: string }>('PUT', `/api/carousels/${c.id}`, c),
  remove: (id: string) => call<{ ok: boolean }>('DELETE', `/api/carousels/${id}`, {}),
  generate: (c: Carousel) => call<JobInfo>('POST', `/api/carousels/${c.id}/generate`, { carousel: c }),
  fillImages: (c: Carousel) => call<JobInfo>('POST', `/api/carousels/${c.id}/fill-images`, { carousel: c }),
  upload: (id: string, file: File) =>
    call<CarouselImage>('POST', `/api/carousels/${id}/images`, undefined, file, { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }),
  pickStock: (id: string, hit: StockHit) => call<CarouselImage>('POST', `/api/carousels/${id}/stock`, hit),
  search: (provider: Provider, q: ImageQuery) => call<StockHit[]>('GET', `/api/stock/search?provider=${provider}&kind=${q.kind}&q=${encodeURIComponent(q.q)}`),
  export: (id: string, pngs: string[]) => call<{ zip: string; files: string[] }>('POST', `/api/carousels/${id}/export`, { pngs }),
  reveal: (id: string) => call<{ path: string }>('POST', `/api/carousels/${id}/reveal`, {}),
  settings: () => call<Settings>('GET', '/api/settings'),
  setAnthropicKey: (key: string | null) => call<unknown>('PUT', '/api/settings/anthropic-key', { key }),
  setStockKey: (provider: Provider, key: string | null) => call<unknown>('PUT', '/api/settings/stock-key', { provider, key }),
};

const app = document.getElementById('app')!;

async function boot() {
  try {
    setFontInfos(await call<FontInfo[]>('GET', '/api/fonts'));
  } catch {
    /* フォントが読めなくても、ブラウザの文字で描く */
  }
  setFontLoadedCallback(() => redraw());
  setImageLoadedCallback(() => redraw());
  void ensureFont(TEXT_FONT_ID);
  void ensureFont(HEAD_FONT_ID);
  const id = new URLSearchParams(location.search).get('c');
  if (id) await openEditor(id);
  else await showHome();
}

// ---------- 一覧 ----------

async function showHome() {
  document.title = '写真投稿メーカー';
  const list = await capi.list();
  const nameIn = h('input', { type: 'text', placeholder: '投稿の名前(例: ニキビ習慣)' });
  const create = async () => {
    const c = await capi.create(nameIn.value || '新しい写真投稿');
    location.search = `?c=${c.id}`;
  };
  nameIn.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
  mount(
    app,
    h(
      'div',
      { class: 'home' },
      h('p', null, h('a', { href: '/' }, '← 縦型動画メーカーへ')),
      h('h1', null, '写真投稿メーカー'),
      h('p', { class: 'lead' }, 'テーマを入れると、Claude が「表紙 + ✖/〇 の比較ページ」の写真投稿を考え、素材サイトの画像を入れて、1080×1920 の画像として書き出します。'),
      h('div', { class: 'card' }, h('h2', null, '新しく作る'), h('div', { class: 'row gap' }, nameIn, button('作成', () => void create(), { class: 'primary' }))),
      h(
        'div',
        { class: 'card' },
        h('h2', null, '作った写真投稿'),
        list.length
          ? h(
              'ul',
              { class: 'project-list' },
              list.map((x) =>
                h(
                  'li',
                  null,
                  h('a', { href: `?c=${x.id}` }, x.name),
                  h('span', { class: 'hint' }, ` ${x.pages} 枚 / ${new Date(x.updatedAt).toLocaleString('ja-JP')}`),
                  button('削除', async () => {
                    if (!confirm(`「${x.name}」を削除しますか?入れた画像と書き出したファイルも消えます。`)) return;
                    await capi.remove(x.id);
                    void showHome();
                  }, { class: 'small danger' }),
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'まだありません'),
      ),
    ),
  );
}

// ---------- 編集 ----------

let c: Carousel;
let settings: Settings = { anthropicKeySource: null, pixabayKeySource: null, pexelsKeySource: null };
let canvases: HTMLCanvasElement[] = [];
let busy = '';
let notes: string[] = [];
let lastExport: { zip: string; files: string[] } | null = null;
let saveTimer = 0;

async function openEditor(id: string) {
  c = await capi.get(id);
  // 表紙は必ず1枚目に置く
  if (c.pages[0]?.kind !== 'cover') c.pages.unshift({ id: pageId(), kind: 'cover', kicker: '', title: '', query: { q: '', kind: 'photo' } });
  settings = await capi.settings().catch(() => settings);
  rebuild();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void capi.save(c).catch((e) => toast(`保存できませんでした: ${(e as Error).message}`, 'error')), 600);
}

/** 文字の変更など(画面の組み立てはそのまま、プレビューだけ描き直す) */
function edit(fn: (c: Carousel) => void) {
  fn(c);
  scheduleSave();
  redraw();
}

/** ページの増減・画像の変更など(画面を組み立て直す) */
function change(fn: (c: Carousel) => void) {
  fn(c);
  scheduleSave();
  rebuild();
}

function redraw() {
  if (!c) return;
  canvases.forEach((cv, i) => drawCarouselPage(cv, c, i));
}

function textIn(value: string, onInput: (v: string) => void, attrs: Record<string, unknown> = {}): HTMLInputElement {
  const el = h('input', { type: 'text', value, ...attrs });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function textArea(value: string, onInput: (v: string) => void, rows = 3, placeholder = ''): HTMLTextAreaElement {
  const el = h('textarea', { rows, placeholder });
  el.value = value;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function filePicker(onFile: (f: File) => void | Promise<void>, label = '画像を入れる'): HTMLElement {
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', style: { display: 'none' } });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) void Promise.resolve(onFile(f)).catch((e) => toast((e as Error).message, 'error'));
  });
  return h('span', null, input, button(label, () => input.click(), { class: 'small' }));
}

/** 画像の枠(サムネイル + 探す / 入れる / 外す) */
function imageSlot(im: CarouselImage | undefined, query: ImageQuery | null, set: (im: CarouselImage | undefined) => void, onQuery?: (q: ImageQuery) => void): HTMLElement {
  const upload = async (f: File) => set(await capi.upload(c.id, f));
  return h(
    'div',
    { class: 'img-slot' },
    im ? h('img', { src: imageUrl(c.id, im), class: 'img-thumb', alt: '' }) : h('div', { class: 'img-thumb empty' }, 'なし'),
    h(
      'div',
      { class: 'img-slot-body' },
      query && onQuery ? textIn(query.q, (v) => onQuery({ ...query, q: v }), { placeholder: '検索語(英語)', title: '「画像を探して入れる」で使う検索語' }) : null,
      h(
        'div',
        { class: 'row gap wrap' },
        query && onQuery ? select(query.kind, [['photo', '写真'], ['illustration', 'イラスト']], (v) => onQuery({ ...query, kind: v })) : null,
        query ? button('素材サイトで探す', () => openSearch(query, set), { class: 'small' }) : null,
        filePicker(upload),
        im ? button('外す', () => set(undefined), { class: 'small' }) : null,
        im && im.source !== 'upload' && im.pageUrl ? h('a', { href: im.pageUrl, target: '_blank', rel: 'noreferrer', class: 'hint' }, `${im.credit ?? ''} / ${im.source === 'pixabay' ? 'Pixabay' : 'Pexels'}`) : null,
      ),
    ),
  );
}

function sideEditor(label: string, side: CompareSide, pageIndex: number, key: 'left' | 'right'): HTMLElement {
  const get = (cc: Carousel) => (cc.pages[pageIndex] as Extract<CarouselPage, { kind: 'compare' }>)[key];
  return h(
    'div',
    { class: 'side-editor' },
    h('div', { class: 'side-title' }, label),
    textIn(side.text, (v) => edit((cc) => (get(cc).text = v)), { placeholder: '大きな言葉' }),
    textIn(side.note, (v) => edit((cc) => (get(cc).note = v)), { placeholder: '小さな補足(任意)' }),
    imageSlot(
      side.image,
      side.query,
      (im) => change((cc) => (get(cc).image = im)),
      (q) => edit((cc) => (get(cc).query = q)),
    ),
  );
}

function pageCard(p: CarouselPage, i: number): HTMLElement {
  const cv = h('canvas', { width: 360, height: 640, class: 'page-canvas' });
  canvases[i] = cv;
  const move = (d: number) =>
    change((cc) => {
      const j = i + d;
      if (j < 1 || j >= cc.pages.length) return;
      [cc.pages[i], cc.pages[j]] = [cc.pages[j]!, cc.pages[i]!];
    });
  const head = h(
    'div',
    { class: 'row gap page-head' },
    h('b', null, p.kind === 'cover' ? '1 表紙' : String(i + 1)),
    h('span', { class: 'spacer' }),
    p.kind === 'compare' ? button('↑', () => move(-1), { class: 'small', disabled: i <= 1 }) : null,
    p.kind === 'compare' ? button('↓', () => move(1), { class: 'small', disabled: i >= c.pages.length - 1 }) : null,
    p.kind === 'compare' ? button('削除', () => change((cc) => cc.pages.splice(i, 1)), { class: 'small danger' }) : null,
  );
  let body: HTMLElement;
  if (p.kind === 'cover') {
    const pc = (cc: Carousel) => cc.pages[i] as Extract<CarouselPage, { kind: 'cover' }>;
    body = h(
      'div',
      null,
      field('上の一言', textIn(p.kicker, (v) => edit((cc) => (pc(cc).kicker = v)), { placeholder: '皮膚科行く前にこれみて‼️' })),
      field('見出し', textIn(p.title, (v) => edit((cc) => (pc(cc).title = v)), { placeholder: 'ニキビがガチで消えた神習慣' })),
      field('背景の写真', imageSlot(p.image, p.query, (im) => change((cc) => (pc(cc).image = im)), (q) => edit((cc) => (pc(cc).query = q)))),
    );
  } else {
    const pc = (cc: Carousel) => cc.pages[i] as Extract<CarouselPage, { kind: 'compare' }>;
    const [l, r] = c.style.heads === 'words' ? [c.style.leftWord, c.style.rightWord] : ['✖ 左', '〇 右'];
    body = h(
      'div',
      null,
      h(
        'div',
        { class: 'row gap' },
        textIn(p.label, (v) => edit((cc) => (pc(cc).label = v)), { placeholder: 'ラベル(任意)', class: 'narrow' }),
        textIn(p.title, (v) => edit((cc) => (pc(cc).title = v)), { placeholder: 'お題', class: 'grow' }),
      ),
      textIn(p.subtitle, (v) => edit((cc) => (pc(cc).subtitle = v)), { placeholder: 'お題の下の一言(任意)' }),
      h('div', { class: 'sides' }, sideEditor(l, p.left, i, 'left'), sideEditor(r, p.right, i, 'right')),
    );
  }
  return h('div', { class: 'page-card' }, head, cv, body);
}

function keyRow(label: string, source: KeySource, save: (k: string | null) => Promise<unknown>, help: HTMLElement | string): HTMLElement {
  const input = h('input', { type: 'password', placeholder: 'APIキー', autocomplete: 'off', class: 'grow' });
  const run = async (k: string | null) => {
    try {
      await save(k);
      settings = await capi.settings();
      rebuild();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return h(
    'div',
    { class: 'key-row' },
    h('div', { class: 'field-label' }, label),
    source === 'env'
      ? h('div', { class: 'ok-box' }, '設定済み(環境変数)')
      : source === 'file'
        ? h('div', { class: 'ok-box row gap' }, '設定済み', h('span', { class: 'spacer' }), button('削除', () => void run(null), { class: 'small' }))
        : h('div', null, h('div', { class: 'row gap' }, input, button('保存', () => void run(input.value.trim() || null), { class: 'primary small' })), h('div', { class: 'hint' }, help)),
  );
}

function sidebar(): HTMLElement {
  const st = c.style;
  const hasStock = !!settings.pixabayKeySource || !!settings.pexelsKeySource;
  const canGenerate = !!settings.anthropicKeySource && !!c.theme.trim() && !busy;
  const generate = async () => {
    if (c.pages.length > 1 && !confirm('今のページを、Claude が作ったものに置き換えます。よろしいですか?')) return;
    await runJob('Claude で作成中', () => capi.generate(c), (r) => {
      const res = r as { pages: CarouselPage[]; caption: string; hashtags: string[]; notes: string[] };
      c.pages = res.pages;
      c.caption = res.caption;
      c.hashtags = res.hashtags;
      notes = res.notes;
    });
  };
  const fill = () =>
    runJob('画像を探しています', () => capi.fillImages(c), (r) => {
      const res = r as { images: FilledImage[]; notes: string[] };
      for (const f of res.images) {
        const p = c.pages.find((x) => x.id === f.pageId);
        if (!p) continue;
        if (p.kind === 'cover') p.image ??= f.image;
        else if (f.slot === 'left') p.left.image ??= f.image;
        else if (f.slot === 'right') p.right.image ??= f.image;
      }
      notes = res.notes;
    });
  const addPage = () =>
    change((cc) =>
      cc.pages.push({
        id: pageId(),
        kind: 'compare',
        label: '',
        title: '',
        subtitle: '',
        left: { text: '', note: '', query: { q: '', kind: 'photo' } },
        right: { text: '', note: '', query: { q: '', kind: 'photo' } },
      }),
    );
  const tags = textIn(c.hashtags.map((t) => '#' + t).join(' '), (v) => edit((cc) => (cc.hashtags = v.split(/[\s,、]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean))), { placeholder: '#美容 #垢抜け' });
  const credits = creditLines(c);
  return h(
    'div',
    { class: 'cr-side' },
    h('p', null, h('a', { href: '/carousel' }, '← 写真投稿の一覧')),
    field('名前', textIn(c.name, (v) => edit((cc) => (cc.name = v)))),
    h('h3', null, '1 中身を作る'),
    field('テーマ', textArea(c.theme, (v) => {
      edit((cc) => (cc.theme = v));
      // 入力中も「Claude で作る」を押せるかどうかを更新する
      const b = document.getElementById('cr-generate') as HTMLButtonElement | null;
      if (b) b.disabled = !(!!settings.anthropicKeySource && !!v.trim() && !busy);
    }, 2, '例: ニキビがガチで消えた神習慣 / 垢抜けない人の特徴'), 'どんな投稿にしたいか。Claude がお題と左右の言葉、画像の検索語を考えます。'),
    field('比較ページの枚数', numInput(c.pageCount, { min: 1, max: 12, onChange: (v) => edit((cc) => (cc.pageCount = v)) }), '表紙は別に1枚付きます'),
    field('追加の指示(任意)', textArea(c.notes, (v) => edit((cc) => (cc.notes = v)), 2, '例: 1ページは予測変換ネタにする / 語尾はやさしく')),
    keyRow('Claude の APIキー', settings.anthropicKeySource, (k) => capi.setAnthropicKey(k), 'platform.claude.com の API Keys で発行。テーマと指示の文章だけを Claude API に送ります(画像は送りません)。'),
    button('Claude で作る', () => void generate(), { class: 'primary big', id: 'cr-generate', disabled: !canGenerate }),
    busy ? h('div', { class: 'note', id: 'cr-progress' }, busy) : null,
    h('h3', null, '2 画像'),
    h('p', { class: 'hint' }, '無料で商用利用できる素材サイト(Pexels・Pixabay)から探します。ウェブ上の他人の画像は使いません。キーはどちらか一方でも使えます(イラストは Pixabay のみ)。'),
    keyRow('Pexels の APIキー', settings.pexelsKeySource, (k) => capi.setStockKey('pexels', k), h('span', null, h('a', { href: 'https://www.pexels.com/api/', target: '_blank', rel: 'noreferrer' }, 'pexels.com/api'), ' で無料登録して発行')),
    keyRow('Pixabay の APIキー', settings.pixabayKeySource, (k) => capi.setStockKey('pixabay', k), h('span', null, h('a', { href: 'https://pixabay.com/api/docs/', target: '_blank', rel: 'noreferrer' }, 'pixabay.com/api/docs'), ' でログインすると表示されます')),
    button('画像の無い枠に、画像を探して入れる', () => void fill(), { class: 'big', disabled: !hasStock || !!busy }),
    notes.length ? h('div', { class: 'note' }, notes.map((n) => h('div', null, n))) : null,
    h('h3', null, '3 見た目'),
    field(
      '左右の見出し',
      h(
        'div',
        null,
        select(st.heads, [['marks', '✖ / 〇 の記号'], ['words', '文字(例: ドブス / 爆美女)']], (v) => change((cc) => (cc.style.heads = v))),
        st.heads === 'words'
          ? h('div', { class: 'row gap' }, textIn(st.leftWord, (v) => edit((cc) => (cc.style.leftWord = v)), { class: 'grow' }), textIn(st.rightWord, (v) => edit((cc) => (cc.style.rightWord = v)), { class: 'grow' }))
          : null,
      ),
    ),
    field(
      '背景',
      h(
        'div',
        null,
        select<BackgroundPreset>(st.background, [['lavender', 'ラベンダー'], ['pink-water', 'ピンクの水面'], ['mint', 'ミント'], ['cream', 'クリーム']], (v) => edit((cc) => (cc.style.background = v))),
        imageSlot(st.backgroundImage, null, (im) => change((cc) => (cc.style.backgroundImage = im))),
      ),
      '背景の画像を入れると、色より優先します',
    ),
    field('下のキャラクター(左)', imageSlot(st.leftCharacter, null, (im) => change((cc) => (cc.style.leftCharacter = im))), '毎ページの下に出します。背景が透明な PNG がきれいです'),
    field('下のキャラクター(右)', imageSlot(st.rightCharacter, null, (im) => change((cc) => (cc.style.rightCharacter = im)))),
    h('h3', null, '4 本文と書き出し'),
    field('本文', textArea(c.caption, (v) => edit((cc) => (cc.caption = v)), 3, 'みんなはどれくらい当てはまった?👀')),
    field('ハッシュタグ', tags),
    button('本文をコピー', () => void navigator.clipboard.writeText(captionText(c)).then(() => toast('コピーしました', 'ok')), { class: 'small' }),
    credits.length ? h('p', { class: 'hint' }, `画像: ${credits.join(', ')}(書き出しの本文ファイルにも入れます)`) : null,
    button(busy === '書き出し中' ? '書き出し中…' : `${c.pages.length} 枚の画像を書き出す`, () => void exportAll(), { class: 'primary big', disabled: !!busy || c.pages.length === 0 }),
    lastExport
      ? h(
          'div',
          { class: 'ok-box' },
          h('div', null, `${lastExport.files.length - 1} 枚の PNG と本文を書き出しました。`),
          h('div', { class: 'row gap wrap' }, h('a', { href: `/api/carousels/${c.id}/files/exports/${encodeURIComponent(lastExport.zip)}?download=1` }, 'ZIP をダウンロード'), button('フォルダを開く', () => void capi.reveal(c.id), { class: 'small' })),
        )
      : null,
    button('＋ 比較ページを足す', () => addPage(), { class: 'small' }),
  );
}

function rebuild() {
  document.title = `${c.name} - 写真投稿メーカー`;
  canvases = [];
  const pages = h('div', { class: 'cr-pages' }, c.pages.map((p, i) => pageCard(p, i)));
  mount(app, h('div', { class: 'cr-layout' }, sidebar(), pages));
  redraw();
}

async function runJob(label: string, start: () => Promise<JobInfo>, done: (result: unknown) => void) {
  busy = label;
  notes = [];
  rebuild();
  try {
    clearTimeout(saveTimer);
    await capi.save(c);
    const job = await start();
    const j = await waitJob(job.id, (jj) => {
      busy = `${label} ${Math.round(jj.progress * 100)}% ${jj.message}`;
      const el = document.getElementById('cr-progress');
      if (el) el.textContent = busy;
    });
    if (j.status === 'done') {
      done(j.result);
      await capi.save(c);
    } else if (j.status === 'failed') toast(j.error ?? '失敗しました', 'error');
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    busy = '';
    rebuild();
  }
}

async function exportAll() {
  busy = '書き出し中';
  rebuild();
  try {
    await Promise.all([ensureFont(TEXT_FONT_ID), ensureFont(HEAD_FONT_ID), waitImages(c)]);
    const cv = document.createElement('canvas');
    cv.width = 1080;
    cv.height = 1920;
    const pngs: string[] = [];
    for (let i = 0; i < c.pages.length; i++) {
      drawCarouselPage(cv, c, i);
      pngs.push(cv.toDataURL('image/png'));
    }
    clearTimeout(saveTimer);
    await capi.save(c);
    lastExport = await capi.export(c.id, pngs);
    toast('書き出しました', 'ok');
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    busy = '';
    rebuild();
  }
}

// ---------- 素材サイトの検索 ----------

function openSearch(initial: ImageQuery, set: (im: CarouselImage) => void) {
  const providers: Provider[] = [];
  if (settings.pexelsKeySource) providers.push('pexels');
  if (settings.pixabayKeySource) providers.push('pixabay');
  if (providers.length === 0) {
    toast('素材サイト(Pexels・Pixabay)の APIキーを左の「2 画像」で設定してください', 'error');
    return;
  }
  let q: ImageQuery = { ...initial };
  let provider: Provider = initial.kind === 'illustration' && providers.includes('pixabay') ? 'pixabay' : providers[0]!;
  const results = h('div', { class: 'stock-grid' });
  const close = () => overlay.remove();
  const search = async () => {
    mount(results, h('p', { class: 'hint' }, '検索中…'));
    try {
      const hits = await capi.search(provider, q);
      mount(
        results,
        hits.length
          ? hits.map((hit) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'stock-hit',
                  title: `${hit.credit} (${hit.width}×${hit.height})`,
                  onClick: async () => {
                    try {
                      set(await capi.pickStock(c.id, hit));
                      close();
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  },
                },
                h('img', { src: `/api/stock/thumb?url=${encodeURIComponent(hit.thumb)}`, loading: 'lazy', alt: '' }),
              ),
            )
          : h('p', { class: 'hint' }, '見つかりませんでした。検索語を変えてみてください(英語のほうが見つかりやすいです)。'),
      );
    } catch (e) {
      mount(results, h('p', { class: 'err' }, (e as Error).message));
    }
  };
  const qIn = textIn(q.q, (v) => (q = { ...q, q: v }), { class: 'grow' });
  qIn.addEventListener('keydown', (e) => e.key === 'Enter' && void search());
  const overlay = h(
    'div',
    { class: 'cr-overlay', onClick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'cr-dialog' },
      h(
        'div',
        { class: 'row gap' },
        qIn,
        select(q.kind, [['photo', '写真'], ['illustration', 'イラスト']], (v) => (q = { ...q, kind: v })),
        select(provider, providers.map((p) => [p, p === 'pexels' ? 'Pexels' : 'Pixabay'] as [Provider, string]), (v) => (provider = v)),
        button('検索', () => void search(), { class: 'primary' }),
        button('閉じる', close),
      ),
      results,
    ),
  );
  document.body.appendChild(overlay);
  void search();
}

boot().catch((e) => mount(app, h('div', { class: 'fatal' }, `読み込めませんでした: ${(e as Error).message}`)));
