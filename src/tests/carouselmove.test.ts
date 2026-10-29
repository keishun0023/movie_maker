import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('写真投稿の保存先: 前の版の企画を素材フォルダへ移し、保存先を変えると中身ごと移す', async () => {
  // データフォルダは、サーバーのモジュールを読み込む前に決める
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-move-'));
  process.env.TDM_DATA_DIR = dataDir;
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-drive-'));
  try {
    // 前の版: データフォルダの carousels に企画がある
    const old = path.join(dataDir, 'carousels', 'cold-1');
    fs.mkdirSync(path.join(old, 'images'), { recursive: true });
    fs.writeFileSync(path.join(old, 'carousel.json'), JSON.stringify({ id: 'cold-1', name: '前の企画', pages: [], updatedAt: '2026-01-01' }));
    const store = await import('../server/carousel/store.js');
    const lib = await import('../server/carousel/library.js');
    const list = await store.listCarousels();
    assert.deepEqual(list.map((x) => [x.id, x.name, x.status]), [['cold-1', '前の企画', 'idea']]);
    assert.ok(!fs.existsSync(path.join(dataDir, 'carousels', 'cold-1')), '前の場所からは消える');
    assert.ok(fs.existsSync(path.join(lib.libraryDir(), '企画', 'cold-1', 'carousel.json')));

    // 素材とフォーマットを作ってから、Drive(のつもりのフォルダ)へ移す
    const item = await lib.addToLibrary(PNG, '.png', { name: 'キャラ', category: 'キャラクター', source: 'upload' });
    await lib.saveFormats([{ ...lib.DEFAULT_FORMATS[0]!, name: '自分の型' }]);
    // 移す先に元からある素材も残る(一覧はまとめる)
    const target = path.join(drive, '写真投稿素材');
    fs.mkdirSync(path.join(target, '商品'), { recursive: true });
    fs.writeFileSync(path.join(target, '商品', '箱.png'), Buffer.concat([PNG, Buffer.from([9])]));
    fs.writeFileSync(path.join(target, 'index.json'), JSON.stringify({ items: [] }));
    const before = lib.libraryDir();
    assert.equal(await lib.setLibraryDir(target), target);
    assert.equal(lib.libraryDir(), target);
    assert.ok(!fs.existsSync(path.join(before, 'キャラクター')), '前のフォルダからは移る');
    const items = await lib.libraryItems();
    assert.deepEqual(items.map((x) => x.name).sort(), ['キャラ', '箱']);
    assert.equal(items.find((x) => x.name === 'キャラ')!.id, item.id, '素材のIDはそのまま(企画やフォーマットからの参照が切れない)');
    assert.deepEqual((await lib.listFormats()).map((f) => f.name), ['自分の型']);
    assert.deepEqual((await store.listCarousels()).map((x) => x.id), ['cold-1']);
    // 企画のフォルダの画像は、素材としては取り込まない
    fs.writeFileSync(path.join(target, '企画', 'cold-1', 'images', 'x.png'), PNG);
    assert.equal((await lib.libraryItems()).length, 2);
    // 今のフォルダの中は選べない
    await assert.rejects(() => lib.setLibraryDir(path.join(target, '企画')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(drive, { recursive: true, force: true });
  }
});
