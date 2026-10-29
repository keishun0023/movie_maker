// 画像を選ぶダイアログ。素材ライブラリ・素材サイト・AI で作る・手元の画像 から1枚を選ぶ。
// 企画の枠に入れるとき(carouselId あり)は企画に、フォーマットの設定のとき(なし)はライブラリの素材として返す。
import { LIBRARY_CATEGORIES, searchLibrary, type CarouselImage, type ImageQuery, type LibraryCategory, type LibraryItem } from '../shared/carousel.js';
import { capi, libraryUrl, type AiRequest, type Provider, type Settings } from './carouselApi.js';
import { button, checkbox, h, mount, select, toast } from './dom.js';

type Tab = 'library' | 'stock' | 'ai' | 'file';

export interface PickerOptions {
  settings: Settings;
  /** 企画に入れるときの企画ID */
  carouselId?: string;
  /** 検索語・AI の内容の初期値 */
  query?: ImageQuery;
  /** ライブラリに登録するときのタグ(お題・言葉) */
  tags?: string[];
  /** 最初に開くタブ */
  tab?: Tab;
  /** ライブラリで最初に絞り込む分類 */
  category?: LibraryCategory;
  /** AI で作るときの既定(キャラクターなら透明・縦長) */
  ai?: Partial<AiRequest>;
  title?: string;
}

export type Picked = { image?: CarouselImage; item?: LibraryItem };

export function openPicker(opt: PickerOptions, done: (p: Picked) => void) {
  let tab: Tab = opt.tab ?? 'library';
  const body = h('div', { class: 'picker-body' });
  const tabs = h('div', { class: 'row gap picker-tabs' });
  const close = () => overlay.remove();
  const finish = (p: Picked) => {
    close();
    done(p);
  };
  const tabDefs: [Tab, string][] = [
    ['library', '素材ライブラリ'],
    ['stock', '素材サイト'],
    ['ai', 'AI で作る'],
    ['file', '手元の画像'],
  ];
  const show = () => {
    mount(tabs, tabDefs.map(([t, l]) => button(l, () => ((tab = t), show()), { class: 'small' + (t === tab ? ' primary' : '') })), h('span', { class: 'spacer' }), button('閉じる', close, { class: 'small' }));
    if (tab === 'library') libraryTab(body, opt, finish);
    else if (tab === 'stock') stockTab(body, opt, finish);
    else if (tab === 'ai') aiTab(body, opt, finish);
    else fileTab(body, opt, finish);
  };
  const overlay = h('div', { class: 'cr-overlay', onClick: (e: Event) => e.target === overlay && close() }, h('div', { class: 'cr-dialog' }, opt.title ? h('h3', { class: 'picker-title' }, opt.title) : null, tabs, body));
  document.body.appendChild(overlay);
  show();
}

/** 選んだライブラリの素材を、企画に入れる(企画がなければ素材のまま返す) */
async function pickItem(opt: PickerOptions, item: LibraryItem): Promise<Picked> {
  if (!opt.carouselId) return { item };
  return { image: await capi.fromLibrary(opt.carouselId, item.id), item };
}

function libraryTab(body: HTMLElement, opt: PickerOptions, finish: (p: Picked) => void) {
  let items: LibraryItem[] = [];
  let q = '';
  let cat: LibraryCategory | '' = opt.category ?? '';
  const grid = h('div', { class: 'stock-grid' });
  const render = () => {
    const list = searchLibrary(items, q, cat);
    mount(
      grid,
      list.length
        ? list.slice(0, 200).map((it) =>
            h(
              'button',
              {
                type: 'button',
                class: 'stock-hit lib-hit',
                title: `${it.name}\n${it.tags.join(' ')}`,
                onClick: () => void pickItem(opt, it).then(finish, (e) => toast((e as Error).message, 'error')),
              },
              h('img', { src: libraryUrl(it.id), loading: 'lazy', alt: '' }),
              h('span', { class: 'lib-name' }, it.name),
            ),
          )
        : h('p', { class: 'hint' }, items.length ? '合う素材がありません。言葉を変えるか、分類を「すべて」にしてください。' : 'まだ素材がありません。「素材ライブラリ」のタブで画像を入れるか、ほかのタブで画像を選ぶと、ここにたまっていきます。'),
    );
  };
  const qIn = h('input', { type: 'text', placeholder: '名前・タグで探す(例: 泣き顔 メガネ)', class: 'grow' });
  qIn.addEventListener('input', () => ((q = qIn.value), render()));
  mount(
    body,
    h('div', { class: 'row gap' }, qIn, select<LibraryCategory | ''>(cat, [['', 'すべて'], ...LIBRARY_CATEGORIES.map((c) => [c, c] as [LibraryCategory, string])], (v) => ((cat = v), render()))),
    grid,
  );
  mount(grid, h('p', { class: 'hint' }, '読み込み中…'));
  void capi.library().then(
    (r) => ((items = r.items), render()),
    (e) => mount(grid, h('p', { class: 'err' }, (e as Error).message)),
  );
}

function stockTab(body: HTMLElement, opt: PickerOptions, finish: (p: Picked) => void) {
  const providers: Provider[] = [];
  if (opt.settings.pixabayKeySource) providers.push('pixabay');
  if (opt.settings.pexelsKeySource) providers.push('pexels');
  if (providers.length === 0) return mount(body, h('p', { class: 'hint' }, '素材サイト(Pixabay・Pexels)の APIキーが未設定です。一覧の「設定」タブで入れてください。'));
  let q: ImageQuery = { q: opt.query?.q ?? '', kind: opt.query?.kind ?? 'photo' };
  let provider: Provider = q.kind === 'illustration' && providers.includes('pixabay') ? 'pixabay' : providers[0]!;
  const results = h('div', { class: 'stock-grid' });
  const search = async () => {
    if (!q.q.trim()) return mount(results, h('p', { class: 'hint' }, '検索語を入れてください(英語のほうが見つかりやすいです)。'));
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
                      if (opt.carouselId) finish({ image: await capi.pickStock(opt.carouselId, hit, opt.tags ?? []) });
                      else {
                        // フォーマットの設定などでは、ライブラリに入れてから返す
                        const blob = await (await fetch(`/api/stock/thumb?url=${encodeURIComponent(hit.full)}`)).blob();
                        const file = new File([blob], `${hit.provider}-${hit.id}.jpg`, { type: blob.type });
                        finish({ item: await capi.libraryUpload(file, opt.category ?? '写真', (opt.tags ?? []).join(' ')) });
                      }
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
  const qIn = h('input', { type: 'text', value: q.q, class: 'grow', placeholder: '検索語(英語)' });
  qIn.addEventListener('input', () => (q = { ...q, q: qIn.value }));
  qIn.addEventListener('keydown', (e) => e.key === 'Enter' && void search());
  mount(
    body,
    h(
      'div',
      { class: 'row gap' },
      qIn,
      select(q.kind, [['photo', '写真'], ['illustration', 'イラスト']], (v) => (q = { ...q, kind: v })),
      select(provider, providers.map((p) => [p, p === 'pexels' ? 'Pexels' : 'Pixabay'] as [Provider, string]), (v) => (provider = v)),
      button('検索', () => void search(), { class: 'primary' }),
    ),
    results,
  );
  void search();
}

function aiTab(body: HTMLElement, opt: PickerOptions, finish: (p: Picked) => void) {
  if (!opt.settings.geminiKeySource) return mount(body, h('p', { class: 'hint' }, 'Gemini の APIキーが未設定です。一覧の「設定」タブで入れてください。'));
  const req: AiRequest = { subject: opt.query?.q ?? '', style: 'anime', transparent: false, aspectRatio: '3:4', ...opt.ai };
  const subject = h('textarea', { rows: 3, placeholder: '作りたい画像の内容(英語がおすすめ。日本語でも可)。例: a girl with messy hair in a bun, round glasses, teary face, oversized beige sweater' });
  subject.value = req.subject;
  subject.addEventListener('input', () => (req.subject = subject.value));
  const status = h('div', { class: 'hint' });
  const preview = h('div', { class: 'ai-preview' });
  let last: Picked | null = null;
  const run = async () => {
    if (!req.subject.trim()) return toast('作りたい画像の内容を入れてください', 'error');
    goBtn.disabled = true;
    mount(status, 'AI で作っています(10〜30秒ほど)…');
    try {
      const tags = [...(opt.tags ?? []), ...(req.tags ?? [])];
      if (opt.carouselId) {
        const image = await capi.aiImage(opt.carouselId, { ...req, tags });
        last = { image };
        mount(preview, h('img', { src: `/api/carousels/${opt.carouselId}/files/images/${encodeURIComponent(image.file.replace(/^images\//, ''))}`, alt: '' }));
      } else {
        const item = await capi.libraryAi({ ...req, tags, category: opt.category ?? req.category });
        last = { item };
        mount(preview, h('img', { src: libraryUrl(item.id), alt: '' }));
      }
      mount(status, 'できました。気に入らなければ、内容を変えてもう一度作れます(作った画像は素材ライブラリにも残ります)。');
      useBtn.disabled = false;
    } catch (e) {
      mount(status, h('span', { class: 'err' }, (e as Error).message));
    } finally {
      goBtn.disabled = false;
    }
  };
  const goBtn = button('作る', () => void run(), { class: 'primary' });
  const useBtn = button('この画像を使う', () => last && finish(last), { class: 'primary', disabled: true });
  mount(
    body,
    subject,
    h(
      'div',
      { class: 'row gap wrap' },
      select(req.style, [['anime', 'アニメ調'], ['photo', '写真風']], (v) => (req.style = v)),
      select(req.aspectRatio, [['3:4', '縦長(3:4)'], ['9:16', '縦長(9:16)'], ['1:1', '正方形'], ['4:3', '横長(4:3)']], (v) => (req.aspectRatio = v)),
      checkbox(req.transparent, '背景を透明にする(キャラクター向け)', (v) => (req.transparent = v)),
      goBtn,
      useBtn,
    ),
    status,
    preview,
    h('p', { class: 'hint' }, '1枚あたり数円の利用料がかかります(Google の料金)。実写に見える画像を投稿するときは、TikTok の「AI 生成」のラベルを付けてください。'),
  );
}

function fileTab(body: HTMLElement, opt: PickerOptions, finish: (p: Picked) => void) {
  let cat: LibraryCategory = opt.category ?? 'その他';
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
  const go = async () => {
    const f = input.files?.[0];
    if (!f) return toast('画像を選んでください', 'error');
    try {
      if (opt.carouselId) {
        // 企画に入れた画像も、分類を付けてライブラリに入れる
        const item = await capi.libraryUpload(f, cat, (opt.tags ?? []).join(' '));
        finish({ image: await capi.fromLibrary(opt.carouselId, item.id), item });
      } else finish({ item: await capi.libraryUpload(f, cat, (opt.tags ?? []).join(' ')) });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  mount(
    body,
    h('p', { class: 'hint' }, '手元の画像を入れます。素材ライブラリにも登録するので、次からは「素材ライブラリ」のタブで選べます。'),
    h('div', { class: 'row gap wrap' }, input, select<LibraryCategory>(cat, LIBRARY_CATEGORIES.map((c) => [c, c] as [LibraryCategory, string]), (v) => (cat = v)), button('入れる', () => void go(), { class: 'primary' })),
  );
}
