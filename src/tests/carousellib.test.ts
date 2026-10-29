import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);

test('素材ライブラリ: フォルダに置いた画像を分類つきで取り込み、同じ画像は重ねて入れない', async () => {
  // データフォルダは、サーバーのモジュールを読み込む前に決める
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-lib-'));
  process.env.TDM_DATA_DIR = dataDir;
  try {
    const lib = await import('../server/carousel/library.js');
    const { searchLibrary } = await import('../shared/carousel.js');
    const root = lib.libraryDir();
    // Drive などに一括で置いた画像(分類のサブフォルダ・分類なし)
    fs.mkdirSync(path.join(root, '商品'), { recursive: true });
    fs.writeFileSync(path.join(root, '商品', '白玉ビタミンC_箱.png'), png(1));
    fs.writeFileSync(path.join(root, 'メモ.txt'), 'x');
    fs.writeFileSync(path.join(root, 'おまけ.png'), png(2));
    let items = await lib.scanLibrary();
    assert.deepEqual(items.map((x) => [x.name, x.category]).sort(), [['おまけ', 'その他'], ['白玉ビタミンC_箱', '商品']]);
    assert.deepEqual(items.find((x) => x.category === '商品')!.tags, ['白玉ビタミンC', '箱']);
    // 2回目は増えない
    assert.equal((await lib.scanLibrary()).length, 2);

    const a = await lib.addToLibrary(png(3), '.png', { name: 'ダメな子', category: 'キャラクター', tags: ['泣き顔', 'メガネ'], source: 'ai', prompt: 'a girl' });
    assert.ok(fs.existsSync(lib.itemPath(a)) && a.file.startsWith('キャラクター/'));
    const again = await lib.addToLibrary(png(3), '.png', { name: '別名', category: 'その他', source: 'upload' });
    assert.equal(again.id, a.id);

    items = await lib.libraryItems();
    assert.equal(items.length, 3);
    assert.deepEqual(searchLibrary(items, 'メガネ 泣き顔').map((x) => x.name), ['ダメな子']);
    assert.deepEqual(searchLibrary(items, '', '商品').map((x) => x.name), ['白玉ビタミンC_箱']);

    // 分類を変えるとファイルも移る。消すとファイルも消える
    const moved = await lib.updateLibraryItem(a.id, { category: 'イラスト', tags: ['泣き顔'] });
    assert.ok(moved.file.startsWith('イラスト/') && fs.existsSync(lib.itemPath(moved)));
    await lib.removeLibraryItem(a.id);
    assert.ok(!fs.existsSync(lib.itemPath(moved)));
    // フォルダから消した画像は、一覧からも外れる
    fs.rmSync(path.join(root, 'おまけ.png'));
    assert.deepEqual((await lib.libraryItems()).map((x) => x.name), ['白玉ビタミンC_箱']);

    // 企画に入れると、企画のフォルダにコピーされる
    const { newCarousel } = await import('../server/carousel/store.js');
    const c = await newCarousel('テスト');
    const im = await lib.libraryToCarousel(c.id, items.find((x) => x.category === '商品')!.id);
    assert.equal(im.source, 'library');
    assert.ok(fs.existsSync(path.join(dataDir, '写真投稿素材', '企画', c.id, im.file)));

    // フォーマットは、保存するまでは見本を返す
    assert.ok((await lib.listFormats()).some((f) => f.name === 'ドブス/爆美女'));
    const saved = await lib.saveFormats([{ ...lib.DEFAULT_FORMATS[0]!, id: '', name: '自分の型' }]);
    assert.ok(saved[0]!.id);
    assert.deepEqual((await lib.listFormats()).map((f) => f.name), ['自分の型']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ファイル名から名前とタグを作る(番号やハッシュはタグにしない)', async () => {
  const { namesFromFile } = await import('../server/carousel/library.js');
  assert.deepEqual(namesFromFile('キャラクター/泣き顔_メガネ_18e4210f.png'), { name: '泣き顔_メガネ_18e4210f', tags: ['泣き顔', 'メガネ'] });
  assert.deepEqual(namesFromFile('IMG 0012.JPG').tags, ['IMG']);
});

test('フォーマットを企画に当てると、見た目・枚数・画像の方針が入る', async () => {
  const { applyFormat, createCarousel } = await import('../shared/carousel.js');
  const c = createCarousel('c1', 'x');
  const r = applyFormat(c, { id: 'F1', name: '型', heads: 'words', leftWord: 'NG', rightWord: 'OK', background: 'mint', pageCount: 7, instructions: '', imagePolicy: 'ai-anime' }, { leftCharacter: { file: 'images/a.png', source: 'library', libraryId: 'A1' } });
  assert.equal(r.formatId, 'F1');
  assert.equal(r.pageCount, 7);
  assert.equal(r.imagePolicy, 'ai-anime');
  assert.deepEqual([r.style.heads, r.style.leftWord, r.style.background, r.style.leftCharacter?.libraryId], ['words', 'NG', 'mint', 'A1']);
  assert.equal(c.pageCount, 5, '元の企画は変えない');
});

test('AI 画像の指示文: 内容に画風と背景の指定を足す', async () => {
  const { buildPrompt } = await import('../server/carousel/ai.js');
  const p = buildPrompt('a girl with glasses', 'anime', true);
  assert.ok(p.startsWith('a girl with glasses'));
  assert.ok(p.includes('anime') && p.includes('#00FF00'));
  assert.ok(!buildPrompt('x', 'photo', false).includes('#00FF00'));
});
