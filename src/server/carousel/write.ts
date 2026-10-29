// 写真投稿の中身を Claude に考えてもらい、各ページの画像を素材サイトから探して入れる。
// Claude に送るのはテーマと指示の文章だけ(画像は送らない)。
import type Anthropic from '@anthropic-ai/sdk';
import { pagesFromDraft, searchLibrary, type Carousel, type CarouselImage, type CarouselPage, type ImagePolicy, type ImageQuery, type LibraryCategory } from '../../shared/carousel.js';
import { AI_MODEL, friendlyError } from '../ai/assign.js';
import { CanceledError } from '../proc.js';
import { generateAiImage } from './ai.js';
import { libraryItems, libraryToCarousel, saveAndRegister } from './library.js';
import { fetchStockImage, providersFor, searchStock } from './stock.js';

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', description: '素材サイトで探す検索語(英語。具体的な見た目を2〜5語で)' },
    kind: { type: 'string', enum: ['photo', 'illustration'] },
  },
  required: ['q', 'kind'],
  additionalProperties: false,
} as const;

const SIDE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '大きく出す言葉(8文字以内)' },
    note: { type: 'string', description: '小さな補足(16文字以内。不要なら空)' },
    image: IMAGE_SCHEMA,
  },
  required: ['text', 'note', 'image'],
  additionalProperties: false,
} as const;

const SCHEMA = {
  type: 'object',
  properties: {
    cover: {
      type: 'object',
      properties: {
        kicker: { type: 'string', description: '見出しの上の一言(20文字以内)' },
        title: { type: 'string', description: '見出し(16文字以内)' },
        image: IMAGE_SCHEMA,
      },
      required: ['kicker', 'title', 'image'],
      additionalProperties: false,
    },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'お題の上の小さなラベル(10文字以内。不要なら空)' },
          title: { type: 'string', description: 'お題(10文字以内)' },
          subtitle: { type: 'string', description: 'お題の下の一言(20文字以内。不要なら空)' },
          left: SIDE_SCHEMA,
          right: SIDE_SCHEMA,
        },
        required: ['label', 'title', 'subtitle', 'left', 'right'],
        additionalProperties: false,
      },
    },
    caption: { type: 'string', description: '投稿の本文(1〜3行)' },
    hashtags: { type: 'array', items: { type: 'string' }, description: 'ハッシュタグ(#なし、3〜6個)' },
  },
  required: ['cover', 'pages', 'caption', 'hashtags'],
  additionalProperties: false,
} as const;

/** 画像の方針ごとの、image.q の書き方 */
function imageGuide(policy: ImagePolicy): string {
  switch (policy) {
    case 'ai-anime':
    case 'ai-photo':
      return `- 画像は AI で${policy === 'ai-anime' ? '日本のアニメ調のイラスト' : '写真風の画像'}として作る。image.q には、作る画像の内容を英語で具体的に書く(人物の見た目・表情・しぐさ・持ち物・構図。例: "a girl with messy hair touching a pimple on her cheek in front of a mirror, worried face")。画風の指定は書かない(アプリが足す)。文字は入れない。人物は実在の人に似せない。kind は ${policy === 'ai-anime' ? 'illustration' : 'photo'}。`;
    case 'library':
      return '- 画像は利用者の素材ライブラリから選ぶ。image.q には、素材を探すための日本語の言葉を2〜4個、空白で区切って書く(例: "泣き顔 メガネ", "スマホ 手")。';
    case 'none':
      return '- 画像は使わないが、image.q には後で探すための英語の検索語を書いておく。';
    default:
      return `- 画像の検索語(image.q)は、Pixabay・Pexels のような無料素材サイトで見つかりやすい英語にする(例: "woman smooth skin face closeup", "messy desk cosmetics", "cartoon smartphone hand")。${policy === 'stock-illustration' ? 'kind は illustration にする。' : '顔の比較などの写真は photo、物や手のしぐさなどは illustration も可。'}`;
  }
}

function systemPrompt(c: Carousel): string {
  const bad = c.style.heads === 'words' ? c.style.leftWord : '✖(ダメな例)';
  const good = c.style.heads === 'words' ? c.style.rightWord : '〇(良い例)';
  return `あなたは TikTok の「比較カルーセル(写真投稿)」の構成作家です。
1枚目は表紙、2枚目以降は1ページに1つのお題で「左: ${bad}」と「右: ${good}」を並べて比べる投稿を作ります。

例(美容ジャンル):
- 表紙: kicker「皮膚科行く前にこれみて‼️」 title「ニキビがガチで消えた神習慣」
- お題「顔の毛」 左「ボーボー」 右「ツルツル」
- お題「予測変換」 subtitle「「お」って打ってなんて出てきた?」 左「おけー」 右「お菓子一緒に食べたい🥺」
- label「ドブスの特徴」 お題「脚の隙間=垢抜け」 左「脚の隙間を作ろうと細さだけを追求」 右「自分の体質に合った健康的な見せ方を意識」
- お題「鼻で「いいね」押せる?」 subtitle「コメントで押せたか教えてね!」 左「押せない」note「まさかいないよね…?」 右「押せる」note「押せたら爆美女確定😘」

書き方:
- 言葉は短く、話し言葉で、思わず続きを見たくなるように。左は「あるある」と笑えるダメな例、右は真似したくなる良い例にする。
- お題は毎ページ違う切り口にする。コメントしたくなる問いかけのページを1つ入れてよい。
- 絵文字はところどころ控えめに。
- けなす対象は習慣・行動・持ち物・やり方にする。生まれつきの顔立ち・体型・肌の色・年齢などをばかにしない。
- 医学的な効果を言い切らない(「治る」「必ず」などは使わない)。実在の人物・商品名は出さない。
${imageGuide(c.imagePolicy ?? 'stock-photo')}
- 表紙の画像は、テーマに合う人物の顔のアップなど、目を引く縦長の画像にする。
- 本文(caption)は1〜3行で、最後はコメントしたくなる問いかけにする(例: 「みんなはどれくらい当てはまった?👀」)。
- 利用者の追加の指示があれば従う。ただし上の禁止事項は守る。`;
}

export interface CarouselJobOptions {
  carousel: Carousel;
  apiKey: string;
  signal: AbortSignal;
  progress: (v: number, m?: string) => void;
  /** フォーマットの書き方の指示 */
  formatInstructions?: string;
  geminiKey?: string | null;
}

/** Claude で投稿の中身を書き、画像を探して入れる */
export async function generateCarousel(opt: CarouselJobOptions): Promise<{ pages: CarouselPage[]; caption: string; hashtags: string[]; notes: string[] }> {
  const { carousel: c, signal, progress } = opt;
  if (!c.theme.trim()) throw new Error('テーマを入れてください。');
  const n = Math.max(1, Math.min(12, Math.round(c.pageCount) || 5));
  const { default: AnthropicCls } = await import('@anthropic-ai/sdk').catch(() => {
    throw new Error('Claude API のライブラリが入っていません。ターミナルで npm install を実行してから起動し直してください。');
  });
  const client = new AnthropicCls({ apiKey: opt.apiKey });
  const user =
    `# テーマ\n${c.theme.trim()}\n\n# 比較ページの枚数\n${n} 枚(表紙は別)\n` +
    (opt.formatInstructions?.trim() ? `\n# この型の書き方\n${opt.formatInstructions.trim()}\n` : '') +
    (c.notes.trim() ? `\n# 追加の指示\n${c.notes.trim()}\n` : '') +
    `\n表紙と ${n} 枚の比較ページ、本文、ハッシュタグを作ってください。`;
  progress(0.03, 'Claude が投稿の中身を考えています');
  let msg: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream(
      {
        model: AI_MODEL,
        max_tokens: 16000,
        system: systemPrompt(c),
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA as unknown as { [key: string]: unknown } } },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );
    const expected = 300 + n * 300;
    let chars = 0;
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        chars += ev.delta.text.length;
        progress(0.05 + 0.35 * Math.min(1, chars / expected), `Claude が書いています (${Math.min(99, Math.round((chars / expected) * 100))}%)`);
      }
    }
    msg = await stream.finalMessage();
  } catch (e) {
    if (signal.aborted) throw new CanceledError();
    throw friendlyError(e, AnthropicCls);
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude がこの内容の作成を断りました。テーマや指示を変えてください。');
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude の応答が長すぎて途中で切れました。枚数を減らして再試行してください。');
  let draft: unknown;
  try {
    draft = JSON.parse(msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  } catch {
    throw new Error('Claude の応答を読み取れませんでした。再試行してください。');
  }
  const out = pagesFromDraft(draft, c.theme.trim());
  if (out.pages.length < 2) throw new Error('Claude の応答に比較ページがありませんでした。再試行してください。');
  const notes = [`Claude (${msg.model}) で表紙と ${out.pages.length - 1} 枚の比較ページを作りました。入力 ${msg.usage.input_tokens} / 出力 ${msg.usage.output_tokens} トークン。`];
  if (msg.content.some((b) => b.type === 'fallback')) notes.push(`安全判定により別モデル(${msg.model})で処理しました。`);

  const filled = await fillImages({ ...c, pages: out.pages }, signal, (v, m) => progress(0.42 + 0.58 * v, m), { geminiKey: opt.geminiKey });
  for (const f of filled.images) {
    const p = out.pages.find((x) => x.id === f.pageId);
    if (!p) continue;
    if (p.kind === 'cover') p.image = f.image;
    else if (f.slot === 'left') p.left.image = f.image;
    else if (f.slot === 'right') p.right.image = f.image;
  }
  return { ...out, notes: [...notes, ...filled.notes] };
}

export type ImageSlot = 'cover' | 'left' | 'right';

export interface FilledImage {
  pageId: string;
  slot: ImageSlot;
  image: CarouselImage;
}

export interface FillOptions {
  geminiKey?: string | null;
}

interface Slot {
  pageId: string;
  slot: ImageSlot;
  query: ImageQuery;
  /** ライブラリに登録するときのタグ(お題・言葉) */
  tags: string[];
}

/**
 * 画像の入っていない枠に、画像の方針どおりに画像を入れる(素材サイトで探す / AI で作る / ライブラリから選ぶ)。
 * 同じ画像は2回使わない。素材サイトと AI の画像は素材ライブラリにも登録する。
 */
export async function fillImages(c: Carousel, signal: AbortSignal, progress: (v: number, m?: string) => void, opt: FillOptions = {}): Promise<{ images: FilledImage[]; notes: string[] }> {
  const policy: ImagePolicy = c.imagePolicy ?? 'stock-photo';
  const slots: Slot[] = [];
  for (const p of c.pages) {
    if (p.kind === 'cover') {
      if (!p.image) slots.push({ pageId: p.id, slot: 'cover', query: p.query, tags: [c.theme, p.title].filter(Boolean) });
    } else {
      if (!p.left.image) slots.push({ pageId: p.id, slot: 'left', query: p.left.query, tags: [p.title, p.left.text].filter(Boolean) });
      if (!p.right.image) slots.push({ pageId: p.id, slot: 'right', query: p.right.query, tags: [p.title, p.right.text].filter(Boolean) });
    }
  }
  if (slots.length === 0) return { images: [], notes: [] };
  if (policy === 'none') return { images: [], notes: ['画像の方針が「画像なし」なので、画像は入れていません。'] };
  const ai = policy === 'ai-anime' || policy === 'ai-photo';
  if (ai && !opt.geminiKey) return { images: [], notes: ['Gemini の APIキーが未設定のため、AI の画像は作っていません。設定画面でキーを入れてください。'] };
  if ((policy === 'stock-photo' || policy === 'stock-illustration') && providersFor('photo').length === 0) {
    return { images: [], notes: ['素材サイト(Pixabay・Pexels)の APIキーが未設定のため、画像は入れていません。キーを設定して「画像を入れる」を押すか、手元の画像を入れてください。'] };
  }
  const library = policy === 'library' ? await libraryItems() : [];
  // すでに使っている画像は使わない
  const used = new Set<string>();
  for (const p of c.pages) {
    for (const im of p.kind === 'cover' ? [p.image] : [p.left.image, p.right.image]) {
      if (im?.pageUrl) used.add(im.pageUrl);
      if (im?.libraryId) used.add(im.libraryId);
    }
  }
  const images: FilledImage[] = [];
  const misses: string[] = [];
  const errors = new Set<string>();
  let done = 0;
  let next = 0;
  const verb = ai ? '作っています' : '探しています';
  const worker = async () => {
    while (next < slots.length) {
      const s = slots[next++]!;
      if (signal.aborted) throw new CanceledError();
      try {
        let image: CarouselImage | null = null;
        if (ai) {
          const style = policy === 'ai-anime' ? 'anime' : 'photo';
          const r = await generateAiImage({ apiKey: opt.geminiKey!, subject: s.query.q, style, aspectRatio: s.slot === 'cover' ? '9:16' : '3:4', signal });
          const category: LibraryCategory = style === 'anime' ? 'イラスト' : '写真';
          image = await saveAndRegister(c.id, r.buf, r.ext, { name: s.tags.join(' ').slice(0, 30) || 'AI画像', category, tags: s.tags, source: 'ai', prompt: r.prompt });
        } else if (policy === 'library') {
          const pick = searchLibrary(library, s.query.q).find((x) => !used.has(x.id));
          if (pick) {
            used.add(pick.id);
            image = await libraryToCarousel(c.id, pick.id);
          }
        } else {
          const kind = policy === 'stock-illustration' ? 'illustration' : s.query.kind;
          image = await findImage(c.id, { ...s.query, kind }, used, signal, s.tags);
        }
        if (image) images.push({ pageId: s.pageId, slot: s.slot, image });
        else misses.push(s.query.q);
      } catch (e) {
        if (signal.aborted) throw new CanceledError();
        errors.add(e instanceof Error ? e.message : String(e));
        misses.push(s.query.q);
      }
      progress(++done / slots.length, `画像を${verb} (${done}/${slots.length})`);
    }
  };
  // AI の生成は重いので2つずつ
  await Promise.all(Array.from({ length: Math.min(ai ? 2 : 3, slots.length) }, worker));
  const from = ai ? 'AI で' : policy === 'library' ? '素材ライブラリから' : '素材サイトから';
  const notes = [`${from} ${images.length} 枚の画像を入れました。`];
  if (ai && images.length) notes.push('AI で作った画像です。実写に見える画像を投稿するときは、TikTok の「AI 生成」のラベルを付けてください。');
  if (misses.length) notes.push(`${misses.length} か所は画像を入れられませんでした(${misses.slice(0, 4).join(' / ')}${misses.length > 4 ? ' ほか' : ''})。言葉を変えるか、手元の画像を入れてください。`);
  for (const e of errors) notes.push(e);
  return { images, notes };
}

async function findImage(id: string, q: ImageQuery, used: Set<string>, signal: AbortSignal, tags: string[] = []): Promise<CarouselImage | null> {
  // 見つからなければ、検索語を短くしてもう一度
  const words = q.q.trim().split(/\s+/);
  const tries = [q.q, words.length > 3 ? words.slice(0, 3).join(' ') : null].filter((x): x is string => !!x);
  for (const text of tries) {
    for (const provider of providersFor(q.kind)) {
      const hits = await searchStock(provider, { q: text, kind: q.kind }, signal);
      // 縦長・正方形に近いものを先に(ページの枠は縦長)
      const pick = [...hits].sort((a, b) => Number(a.width > a.height * 1.4) - Number(b.width > b.height * 1.4)).find((h) => !used.has(h.pageUrl));
      if (!pick) continue;
      used.add(pick.pageUrl);
      const img = await fetchStockImage(pick.full, signal);
      return saveAndRegister(id, img.buf, img.ext, {
        name: tags.join(' ').slice(0, 30) || text,
        category: q.kind === 'illustration' ? 'イラスト' : '写真',
        tags: [...tags, ...text.split(/\s+/)],
        source: pick.provider,
        credit: pick.credit,
        pageUrl: pick.pageUrl,
      });
    }
  }
  return null;
}
