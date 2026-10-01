import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignCutsToReference, parseReferenceTable, splitByReference } from '../shared/reference.js';
import { buildCaptions, DEFAULT_SEGMENT_OPTIONS, scenesAtBreaks } from '../shared/segment.js';
import { SR, type Token } from '../shared/types.js';

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

// 文字起こし(1〜3文字のトークン。少し誤認識あり)を作る
function speak(text: string, startSec: number, perChar = 0.12, pauseAfter: number[] = []): Token[] {
  const out: Token[] = [];
  let t = startSec * SR;
  const cs = Array.from(text);
  for (let i = 0; i < cs.length; i += 2) {
    const s = cs.slice(i, i + 2).join('');
    const end = t + perChar * SR * Array.from(s).length;
    out.push({ id: `t${out.length}-${startSec}`, text: s, start: Math.round(t), end: Math.round(end), p: 0.9, seg: 0, timing: 'token' });
    t = end;
    if (pauseAfter.includes(i + 2)) t += 0.4 * SR;
  }
  return out;
}

test('台本の表どおりのカット割り: 行の切れ目を文字起こしの中で見つける', () => {
  const rows = parseReferenceTable(SHEET);
  // 実際の話: 行をつなげて話し、所々誤認識(サナちゃん→さなちゃん、ニアル→にある)
  const said = rows.map((r) => r.line.replace(/\s/g, '')).join('').replace('サナちゃん', 'さなちゃん').replace('ニアル', 'にある');
  const tokens = speak(said, 0.5);
  const split = splitByReference(tokens, rows);
  assert.ok(split);
  assert.equal(split.rowsOf.length, rows.length);
  assert.equal(split.breaks.length, rows.length - 1);
  // 切れ目は、各行の最初の文字の付近(±1トークン)
  let pos = 0;
  const lens = rows.map((r) => Array.from(r.line.replace(/\s/g, '')).length);
  for (let k = 1; k < rows.length; k++) {
    pos += lens[k - 1]!;
    const want = (0.5 + pos * 0.12) * SR;
    assert.ok(Math.abs(split.breaks[k - 1]! - want) <= 0.25 * SR, `行 ${k}: ${split.breaks[k - 1]! / SR} vs ${want / SR}`);
  }
});

test('台本の表どおりのカット割り: 話していない行は前の行と同じカットにする', () => {
  const rows = parseReferenceTable('朝起きたら顔パンパン\t顔\nこの行は話していません全然違う\t店舗\nむくみにはこれが最強だった\t商品');
  const tokens = speak('朝起きたら顔パンパンむくみにはこれが最強だった', 0);
  const split = splitByReference(tokens, rows);
  assert.ok(split);
  assert.deepEqual(split.rowsOf, [[0, 1], [2]]);
});

test('テロップは表の行の切れ目で必ず区切られ、カットも行ごとになる', () => {
  const rows = parseReferenceTable('いろんなサプリ飲んできたけど\t店舗\n愛用しているのを見て飲んでみたら\t商品\nむくみにはこれが最強だった\t商品');
  const tokens = speak(rows.map((r) => r.line).join(''), 0.3);
  const split = splitByReference(tokens, rows)!;
  const dur = 10 * SR;
  const caps = buildCaptions(tokens, null, { ...DEFAULT_SEGMENT_OPTIONS, charsPerLine: 30, breaksAt: split.breaks });
  // どのテロップも切れ目をまたがない
  for (const b of split.breaks) assert.ok(caps.every((c) => !(c.srcStart < b - 1 && c.srcEnd > b + 1)), `切れ目 ${b / SR}s をまたぐテロップがある`);
  const scenes = scenesAtBreaks(caps, split.breaks, dur);
  assert.equal(scenes.length, 3);
  assert.equal(scenes[0]!.srcStart, 0);
  assert.equal(scenes[2]!.srcEnd, dur);
});
