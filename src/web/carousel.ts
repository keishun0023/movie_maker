// 写真投稿(比較カルーセル)の画面。テーマから Claude が中身を書き、素材サイトの画像を入れて、
// 1080×1920 の PNG(と本文)を書き出す。
import {
  captionText,
  creditLines,
  IMAGE_POLICY_LABELS,
  pageId,
  STATUS_LABELS,
  type BackgroundPreset,
  type Carousel,
  type CarouselFormat,
  type CarouselImage,
  type CarouselPage,
  type CarouselStatus,
  type CompareSide,
  type ImageQuery,
  type LibraryCategory,
} from '../shared/carousel.js';
import type { FontInfo, JobInfo } from '../shared/types.js';
import { call, waitJob } from './api.js';
import { capi, type FilledImage, type Settings } from './carouselApi.js';
import { BACKGROUND_OPTIONS, POLICY_OPTIONS, showHome, STATUS_ORDER } from './carouselHome.js';
import { openPicker } from './carouselPicker.js';
import { drawCarouselPage, HEAD_FONT_ID, imageUrl, setImageLoadedCallback, TEXT_FONT_ID, waitImages } from './carouselRender.js';
import { button, field, h, mount, numInput, select, toast } from './dom.js';
import { ensureFont, setFontInfos, setFontLoadedCallback } from './fonts.js';

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
  else await showHome((new URLSearchParams(location.search).get('tab') as 'board') || 'board');
}

// ---------- 編集 ----------

let c: Carousel;
let settings: Settings = { anthropicKeySource: null, geminiKeySource: null, pixabayKeySource: null, pexelsKeySource: null };
let formats: CarouselFormat[] = [];
let canvases: HTMLCanvasElement[] = [];
let busy = '';
let notes: string[] = [];
let lastExport: { zip: string; files: string[]; libraryPath: string | null } | null = null;
let saveTimer = 0;

async function openEditor(id: string) {
  c = await capi.get(id);
  // 表紙は必ず1枚目に置く
  if (c.pages[0]?.kind !== 'cover') c.pages.unshift({ id: pageId(), kind: 'cover', kicker: '', title: '', query: { q: '', kind: 'photo' } });
  [settings, formats] = await Promise.all([capi.settings().catch(() => settings), capi.formats().catch(() => [])]);
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

/** 画像の枠(サムネイル + 選ぶ / 外す)。選ぶと、素材ライブラリ・素材サイト・AI・手元の画像から選べる */
function imageSlot(
  im: CarouselImage | undefined,
  query: ImageQuery | null,
  set: (im: CarouselImage | undefined) => void,
  opt: { onQuery?: (q: ImageQuery) => void; tags?: string[]; category?: LibraryCategory; transparent?: boolean; aspectRatio?: '3:4' | '9:16'; title?: string } = {},
): HTMLElement {
  const aiStyle = c.imagePolicy === 'ai-photo' ? 'photo' : 'anime';
  const firstTab = c.imagePolicy === 'library' || !query ? 'library' : c.imagePolicy.startsWith('ai') ? 'ai' : 'stock';
  const pick = () =>
    openPicker(
      {
        settings,
        carouselId: c.id,
        query: query ?? undefined,
        tags: opt.tags,
        tab: firstTab,
        category: opt.category,
        title: opt.title,
        ai: { style: aiStyle, transparent: !!opt.transparent, aspectRatio: opt.aspectRatio ?? '3:4' },
      },
      (p) => p.image && set(p.image),
    );
  const src = im ? { upload: '', library: 'ライブラリ', ai: 'AI', pixabay: 'Pixabay', pexels: 'Pexels' }[im.source] : '';
  return h(
    'div',
    { class: 'img-slot' },
    im ? h('img', { src: imageUrl(c.id, im), class: 'img-thumb', alt: '', onClick: pick }) : h('div', { class: 'img-thumb empty', onClick: pick }, 'なし'),
    h(
      'div',
      { class: 'img-slot-body' },
      query && opt.onQuery ? textIn(query.q, (v) => opt.onQuery!({ ...query, q: v }), { placeholder: c.imagePolicy.startsWith('ai') ? '作る画像の内容' : c.imagePolicy === 'library' ? '探す言葉' : '検索語(英語)', title: '「画像を入れる」で使う言葉' }) : null,
      h(
        'div',
        { class: 'row gap wrap' },
        button('画像を選ぶ', pick, { class: 'small' }),
        im ? button('外す', () => set(undefined), { class: 'small' }) : null,
        im && im.pageUrl ? h('a', { href: im.pageUrl, target: '_blank', rel: 'noreferrer', class: 'hint' }, `${im.credit ?? ''} / ${src}`) : src ? h('span', { class: 'hint' }, src) : null,
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
    imageSlot(side.image, side.query, (im) => change((cc) => (get(cc).image = im)), {
      onQuery: (q) => edit((cc) => (get(cc).query = q)),
      tags: [(c.pages[pageIndex] as Extract<CarouselPage, { kind: 'compare' }>).title, side.text].filter(Boolean),
      title: `${label}の画像`,
    }),
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
      field('表紙の画像', imageSlot(p.image, p.query, (im) => change((cc) => (pc(cc).image = im)), { onQuery: (q) => edit((cc) => (pc(cc).query = q)), tags: [c.theme, p.title].filter(Boolean), aspectRatio: '9:16', title: '表紙の画像' })),
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

function sidebar(): HTMLElement {
  const st = c.style;
  const policy = c.imagePolicy;
  const canFill =
    policy === 'library' || ((policy === 'stock-photo' || policy === 'stock-illustration') && (!!settings.pixabayKeySource || !!settings.pexelsKeySource)) || (policy.startsWith('ai') && !!settings.geminiKeySource);
  const applyFormat = async (formatId: string) => {
    if (!formatId) return change((cc) => delete cc.formatId);
    try {
      const next = await capi.applyFormat(c, formatId);
      change((cc) => Object.assign(cc, next));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const missing = [!settings.anthropicKeySource ? 'Claude' : '', policy.startsWith('ai') && !settings.geminiKeySource ? 'Gemini' : '', policy.startsWith('stock') && !settings.pixabayKeySource && !settings.pexelsKeySource ? 'Pixabay か Pexels' : ''].filter(Boolean);
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
    runJob(policy.startsWith('ai') ? 'AI で画像を作っています' : '画像を入れています', () => capi.fillImages(c), (r) => {
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
    h('p', null, h('a', { href: '/carousel' }, '← 企画一覧')),
    field('名前', textIn(c.name, (v) => edit((cc) => (cc.name = v)))),
    h(
      'div',
      { class: 'row gap wrap' },
      field('ステータス', select<CarouselStatus>(c.status, STATUS_ORDER.map((s) => [s, STATUS_LABELS[s]] as [CarouselStatus, string]), (v) => edit((cc) => (cc.status = v)))),
      field('投稿予定日', (() => {
        const d = h('input', { type: 'date', value: c.scheduledOn ?? '' });
        d.addEventListener('change', () => edit((cc) => (cc.scheduledOn = d.value || undefined)));
        return d;
      })()),
    ),
    field('フォーマット', select(c.formatId ?? '', [['', 'なし'], ...formats.map((f) => [f.id, f.name] as [string, string])], (v) => void applyFormat(v)), '選ぶと、見た目・枚数・画像の方針・キャラクターをフォーマットの設定にします'),
    field('メモ', textIn(c.memo, (v) => edit((cc) => (cc.memo = v)))),
    missing.length ? h('div', { class: 'note' }, `${missing.join('・')} の APIキーが未設定です。`, h('a', { href: '/carousel?tab=settings' }, '設定を開く')) : null,
    h('h3', null, '1 中身を作る'),
    field('テーマ', textArea(c.theme, (v) => {
      edit((cc) => (cc.theme = v));
      // 入力中も「Claude で作る」を押せるかどうかを更新する
      const b = document.getElementById('cr-generate') as HTMLButtonElement | null;
      if (b) b.disabled = !(!!settings.anthropicKeySource && !!v.trim() && !busy);
    }, 2, '例: ニキビがガチで消えた神習慣 / 垢抜けない人の特徴'), 'どんな投稿にしたいか。Claude がお題と左右の言葉、画像の検索語を考えます。'),
    field('比較ページの枚数', numInput(c.pageCount, { min: 1, max: 12, onChange: (v) => edit((cc) => (cc.pageCount = v)) }), '表紙は別に1枚付きます'),
    field('追加の指示(任意)', textArea(c.notes, (v) => edit((cc) => (cc.notes = v)), 2, '例: 1ページは予測変換ネタにする / 語尾はやさしく')),
    button('Claude で作る', () => void generate(), { class: 'primary big', id: 'cr-generate', disabled: !canGenerate }),
    busy ? h('div', { class: 'note', id: 'cr-progress' }, busy) : null,
    h('h3', null, '2 画像'),
    field('画像の方針', select(c.imagePolicy, POLICY_OPTIONS, (v) => change((cc) => (cc.imagePolicy = v))), 'Claude で作るときと、下のボタンで入れるときに使います。枠ごとに「画像を選ぶ」でも変えられます(ウェブ上の他人の画像は使いません)'),
    button(`画像の無い枠に入れる(${IMAGE_POLICY_LABELS[policy]})`, () => void fill(), { class: 'big', disabled: !canFill || !!busy || policy === 'none' }),
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
        select<BackgroundPreset>(st.background, BACKGROUND_OPTIONS, (v) => edit((cc) => (cc.style.background = v))),
        imageSlot(st.backgroundImage, null, (im) => change((cc) => (cc.style.backgroundImage = im)), { category: '背景', aspectRatio: '9:16', title: 'ページ背景画像' }),
      ),
      '背景の画像を入れると、色より優先します',
    ),
    field('下のキャラクター(左)', imageSlot(st.leftCharacter, null, (im) => change((cc) => (cc.style.leftCharacter = im)), { category: 'キャラクター', transparent: true, title: '下のキャラクター(左)' }), '毎ページの下に出します。背景が透明な PNG がきれいです'),
    field('下のキャラクター(右)', imageSlot(st.rightCharacter, null, (im) => change((cc) => (cc.style.rightCharacter = im)), { category: 'キャラクター', transparent: true, title: '下のキャラクター(右)' })),
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
          lastExport.libraryPath ? h('div', { class: 'hint' }, `素材ライブラリのフォルダにも置きました: ${lastExport.libraryPath}`) : null,
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

boot().catch((e) => mount(app, h('div', { class: 'fatal' }, `読み込めませんでした: ${(e as Error).message}`)));
