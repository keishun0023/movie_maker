import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignCutsToReference, parseReferenceTable } from '../shared/reference.js';

// スプレッドシートからコピーした形(タブ区切り。セル内改行はダブルクォートで囲まれる)
const SHEET = [
  '「むくみ対策にはこれ」\tサナ',
  '"TWICEサナちゃんが愛用している\nむくみタブレット"\t"サナ\n手に大量に出している"',
  '朝起きたら顔パンパン民で\t顔',
  'いろんなサプリ飲んできたけど、\t店舗',
  '"TWICEサナちゃんが\n愛用しているのを見て飲んでみたら"\t"サナ\n商品"',
  'むくみにはこれが最強だった\t商品',
  '血行を良くして、\t"水分を排出しているような動画\n※背景は飲んでいる"',
  '塩分や水分の排出をサポートしてくれるの\t"水分を排出しているような動画\n※背景は飲んでいる"',
  '個包装だから持ち運びしやすいし\t商品アップ',
  '何より美味しいからご飯の後いつも飲んでる\t飲んでいる',
  'ニアルはここから見てみて\t',
].join('\n');

test('素材の指定: スプレッドシートからの貼り付け(セル内改行あり)を読む', () => {
  const rows = parseReferenceTable(SHEET);
  assert.equal(rows.length, 11);
  assert.deepEqual(rows[1], { line: 'TWICEサナちゃんが愛用している むくみタブレット', hint: 'サナ 手に大量に出している' });
  assert.equal(rows[6]!.hint, '水分を排出しているような動画 ※背景は飲んでいる');
  assert.deepEqual(rows[10], { line: 'ニアルはここから見てみて', hint: '' });
});

test('素材の指定: 短く区切ったカットを、台本の行へ順番どおりに対応づける', () => {
  const rows = parseReferenceTable(SHEET);
  // 文字起こしは台本と表記が少し違うことがある(ツイス / 顔パンパン など)
  const cuts = [
    'むくみ対策には', 'これ', 'TWICEサナちゃんが', '愛用している', 'むくみタブレット',
    '朝起きたら', '顔パンパン民で', 'いろんなサプリ', '飲んできたけど',
    'サナちゃんが愛用', 'してるのを見て', '飲んでみたら', 'むくみには', 'これが最強だった',
    '血行を良くして', '塩分や水分の排出を', 'サポートしてくれるの', '個包装だから', '持ち運びしやすいし',
    '何より美味しいから', 'ご飯の後いつも飲んでる', 'ニアルはここから', '見てみて',
  ];
  const idx = alignCutsToReference(cuts, rows);
  const hint = (i: number) => (idx[i]! >= 0 ? rows[idx[i]!]!.hint : '-');
  assert.equal(hint(0), 'サナ');
  assert.equal(hint(3), 'サナ 手に大量に出している');
  assert.equal(hint(6), '顔');
  assert.equal(hint(8), '店舗');
  assert.equal(hint(10), 'サナ 商品');
  assert.equal(hint(13), '商品');
  assert.equal(hint(15), '水分を排出しているような動画 ※背景は飲んでいる');
  assert.equal(hint(18), '商品アップ');
  assert.equal(hint(20), '飲んでいる');
  assert.equal(idx[22], 10);
  // 順番が戻らない
  for (let i = 1; i < idx.length; i++) if (idx[i]! >= 0 && idx[i - 1]! >= 0) assert.ok(idx[i]! >= idx[i - 1]!);
});
