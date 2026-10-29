// 写真投稿メーカーの一覧の画面。企画ボード・フォーマット・素材ライブラリ・設定 のタブ。
import {
  IMAGE_POLICY_LABELS,
  LIBRARY_CATEGORIES,
  searchLibrary,
  STATUS_LABELS,
  type BackgroundPreset,
  type Carousel,
  type CarouselFormat,
  type CarouselPage,
  type CarouselStatus,
  type ImagePolicy,
  type LibraryCategory,
  type LibraryItem,
} from '../shared/carousel.js';
import { waitJob } from './api.js';
import { capi, libraryUrl, type CarouselSummary, type KeySource, type Settings } from './carouselApi.js';
import { imageUrl } from './carouselRender.js';
import { openPicker } from './carouselPicker.js';
import { button, field, h, mount, numInput, select, toast } from './dom.js';

type HomeTab = 'board' | 'formats' | 'library' | 'settings';

const app = document.getElementById('app')!;
let settings: Settings = { anthropicKeySource: null, geminiKeySource: null, pixabayKeySource: null, pexelsKeySource: null };

export const STATUS_ORDER: CarouselStatus[] = ['idea', 'todo', 'done', 'fix', 'posted'];
export const POLICY_OPTIONS = Object.entries(IMAGE_POLICY_LABELS) as [ImagePolicy, string][];
export const BACKGROUND_OPTIONS: [BackgroundPreset, string][] = [
  ['lavender', 'ラベンダー'],
  ['pink-water', 'ピンクの水面'],
  ['pink', 'ピンクのグラデーション'],
  ['mint', 'ミント'],
  ['cream', 'クリーム'],
];

export async function showHome(tab: HomeTab) {
  document.title = '写真投稿メーカー';
  settings = await capi.settings().catch(() => settings);
  const nav = h(
    'div',
    { class: 'row gap cr-nav' },
    ([
      ['board', '企画'],
      ['formats', 'フォーマット'],
      ['library', '素材ライブラリ'],
      ['settings', '設定'],
    ] as [HomeTab, string][]).map(([t, l]) => h('a', { href: `/carousel?tab=${t}`, class: 'cr-tab' + (t === tab ? ' active' : '') }, l)),
  );
  const body = h('div', null, h('p', { class: 'hint' }, '読み込み中…'));
  mount(app, h('div', { class: 'home wide' }, h('p', null, h('a', { href: '/' }, '← 縦型動画メーカーへ')), h('h1', null, '写真投稿メーカー'), nav, body));
  try {
    if (tab === 'formats') await formatsTab(body);
    else if (tab === 'library') await libraryTab(body);
    else if (tab === 'settings') settingsTab(body);
    else await boardTab(body);
  } catch (e) {
    mount(body, h('p', { class: 'err' }, (e as Error).message));
  }
}

// ---------- 企画ボード ----------

async function boardTab(body: HTMLElement) {
  const [list, formats] = await Promise.all([capi.list(), capi.formats()]);
  const formatName = new Map(formats.map((f) => [f.id, f.name]));
  let filter: CarouselStatus | '' = (new URLSearchParams(location.search).get('status') as CarouselStatus) || '';
  const nameIn = h('input', { type: 'text', placeholder: '名前(空ならテーマから)', class: 'narrow2' });
  const themeIn = h('input', { type: 'text', placeholder: 'テーマ(例: ニキビがガチで消えた神習慣)', class: 'grow' });
  let formatId = formats[0]?.id ?? '';
  let status: CarouselStatus = 'todo';
  const create = async (open: boolean) => {
    const theme = themeIn.value.trim();
    if (!theme && !nameIn.value.trim()) return toast('テーマを入れてください', 'error');
    const c = await capi.create({ name: nameIn.value.trim() || theme.slice(0, 30), theme, formatId: formatId || undefined });
    if (status !== 'idea') await capi.save({ ...c, status });
    if (open) location.href = `/carousel?c=${c.id}`;
    else void showHome('board');
  };
  themeIn.addEventListener('keydown', (e) => e.key === 'Enter' && void create(false));
  const progress = h('div', { class: 'hint' });
  const table = h('div', { class: 'board' });
  const counts = (s: CarouselStatus) => list.filter((x) => x.status === s).length;
  const chips = h('div', { class: 'row gap wrap' });
  const render = () => {
    mount(
      chips,
      button(`すべて ${list.length}`, () => ((filter = ''), render()), { class: 'small' + (filter === '' ? ' primary' : '') }),
      STATUS_ORDER.map((s) => button(`${STATUS_LABELS[s]} ${counts(s)}`, () => ((filter = s), render()), { class: `small status-${s}` + (filter === s ? ' primary' : '') })),
    );
    const rows = list.filter((x) => !filter || x.status === filter);
    mount(
      table,
      rows.length ? rows.map((x) => boardRow(x, formatName)) : h('p', { class: 'hint' }, filter ? `「${STATUS_LABELS[filter]}」の企画はありません` : 'まだ企画がありません。上でテーマを入れて足してください。'),
    );
  };
  const runAll = async () => {
    if (!settings.anthropicKeySource) return toast('Claude の APIキーを「設定」タブで入れてください', 'error');
    const targets = list.filter((x) => x.status === 'todo');
    if (!confirm(`「作成する」の ${targets.length} 件を、順番に Claude で作ります(画像も方針どおりに入れます)。よろしいですか?`)) return;
    for (const [i, s] of targets.entries()) {
      mount(progress, `${i + 1}/${targets.length}「${s.name}」を作っています…`);
      try {
        const c = await capi.get(s.id);
        const job = await capi.generate(c);
        const j = await waitJob(job.id, (jj) => mount(progress, `${i + 1}/${targets.length}「${s.name}」 ${Math.round(jj.progress * 100)}% ${jj.message}`));
        if (j.status !== 'done') throw new Error(j.error ?? '失敗しました');
        const r = j.result as { pages: CarouselPage[]; caption: string; hashtags: string[]; notes: string[] };
        await capi.save({ ...c, pages: r.pages, caption: r.caption, hashtags: r.hashtags, status: 'done' });
        const miss = r.notes.find((n) => n.includes('入れられませんでした'));
        if (miss) toast(`「${s.name}」: ${miss}`, 'info', 10000);
      } catch (e) {
        toast(`「${s.name}」: ${(e as Error).message}`, 'error');
      }
    }
    mount(progress, '終わりました。');
    void showHome('board');
  };
  mount(
    body,
    h(
      'div',
      { class: 'card' },
      h('h2', null, '企画を足す'),
      h(
        'div',
        { class: 'row gap wrap' },
        themeIn,
        nameIn,
        field('フォーマット', select(formatId, [...formats.map((f) => [f.id, f.name] as [string, string]), ['', 'なし']], (v) => (formatId = v))),
        field('ステータス', select(status, STATUS_ORDER.map((s) => [s, STATUS_LABELS[s]] as [CarouselStatus, string]), (v) => (status = v))),
        button('足す', () => void create(false), { class: 'primary' }),
        button('足して開く', () => void create(true)),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row gap wrap' },
        h('h2', { class: 'grow' }, '企画一覧'),
        button(`「作成する」${list.filter((x) => x.status === 'todo').length} 件をまとめて作る`, () => void runAll(), { class: 'primary', disabled: list.every((x) => x.status !== 'todo') }),
      ),
      progress,
      chips,
      table,
    ),
  );
  render();
}

function boardRow(x: CarouselSummary, formatName: Map<string, string>): HTMLElement {
  const update = async (patch: Partial<Carousel>) => {
    try {
      const c = await capi.get(x.id);
      await capi.save({ ...c, ...patch });
      Object.assign(x, patch);
      row.className = `board-row status-${x.status}`;
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const date = h('input', { type: 'date', value: x.scheduledOn ?? '' });
  date.addEventListener('change', () => void update({ scheduledOn: date.value || undefined }));
  const memo = h('input', { type: 'text', value: x.memo, placeholder: 'メモ', class: 'grow' });
  memo.addEventListener('change', () => void update({ memo: memo.value }));
  const row = h(
    'div',
    { class: `board-row status-${x.status}` },
    h('a', { href: `/carousel?c=${x.id}`, class: 'board-thumb' }, x.cover ? h('img', { src: imageUrl(x.id, x.cover), alt: '' }) : h('span', null, `${x.pages}枚`)),
    h('div', { class: 'board-main' }, h('a', { href: `/carousel?c=${x.id}`, class: 'board-name' }, x.name), h('div', { class: 'hint' }, x.theme || '(テーマなし)'), memo),
    h(
      'div',
      { class: 'board-meta' },
      select(x.status, STATUS_ORDER.map((s) => [s, STATUS_LABELS[s]] as [CarouselStatus, string]), (v) => void update({ status: v })),
      h('span', { class: 'hint' }, `${x.formatId ? formatName.get(x.formatId) ?? '(削除したフォーマット)' : 'フォーマットなし'} / ${IMAGE_POLICY_LABELS[x.imagePolicy] ?? ''}`),
      h('label', { class: 'hint row gap' }, '投稿予定', date),
      h('span', { class: 'hint' }, `${x.pages} 枚 / ${new Date(x.updatedAt).toLocaleDateString('ja-JP')}`),
    ),
    h(
      'div',
      { class: 'board-actions' },
      button('開く', () => (location.href = `/carousel?c=${x.id}`), { class: 'small primary' }),
      button('削除', async () => {
        if (!confirm(`「${x.name}」を削除しますか?入れた画像と書き出したファイルも消えます(素材ライブラリの画像は残ります)。`)) return;
        await capi.remove(x.id);
        row.remove();
      }, { class: 'small danger' }),
    ),
  );
  return row;
}

// ---------- フォーマット ----------

async function formatsTab(body: HTMLElement) {
  let formats = await capi.formats();
  const lib = await capi.library();
  const items = new Map(lib.items.map((i) => [i.id, i]));
  let timer = 0;
  const save = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void capi.saveFormats(formats).then((r) => (formats = r)).catch((e) => toast((e as Error).message, 'error')), 500);
  };
  const libSlot = (label: string, id: string | undefined, category: LibraryCategory, ai: { transparent: boolean; aspectRatio: '3:4' | '9:16' }, set: (id: string | undefined) => void) =>
    h(
      'div',
      { class: 'img-slot' },
      id && items.get(id) ? h('img', { src: libraryUrl(id), class: 'img-thumb', alt: '' }) : h('div', { class: 'img-thumb empty' }, 'なし'),
      h(
        'div',
        { class: 'img-slot-body' },
        h('div', { class: 'field-label' }, label),
        h(
          'div',
          { class: 'row gap wrap' },
          button('選ぶ', () =>
            openPicker({ settings, category, tab: 'library', ai: { ...ai, style: 'anime' }, title: label }, (p) => {
              if (!p.item) return;
              items.set(p.item.id, p.item);
              set(p.item.id);
              render();
            }), { class: 'small' }),
          id ? button('外す', () => (set(undefined), render()), { class: 'small' }) : null,
        ),
      ),
    );
  const card = (f: CarouselFormat, i: number) => {
    const upd = (patch: Partial<CarouselFormat>, rerender = false) => {
      formats[i] = { ...formats[i]!, ...patch };
      save();
      if (rerender) render();
    };
    const text = (v: string, on: (v: string) => void, attrs: Record<string, unknown> = {}) => {
      const el = h('input', { type: 'text', value: v, ...attrs });
      el.addEventListener('input', () => on(el.value));
      return el;
    };
    const instr = h('textarea', { rows: 3, placeholder: '例: 左はあるあると笑えるダメな習慣、右は真似したくなる習慣' });
    instr.value = f.instructions;
    instr.addEventListener('input', () => upd({ instructions: instr.value }));
    return h(
      'div',
      { class: 'card format-card' },
      h(
        'div',
        { class: 'row gap' },
        text(f.name, (v) => upd({ name: v }), { class: 'grow format-name' }),
        button('複製', () => ((formats = [...formats.slice(0, i + 1), { ...f, id: '', name: f.name + ' のコピー' }, ...formats.slice(i + 1)]), save(), render()), { class: 'small' }),
        button('削除', () => confirm(`「${f.name}」を削除しますか?`) && ((formats = formats.filter((_, j) => j !== i)), save(), render()), { class: 'small danger' }),
      ),
      h(
        'div',
        { class: 'format-grid' },
        field(
          '左右の見出し',
          h(
            'div',
            null,
            select(f.heads, [['marks', '✖ / 〇 の記号'], ['words', '文字']], (v) => upd({ heads: v }, true)),
            f.heads === 'words' ? h('div', { class: 'row gap' }, text(f.leftWord, (v) => upd({ leftWord: v }), { class: 'grow', placeholder: '左(例: ドブス)' }), text(f.rightWord, (v) => upd({ rightWord: v }), { class: 'grow', placeholder: '右(例: 爆美女)' })) : null,
          ),
        ),
        field('背景', select(f.background, BACKGROUND_OPTIONS, (v) => upd({ background: v }))),
        field('比較ページの枚数', numInput(f.pageCount, { min: 1, max: 12, onChange: (v) => upd({ pageCount: v }) })),
        field('画像の方針', select(f.imagePolicy, POLICY_OPTIONS, (v) => upd({ imagePolicy: v }))),
      ),
      field('書き方の指示(Claude へ)', instr),
      h(
        'div',
        { class: 'format-grid' },
        libSlot('ページ背景画像', f.backgroundImageId, '背景', { transparent: false, aspectRatio: '9:16' }, (id) => upd({ backgroundImageId: id })),
        libSlot('下のキャラクター(左)', f.leftCharacterId, 'キャラクター', { transparent: true, aspectRatio: '3:4' }, (id) => upd({ leftCharacterId: id })),
        libSlot('下のキャラクター(右)', f.rightCharacterId, 'キャラクター', { transparent: true, aspectRatio: '3:4' }, (id) => upd({ rightCharacterId: id })),
      ),
    );
  };
  const list = h('div');
  const render = () => mount(list, formats.map((f, i) => card(f, i)));
  mount(
    body,
    h('p', { class: 'hint' }, 'よく使う型を登録しておくと、企画を足すときに選ぶだけで、見た目・枚数・書き方・画像の方針・キャラクターが入ります。変更は自動で保存します(素材ライブラリのフォルダの formats.json)。'),
    list,
    button('＋ フォーマットを足す', () => {
      formats = [...formats, { id: '', name: '新しいフォーマット', heads: 'marks', leftWord: '', rightWord: '', background: 'lavender', pageCount: 5, instructions: '', imagePolicy: 'stock-photo' }];
      save();
      render();
    }),
  );
  render();
}

// ---------- 素材ライブラリ ----------

const MOVE_NOTE = '保存先を変えます。今のフォルダの素材・フォーマット・企画・書き出しは、新しいフォルダへ移します(量が多いと少し時間がかかります)。よろしいですか?';

async function libraryTab(body: HTMLElement) {
  let info = await capi.library();
  let q = '';
  let cat: LibraryCategory | '' = '';
  let upCat: LibraryCategory = 'その他';
  const grid = h('div', { class: 'lib-grid' });
  const render = () => {
    const list = searchLibrary(info.items, q, cat);
    mount(grid, list.length ? list.map((it) => libCard(it)) : h('p', { class: 'hint' }, info.items.length ? '合う素材がありません' : 'まだ素材がありません。画像を入れるか、フォルダに直接置いて「読み込み直す」を押してください。'));
  };
  const reload = async () => {
    info = await capi.library();
    render();
  };
  const libCard = (it: LibraryItem): HTMLElement => {
    const name = h('input', { type: 'text', value: it.name });
    name.addEventListener('change', () => void capi.libraryUpdate(it.id, { name: name.value }).then((r) => Object.assign(it, r)));
    const tags = h('input', { type: 'text', value: it.tags.join(' '), placeholder: 'タグ(空白区切り)' });
    tags.addEventListener('change', () => void capi.libraryUpdate(it.id, { tags: tags.value.split(/[\s,、]+/).filter(Boolean) }).then((r) => Object.assign(it, r)));
    const src = { upload: '手元', pixabay: 'Pixabay', pexels: 'Pexels', ai: 'AI', library: '手元' }[it.source];
    return h(
      'div',
      { class: 'lib-card' },
      h('a', { href: libraryUrl(it.id), target: '_blank', class: 'lib-thumb' }, h('img', { src: libraryUrl(it.id), loading: 'lazy', alt: '' })),
      name,
      tags,
      h(
        'div',
        { class: 'row gap' },
        select<LibraryCategory>(it.category, LIBRARY_CATEGORIES.map((c) => [c, c] as [LibraryCategory, string]), (v) => void capi.libraryUpdate(it.id, { category: v }).then((r) => Object.assign(it, r))),
        h('span', { class: 'hint', title: it.credit ? `${it.credit} ${it.pageUrl ?? ''}` : it.prompt ?? '' }, src),
        h('span', { class: 'spacer' }),
        button('削除', async () => {
          if (!confirm(`「${it.name}」を素材ライブラリから削除しますか?(ファイルも消えます。企画に入れた画像は残ります)`)) return;
          await capi.libraryRemove(it.id);
          info.items = info.items.filter((x) => x.id !== it.id);
          render();
        }, { class: 'small danger' }),
      ),
    );
  };
  const files = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/gif' });
  const upload = async (list: FileList | File[]) => {
    let n = 0;
    for (const f of Array.from(list)) {
      try {
        await capi.libraryUpload(f, upCat);
        n++;
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, 'error');
      }
    }
    toast(`${n} 枚を入れました`, 'ok');
    await reload();
  };
  files.addEventListener('change', () => files.files && void upload(files.files).then(() => (files.value = '')));
  grid.addEventListener('dragover', (e) => e.preventDefault());
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
  });
  const qIn = h('input', { type: 'text', placeholder: '名前・タグで探す', class: 'grow' });
  qIn.addEventListener('input', () => ((q = qIn.value), render()));
  const inDrive = info.driveCandidates.some((d) => info.dir.startsWith(d));
  mount(
    body,
    h(
      'div',
      { class: 'card' },
      h('h2', null, '保存先のフォルダ'),
      h('div', { class: 'row gap wrap' }, h('code', { class: 'grow' }, info.dir), button('フォルダを開く', () => void capi.revealLibrary(), { class: 'small' }), button('フォルダを変える', () => confirm(MOVE_NOTE) && void capi.pickLibraryDir().then(() => showHome('library'), (e) => toast((e as Error).message, 'error')), { class: 'small' })),
      inDrive
        ? h('p', { class: 'ok-box' }, 'Google ドライブの同期フォルダです。素材・フォーマット・企画・書き出しは Drive に保存されます(Google ドライブの設定が「ストリーミング」なら、Mac には中身が残りません)。')
        : info.driveCandidates.length
          ? h(
              'div',
              null,
              h('p', { class: 'hint' }, 'Google ドライブ(パソコン版)の同期フォルダが見つかりました。ここにすると、素材・フォーマット・企画・書き出しがすべて Drive に入ります。Google ドライブの設定を「ストリーミング」にしておけば、Mac には中身が残りません。'),
              info.driveCandidates.map((d) =>
                button(`「${d}/写真投稿素材」にする`, () => confirm(MOVE_NOTE) && void capi.setLibraryDir(`${d}/写真投稿素材`).then(() => showHome('library'), (e) => toast((e as Error).message, 'error')), { class: 'small primary' }),
              ),
            )
          : h('p', { class: 'hint' }, 'Google ドライブに保存したいときは、Mac に「Google ドライブ」(パソコン版)を入れて、その中のフォルダを選んでください。フォルダの中の「キャラクター」「商品」などのサブフォルダに画像を置くと、その分類で読み込みます。'),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', null, '素材を入れる'),
      h('div', { class: 'row gap wrap' }, select<LibraryCategory>(upCat, LIBRARY_CATEGORIES.map((c) => [c, c] as [LibraryCategory, string]), (v) => (upCat = v)), files, button('AI で作る', () => openPicker({ settings, tab: 'ai', category: upCat, ai: upCat === 'キャラクター' ? { transparent: true } : {} }, () => void reload()), { class: 'small' }), button('読み込み直す', () => void reload(), { class: 'small' })),
      h('p', { class: 'hint' }, '下の一覧に画像をドラッグしても入れられます。素材サイトや AI で企画に入れた画像も、自動でここにたまります。'),
    ),
    h('div', { class: 'row gap' }, qIn, select<LibraryCategory | ''>(cat, [['', 'すべて'], ...LIBRARY_CATEGORIES.map((c) => [c, c] as [LibraryCategory, string])], (v) => ((cat = v), render()))),
    grid,
  );
  render();
}

// ---------- 設定 ----------

export function keyRow(label: string, source: KeySource, save: (k: string | null) => Promise<unknown>, help: HTMLElement | string, after: () => void): HTMLElement {
  const input = h('input', { type: 'password', placeholder: 'APIキー', autocomplete: 'off', class: 'grow' });
  const run = async (k: string | null) => {
    try {
      await save(k);
      after();
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

function settingsTab(body: HTMLElement) {
  const again = () => void showHome('settings');
  const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noreferrer' }, text);
  mount(
    body,
    h(
      'div',
      { class: 'card' },
      h('h2', null, 'APIキー'),
      h('p', { class: 'hint' }, 'キーはこの Mac の ~/TateDougaMaker/secrets.json に保存します(素材ライブラリや Drive には入りません)。'),
      keyRow('Claude(中身を書く)', settings.anthropicKeySource, (k) => capi.setAnthropicKey(k), h('span', null, link('https://platform.claude.com', 'platform.claude.com'), ' の API Keys で発行。テーマと指示の文章だけを送ります'), again),
      keyRow('Gemini(AI で画像を作る)', settings.geminiKeySource, (k) => capi.setGeminiKey(k), h('span', null, link('https://aistudio.google.com/apikey', 'Google AI Studio'), ' で発行。文字起こしと共通です'), again),
      keyRow('Pixabay(素材サイトの写真・イラスト)', settings.pixabayKeySource, (k) => capi.setStockKey('pixabay', k), h('span', null, link('https://pixabay.com/api/docs/', 'pixabay.com/api/docs'), ' でログインすると表示されます'), again),
      keyRow('Pexels(素材サイトの写真)', settings.pexelsKeySource, (k) => capi.setStockKey('pexels', k), h('span', null, link('https://www.pexels.com/api/', 'pexels.com/api'), ' で発行'), again),
    ),
  );
}
