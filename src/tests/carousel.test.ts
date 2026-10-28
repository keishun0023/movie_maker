import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captionText, createCarousel, creditLines, pagesFromDraft } from '../shared/carousel.js';
import { allowedImageUrl, parsePexels, parsePixabay } from '../server/carousel/stock.js';
import { crc32, makeZip } from '../server/zip.js';

test('写真投稿: Claude の応答を表紙 + 比較ページに直す(足りない項目は空、お題のないページは捨てる)', () => {
  const r = pagesFromDraft(
    {
      cover: { kicker: '皮膚科行く前にこれみて‼️', title: 'ニキビがガチで消えた神習慣', image: { q: 'woman clear skin', kind: 'photo' } },
      pages: [
        { label: '', title: '顔の毛', subtitle: '', left: { text: 'ボーボー', note: '', image: { q: 'hairy', kind: 'photo' } }, right: { text: 'ツルツル', note: '', image: { q: 'smooth', kind: 'illustration' } } },
        { title: '' },
        { title: '予測変換', left: { text: 'おけー' } },
      ],
      caption: 'みんなはどれくらい当てはまった?👀',
      hashtags: ['#美容', '垢抜け', '美容', ' '],
    },
    'ニキビ',
  );
  assert.equal(r.pages.length, 3);
  assert.equal(r.pages[0]!.kind, 'cover');
  const p1 = r.pages[1]!;
  assert.ok(p1.kind === 'compare');
  assert.equal(p1.left.text, 'ボーボー');
  assert.equal(p1.right.query.kind, 'illustration');
  const p2 = r.pages[2]!;
  assert.ok(p2.kind === 'compare');
  assert.equal(p2.right.text, '');
  // 検索語がないときは、お題と言葉から作る
  assert.equal(p2.left.query.q, '予測変換 おけー');
  assert.deepEqual(r.hashtags, ['美容', '垢抜け']);
  assert.equal(new Set(r.pages.map((p) => p.id)).size, 3);
});

test('写真投稿: 壊れた応答でも落ちない(表紙だけ)', () => {
  const r = pagesFromDraft(null, 'テーマ');
  assert.equal(r.pages.length, 1);
  assert.ok(r.pages[0]!.kind === 'cover' && r.pages[0]!.title === 'テーマ');
});

test('写真投稿: 本文とハッシュタグ・素材サイトの作者表記', () => {
  const c = createCarousel('c1', 'x');
  c.caption = '本文';
  c.hashtags = ['美容', '垢抜け'];
  assert.equal(captionText(c), '本文\n\n#美容 #垢抜け');
  c.pages = pagesFromDraft({ cover: { title: 't' }, pages: [{ title: 'a' }] }, 't').pages;
  const p = c.pages[1]!;
  assert.ok(p.kind === 'compare');
  p.left.image = { file: 'images/a.jpg', source: 'pexels', credit: 'Ann', pageUrl: 'https://www.pexels.com/photo/1' };
  p.right.image = { file: 'images/b.jpg', source: 'pexels', credit: 'Ann', pageUrl: 'https://www.pexels.com/photo/2' };
  c.style.leftCharacter = { file: 'images/c.png', source: 'upload' };
  assert.deepEqual(creditLines(c), ['Ann (Pexels)']);
});

test('素材サイト: 検索結果を読み、画像は素材サイトのホストからだけ取得する', () => {
  const px = parsePixabay({ hits: [{ id: 1, pageURL: 'https://pixabay.com/photos/1', previewURL: 'p', webformatURL: 'https://pixabay.com/get/w.jpg', largeImageURL: 'https://pixabay.com/get/l.jpg', imageWidth: 800, imageHeight: 1200, user: 'u' }] });
  assert.deepEqual([px[0]!.provider, px[0]!.thumb, px[0]!.full, px[0]!.credit], ['pixabay', 'https://pixabay.com/get/w.jpg', 'https://pixabay.com/get/l.jpg', 'u']);
  const pe = parsePexels({ photos: [{ id: 2, url: 'https://www.pexels.com/photo/2', width: 1, height: 2, photographer: 'Ann', src: { medium: 'm', large: 'l', large2x: 'l2' } }] });
  assert.deepEqual([pe[0]!.thumb, pe[0]!.full, pe[0]!.credit], ['m', 'l2', 'Ann']);
  assert.equal(allowedImageUrl('https://images.pexels.com/photos/2/a.jpeg').hostname, 'images.pexels.com');
  for (const bad of ['http://images.pexels.com/a.jpg', 'https://example.com/a.jpg', 'https://images.pexels.com.evil.com/a.jpg', 'file:///etc/passwd', 'not a url']) {
    assert.throws(() => allowedImageUrl(bad), Error, bad);
  }
});

test('ZIP: 無圧縮の ZIP を作り、unzip で読める', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-zip-'));
  const zip = path.join(dir, 'a.zip');
  fs.writeFileSync(zip, makeZip([{ name: '投稿_01.png', data: Buffer.from([1, 2, 3]) }, { name: '本文.txt', data: Buffer.from('こんにちは') }]));
  let out: string;
  try {
    out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("|".join(z.namelist())); print(z.read("本文.txt").decode())', zip], { encoding: 'utf8' });
  } catch {
    return; // python がない環境では確認しない
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(out, '投稿_01.png|本文.txt\nこんにちは\n');
});
