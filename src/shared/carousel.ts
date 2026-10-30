// 写真投稿(比較カルーセル)の型と、Claude の応答を整える関数。
// 1枚目は表紙(全面の写真 + 見出し)、2枚目以降は「お題 + 左右の比較(×/○ や ドブス/爆美女)」のページ。

/** ページに使う画像(カルーセルのフォルダ内のファイル) */
export interface CarouselImage {
  /** カルーセルのフォルダからの相対パス(images/xxx.jpg) */
  file: string;
  source: 'pixabay' | 'pexels' | 'upload' | 'ai' | 'library';
  /** 素材ライブラリから入れた(または登録した)ときの素材ID */
  libraryId?: string;
  /** 撮影者・作者(素材サイトの画像のとき) */
  credit?: string;
  /** 素材サイトのページ */
  pageUrl?: string;
}

/** 画像を探すときの指定(Claude が考える) */
export interface ImageQuery {
  /** 検索語(英語のほうが見つかりやすい) */
  q: string;
  kind: 'photo' | 'illustration';
}

export interface CompareSide {
  /** 大きな言葉(例: ボーボー / ツルツル) */
  text: string;
  /** 小さな補足(例: まさかいないよね…?)。空でもよい */
  note: string;
  query: ImageQuery;
  image?: CarouselImage;
}

export interface CoverPage {
  id: string;
  kind: 'cover';
  /** 見出しの上の小さな一言(例: 皮膚科行く前にこれみて‼️) */
  kicker: string;
  /** 見出し(例: ニキビがガチで消えた神習慣) */
  title: string;
  query: ImageQuery;
  image?: CarouselImage;
  /** 見出しを置く高さ(0=上端〜1=下端。省略時は 0.46)。写真の顔に文字がかからないように動かす */
  titleY?: number;
}

export interface ComparePage {
  id: string;
  kind: 'compare';
  /** お題の上の小さなラベル(例: ドブスの特徴)。空でもよい */
  label: string;
  /** お題(例: 顔の毛) */
  title: string;
  /** お題の下の一言(例: 「お」って打ってなんて出てきた?)。空でもよい */
  subtitle: string;
  left: CompareSide;
  right: CompareSide;
}

/** 商品を紹介するページ(最後のページなど) */
export interface ProductPage {
  id: string;
  kind: 'product';
  /** 見出し(例: 美髪で人生変わる、ガチで) */
  title: string;
  /** 紹介文(数行) */
  body: string;
  query: ImageQuery;
  image?: CarouselImage;
  /** 打ち消し線で出す前の値段など(任意) */
  priceBefore: string;
  /** 赤く大きく出す一言(例: 今日限定 2,480円)(任意) */
  priceAfter: string;
}

export type CarouselPage = CoverPage | ComparePage | ProductPage;

export type BackgroundPreset = 'lavender' | 'pink-water' | 'pink' | 'mint' | 'cream';

export interface CarouselStyle {
  /** 左右の見出し: marks は ✖/〇 の記号、words は文字(例: ドブス/爆美女) */
  heads: 'marks' | 'words';
  leftWord: string;
  rightWord: string;
  /** 文字の見出しの色(省略時は黒) */
  leftColor?: string;
  rightColor?: string;
  background: BackgroundPreset;
  /** 背景に使う画像(あればプリセットより優先) */
  backgroundImage?: CarouselImage;
  /** 毎ページの下に置くキャラクター(ダメな子 / キレイな子) */
  leftCharacter?: CarouselImage;
  rightCharacter?: CarouselImage;
}

/** 企画の進み具合 */
export type CarouselStatus = 'idea' | 'todo' | 'done' | 'fix' | 'posted';

export const STATUS_LABELS: Record<CarouselStatus, string> = { idea: 'アイデア', todo: '作成する', done: '作成済み', fix: '修正する', posted: '投稿済み' };

/** 画像をどう用意するか */
export type ImagePolicy = 'stock-photo' | 'stock-illustration' | 'ai-anime' | 'ai-photo' | 'library' | 'none';

export const IMAGE_POLICY_LABELS: Record<ImagePolicy, string> = {
  'stock-photo': '素材サイトの写真',
  'stock-illustration': '素材サイトのイラスト',
  'ai-anime': 'AI で作る(アニメ調)',
  'ai-photo': 'AI で作る(写真風)',
  library: '素材ライブラリから選ぶ',
  none: '画像なし',
};

/** 素材ライブラリの分類(ライブラリのフォルダの中のサブフォルダ名) */
export const LIBRARY_CATEGORIES = ['キャラクター', 'イラスト', '写真', '商品', '背景', 'その他'] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

/** 素材ライブラリの1つの画像 */
export interface LibraryItem {
  id: string;
  name: string;
  category: LibraryCategory;
  /** ライブラリのフォルダからの相対パス */
  file: string;
  tags: string[];
  source: CarouselImage['source'];
  credit?: string;
  pageUrl?: string;
  /** AI で作ったときの指示文 */
  prompt?: string;
  width?: number;
  height?: number;
  hash: string;
  addedAt: string;
}

/** 企画の型(フォーマット)。選ぶと見た目・枚数・書き方・画像の方針がまとめて入る */
export interface CarouselFormat {
  id: string;
  name: string;
  heads: CarouselStyle['heads'];
  leftWord: string;
  rightWord: string;
  leftColor?: string;
  rightColor?: string;
  background: BackgroundPreset;
  /** 素材ライブラリの素材ID */
  backgroundImageId?: string;
  leftCharacterId?: string;
  rightCharacterId?: string;
  pageCount: number;
  /** Claude への書き方の指示 */
  instructions: string;
  imagePolicy: ImagePolicy;
}

export interface Carousel {
  id: string;
  name: string;
  status: CarouselStatus;
  /** 使ったフォーマット */
  formatId?: string;
  imagePolicy: ImagePolicy;
  /** 投稿予定日(YYYY-MM-DD) */
  scheduledOn?: string;
  /** メモ */
  memo: string;
  /** 作りたい投稿のテーマ(例: ニキビを消す習慣) */
  theme: string;
  /** 比較ページの枚数(表紙は別) */
  pageCount: number;
  /** Claude への追加の指示(任意) */
  notes: string;
  style: CarouselStyle;
  pages: CarouselPage[];
  /** 投稿の本文 */
  caption: string;
  hashtags: string[];
  createdAt: string;
  updatedAt: string;
}

export const CAROUSEL_W = 1080;
export const CAROUSEL_H = 1920;

export const DEFAULT_CAROUSEL_STYLE: CarouselStyle = {
  heads: 'marks',
  leftWord: 'ドブス',
  rightWord: '爆美女',
  background: 'lavender',
};

export function createCarousel(id: string, name: string): Carousel {
  const now = new Date().toISOString();
  return {
    id,
    name,
    status: 'idea',
    imagePolicy: 'stock-photo',
    memo: '',
    theme: '',
    pageCount: 5,
    notes: '',
    style: { ...DEFAULT_CAROUSEL_STYLE },
    pages: [],
    caption: '',
    hashtags: [],
    createdAt: now,
    updatedAt: now,
  };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r\n?/g, '\n').trim().slice(0, max);

function query(v: unknown, fallback: string): ImageQuery {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const q = str(o.q ?? o.query, 100) || fallback;
  return { q, kind: o.kind === 'illustration' ? 'illustration' : 'photo' };
}

let seq = 0;
export function pageId(): string {
  seq = (seq + 1) % 1e6;
  return `pg${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Claude が書いた投稿の中身(JSON)を、型どおりのページに直す。足りない項目は空にし、長すぎる文字は切る */
export function pagesFromDraft(draft: unknown, theme: string): { pages: CarouselPage[]; caption: string; hashtags: string[] } {
  const d = (draft && typeof draft === 'object' ? draft : {}) as Record<string, unknown>;
  const cov = (d.cover && typeof d.cover === 'object' ? d.cover : {}) as Record<string, unknown>;
  const pages: CarouselPage[] = [
    { id: pageId(), kind: 'cover', kicker: str(cov.kicker, 40), title: str(cov.title, 40) || theme, query: query(cov.image, theme) },
  ];
  const side = (v: unknown, title: string): CompareSide => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const text = str(o.text, 30);
    return { text, note: str(o.note, 40), query: query(o.image, `${title} ${text}`.trim()) };
  };
  for (const raw of Array.isArray(d.pages) ? d.pages : []) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const title = str(o.title, 30);
    if (!title) continue;
    pages.push({ id: pageId(), kind: 'compare', label: str(o.label, 20), title, subtitle: str(o.subtitle, 40), left: side(o.left, title), right: side(o.right, title) });
  }
  const tags = (Array.isArray(d.hashtags) ? d.hashtags : [])
    .map((t) => str(t, 30).replace(/^#+/, '').replace(/\s+/g, ''))
    .filter(Boolean);
  return { pages, caption: str(d.caption, 1000), hashtags: [...new Set(tags)].slice(0, 10) };
}

/** 投稿の本文(本文 + ハッシュタグ) */
export function captionText(c: Pick<Carousel, 'caption' | 'hashtags'>): string {
  const tags = c.hashtags.map((t) => '#' + t).join(' ');
  return [c.caption.trim(), tags].filter(Boolean).join('\n\n');
}

/** ページに使っている画像(素材サイトの作者の表記に使う) */
export function carouselImages(c: Carousel): CarouselImage[] {
  const out: CarouselImage[] = [];
  for (const p of c.pages) {
    if (p.kind !== 'compare') {
      if (p.image) out.push(p.image);
    } else {
      if (p.left.image) out.push(p.left.image);
      if (p.right.image) out.push(p.right.image);
    }
  }
  for (const im of [c.style.backgroundImage, c.style.leftCharacter, c.style.rightCharacter]) if (im) out.push(im);
  return out;
}

/** 素材サイトの画像の作者表記(本文に添える用) */
export function creditLines(c: Carousel): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const im of carouselImages(c)) {
    if ((im.source !== 'pixabay' && im.source !== 'pexels') || !im.credit) continue;
    const line = `${im.credit} (${im.source === 'pixabay' ? 'Pixabay' : 'Pexels'})`;
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/** フォーマットの見た目・枚数・画像の方針を企画に入れる(画像はライブラリから引いた CarouselImage を渡す) */
export function applyFormat(c: Carousel, f: CarouselFormat, images: { backgroundImage?: CarouselImage; leftCharacter?: CarouselImage; rightCharacter?: CarouselImage }): Carousel {
  return {
    ...c,
    formatId: f.id,
    pageCount: f.pageCount,
    imagePolicy: f.imagePolicy,
    style: {
      heads: f.heads,
      leftWord: f.leftWord,
      rightWord: f.rightWord,
      ...(f.leftColor ? { leftColor: f.leftColor } : {}),
      ...(f.rightColor ? { rightColor: f.rightColor } : {}),
      background: f.background,
      backgroundImage: images.backgroundImage,
      leftCharacter: images.leftCharacter,
      rightCharacter: images.rightCharacter,
    },
  };
}

/** 素材ライブラリの検索(名前・タグ・分類に、言葉がいくつ含まれるかで並べる) */
export function searchLibrary(items: LibraryItem[], query: string, category?: LibraryCategory | ''): LibraryItem[] {
  const words = query.toLowerCase().split(/[\s,、]+/).filter(Boolean);
  const pool = category ? items.filter((x) => x.category === category) : items;
  if (words.length === 0) return [...pool].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  return pool
    .map((x) => {
      const hay = [x.name, x.category, ...x.tags, x.prompt ?? ''].join(' ').toLowerCase();
      return { x, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.x.addedAt < b.x.addedAt ? 1 : -1))
    .map((r) => r.x);
}
