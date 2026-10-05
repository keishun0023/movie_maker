import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emphasisOf, tempoSpeeds } from '../shared/tempo.js';

const texts = ['これ飲んで黄色人種卒業した', '今まで何やっても', 'くすみ消えなくて', '肌も黄ばみまくってたんだけど', 'ビタミンC 10倍配合！', '個包装だから持ち運びしやすいし', '今すぐチェックしてみて'];
const durs = texts.map(() => 1.5);

test('緩急(台本から): 大事な所はゆっくり、つなぎは速く。最大・最低の範囲に収まる', () => {
  const v = tempoSpeeds(texts, durs, { mode: 'script', max: 1.4, min: 1.0 });
  assert.equal(v.length, texts.length);
  for (const x of v) assert.ok(x >= 1.0 && x <= 1.4, String(x));
  // 「今まで何やっても」「〜だけど」のようなつなぎより、数字・「！」の所と最後の呼びかけの方が遅い
  assert.ok(v[4]! < v[3]!, v.join(','));
  assert.ok(v[6]! < v[5]!, v.join(','));
  // 速い所と遅い所の両方がある(一律ではない)
  assert.ok(Math.max(...v) - Math.min(...v) >= 0.2, v.join(','));
  // 隣のカットの差は 0.25 倍まで
  for (let i = 1; i < v.length; i++) assert.ok(Math.abs(v[i]! - v[i - 1]!) <= 0.25 + 1e-9, v.join(','));
  assert.ok(emphasisOf('今すぐチェック！', 6, 7) > emphasisOf('飲んでたんだけど', 3, 7));
});

test('緩急(波・ときどき速く): 速い所と遅い所が交互に来る。なしは等速', () => {
  const many = Array.from({ length: 12 }, () => 'テキスト');
  const w = tempoSpeeds(many, many.map(() => 1.5), { mode: 'wave', max: 1.3, min: 1.0 });
  assert.ok(Math.max(...w) >= 1.25 && Math.min(...w) <= 1.05, w.join(','));
  const p = tempoSpeeds(many, many.map(() => 1.5), { mode: 'pulse', max: 1.3, min: 1.0 });
  assert.equal(p.filter((x) => x === 1.3).length, 4);
  assert.deepEqual(tempoSpeeds(many, many.map(() => 1.5), { mode: 'off', max: 1.3, min: 1.0 }), many.map(() => 1));
});
