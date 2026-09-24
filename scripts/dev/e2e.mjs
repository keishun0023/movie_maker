// ブラウザを自動操作して、取り込み → 編集 → 書き出し → 再読み込み までを確認する(開発用)。
// 前提: サーバーが起動済み、Playwright と Chromium が使えること。
// 使い方: node scripts/dev/e2e.mjs <テスト素材フォルダ> <出力フォルダ> [port]
// 文字起こしモデルが使えない環境では、テスト素材の既知の文をトークンとして注入して下流(分割・書き出し)を確認する。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const media = path.resolve(process.argv[2] ?? 'test-media');
const outDir = path.resolve(process.argv[3] ?? 'e2e-out');
const port = process.argv[4] ?? '5199';
const base = `http://127.0.0.1:${port}/`;
fs.mkdirSync(outDir, { recursive: true });
const SR = 48000;
const log = (...a) => console.log('[e2e]', ...a);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
const page = await context.newPage();
page.on('pageerror', (e) => log('PAGE ERROR', e.message));
page.on('console', (m) => m.type() === 'error' && log('console.error', m.text()));

const st = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__tdm.store.state.project)));
const waitFor = async (fn, label, ms = 120000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + label);
    await page.waitForTimeout(300);
  }
};
const clickText = (text) => page.getByRole('button', { name: text, exact: false }).first().click();

// 1. プロジェクト作成
await page.goto(base);
await page.fill('input[type=text]', 'E2Eテスト 動画');
await clickText('作成');
await page.waitForURL(/\?p=/);
await page.waitForSelector('.topbar');
log('project', page.url());

// 2. 素材の取り込み(日本語・空白入りファイル名)
const files = ['ナレーション 音声.m4a', '撮影 動画.mov', '背景 動画.mp4', '横長 写真.png', '縦長 写真.jpg', '差し込み.png', 'BGM 曲.m4a'].map((f) => path.join(media, f));
// Playwright は日本語を含むパスを直接渡すと取り込めないため、内容と名前を渡す
await page.setInputFiles('.dropzone input[type=file]', files.map((f) => ({ name: path.basename(f), mimeType: 'application/octet-stream', buffer: fs.readFileSync(f) })));
await waitFor(() => window.__tdm.store.state.project.assets.length >= 7, 'assets');
await waitFor(() => window.__tdm.store.state.jobs.every((j) => j.status !== 'queued' && j.status !== 'running'), 'preview jobs');
let p = await st();
for (const a of p.assets) log('asset', a.kind, a.name, a.width ? `${a.width}x${a.height}` : '', a.warnings.join(' / '));
const mov = p.assets.find((a) => a.name === '撮影 動画.mov');
if (!(mov.width === 360 && mov.height === 640)) throw new Error('回転メタデータが反映されていません: ' + mov.width + 'x' + mov.height);

// 3. ナレーション設定
await page.selectOption('.right select', { label: 'ナレーション 音声.m4a' });
await clickText('この音声をナレーションにする');
await waitFor(() => !!window.__tdm.store.state.project.narration && !!window.__tdm.store.state.project.timeline, 'narration');
p = await st();
log('narration', (p.narration.durationSamples / SR).toFixed(2), 's → edited', (p.timeline.outSamples / SR).toFixed(2), 's cuts', p.timeline.segments.length - 1);

// 4. 最小の縦断: 手入力テロップ + 単色背景で書き出し
await page.locator('.steps button').nth(2).click();
await page.evaluate(() => window.__tdm.store.setUi({ playhead: 48000 }));
await clickText('再生位置にテロップを追加');
await page.fill('textarea.cap-text', '手入力のテロップ');
await page.locator('.steps button').nth(3).click();
await page.waitForSelector('.checks .ok-box, .checks .warn, .checks .err');
await page.locator('.right button.big', { hasText: '動画を書き出す' }).click();
await waitFor(() => window.__tdm.store.state.jobs.some((j) => j.type === 'export' && j.status === 'done'), 'export1', 300000);
let job = (await page.evaluate(() => window.__tdm.store.state.jobs)).find((j) => j.type === 'export' && j.status === 'done');
log('minimal export', job.result.file, job.result.width + 'x' + job.result.height, job.result.durationSec.toFixed(3) + 's');

// 5. 既知の文をトークンとして注入(ASRモデルが無い環境の代替。実際の認識ではない)
const spans = JSON.parse(fs.readFileSync(path.join(media, 'spans.json'), 'utf8')).spans;
const tokens = [];
spans.forEach((s, si) => {
  // whisper の日本語トークンに近い 1〜2 文字単位
  const chunks = s.text.match(/[^、。]{1,2}[、。]?/g);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  let acc = 0;
  chunks.forEach((c, ci) => {
    const a = s.start + ((s.end - s.start) * acc) / total;
    acc += c.length;
    const b = s.start + ((s.end - s.start) * acc) / total;
    tokens.push({ id: `t${si}-${ci}`, text: c, start: Math.round(a * SR), end: Math.round(b * SR), p: 0.9, seg: si, timing: 'token' });
  });
});
await page.evaluate((tokens) => {
  const s = window.__tdm.store;
  s.commit((p) => ({ ...p, transcript: { engine: 'e2e-injected', model: 'none', createdAt: new Date().toISOString(), basis: 'source', tokens, notes: ['E2Eテスト用に注入した既知の文'] } }));
}, tokens);
await page.locator('.steps button').nth(1).click();
await clickText('テロップ・シーンを作り直す(手動修正は保持)');
p = await st();
log('captions', p.captions.length, 'scenes', p.scenes.length);
for (const c of p.captions) log('  cap', JSON.stringify(c.text));

// 6. 素材の仮配置(選択順)と差し込み画像・BGM
await page.locator('.steps button').nth(2).click();
await page.evaluate(() => window.__tdm.store.setUi({ leftTab: 'assets', leftCollapsed: false }));
for (const name of ['撮影 動画.mov', '横長 写真.png', '背景 動画.mp4', '縦長 写真.jpg']) {
  await page.locator('.asset', { hasText: name }).locator('input[type=checkbox]').check();
}
await page.evaluate(() => window.__tdm.store.setUi({ selection: { kind: 'scene', id: window.__tdm.store.state.project.scenes[0].id } }));
await clickText('選択順にシーンへ仮配置');
p = await st();
await page.evaluate(() => {
  const s = window.__tdm.store;
  const p = s.state.project;
  const inset = p.assets.find((a) => a.name === '差し込み.png');
  const bgm = p.assets.find((a) => a.name === 'BGM 曲.m4a');
  s.commit((pp) => ({
    ...pp,
    scenes: pp.scenes.map((sc, i) => (i === 1 ? { ...sc, inset: { assetId: inset.id, x: 0.5, y: 0.72, width: 0.4, startSec: 0.3, endSec: null } } : i === 2 && sc.bg ? { ...sc, bg: { ...sc.bg, shortMode: 'loop', audio: true, volumeDb: -12 } } : sc)),
    bgm: { assetId: bgm.id, volumeDb: -20, startSec: 0, loop: true, fadeInSec: 0.5, fadeOutSec: 1.5 },
  }));
});
// 個別テロップのフォント・位置変更
p = await st();
const dela = (await page.evaluate(() => window.__tdm.store.state.fonts)).find((f) => f.family.includes('Dela'));
await page.evaluate(({ id, fontId }) => {
  const s = window.__tdm.store;
  s.commit((pp) => ({ ...pp, captions: pp.captions.map((c, i) => (i === 2 ? { ...c, style: { fontId, y: 0.7, color: '#ffe14d' } } : c)) }));
}, { id: p.captions[2].id, fontId: dela.id });
// 共通スタイルの変更(サイズ)
await page.evaluate(() => window.__tdm.store.commit((pp) => ({ ...pp, style: { ...pp.style, size: 80 } })));
await page.waitForTimeout(500);

// 7. プレビューのスクリーンショット(テロップの中央時刻)
p = await st();
const shots = [];
const timings = await page.evaluate(async () => {
  const { captionOutputTimings } = await import('/js/shared/segment.js');
  const s = window.__tdm.store.state.project;
  return captionOutputTimings(s.captions, s.timeline);
});
const sceneRanges = await page.evaluate(async () => {
  const { sceneOutputRanges } = await import('/js/shared/segment.js');
  const s = window.__tdm.store.state.project;
  return sceneOutputRanges(s.scenes, s.timeline);
});
// 各シーンの中央の時刻(テロップの表示中を優先)
const picks = sceneRanges.slice(0, 5).map((r) => {
  const t = timings.find((c) => c.outStart < r.outEnd && c.outEnd > r.outStart);
  return t ? Math.round((Math.max(t.outStart, r.outStart) + Math.min(t.outEnd, r.outEnd)) / 2) : Math.round((r.outStart + r.outEnd) / 2);
});
for (let k = 0; k < picks.length; k++) {
  const mid = picks[k];
  await page.evaluate((mid) => document.dispatchEvent(new CustomEvent('tdm:seek', { detail: mid })), mid);
  await page.waitForTimeout(900);
  const f = path.join(outDir, `preview_${k}.png`);
  await page.locator('.stage').screenshot({ path: f });
  shots.push({ k, sec: mid / SR, file: f });
}
await page.screenshot({ path: path.join(outDir, 'editor.png') });

// 8. 書き出し(キャンセル → 再実行)
await page.locator('.steps button').nth(3).click();
await page.waitForTimeout(800);
await page.locator('.right button.big', { hasText: '動画を書き出す' }).click();
await waitFor(() => window.__tdm.store.state.jobs.some((j) => j.type === 'export' && j.status === 'running'), 'export running');
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'キャンセル' }).first().click();
await waitFor(() => window.__tdm.store.state.jobs.some((j) => j.type === 'export' && j.status === 'canceled'), 'canceled');
log('cancel ok');
const doneBefore = (await page.evaluate(() => window.__tdm.store.state.jobs)).filter((j) => j.type === 'export' && j.status === 'done').length;
await page.locator('.right button.big', { hasText: '動画を書き出す' }).click();
await waitFor((n) => window.__tdm.store.state.jobs.filter((j) => j.type === 'export' && j.status === 'done').length > 1, 'export2', 600000);
job = (await page.evaluate(() => window.__tdm.store.state.jobs)).filter((j) => j.type === 'export' && j.status === 'done').pop();
log('full export', job.result.file, job.result.width + 'x' + job.result.height, job.result.durationSec.toFixed(3) + 's', 'frames', job.result.frames.length);
void doneBefore;
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outDir, 'export-panel.png') });

// 9. 書き出した動画から同じ時刻のフレームを取り出す
const projId = new URL(page.url()).searchParams.get('p');
const exportFile = path.join(process.env.TDM_DATA_DIR, 'projects', projId, 'exports', job.result.file);
fs.copyFileSync(exportFile, path.join(outDir, 'output.mp4'));
for (const s of shots) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', s.sec.toFixed(3), '-i', exportFile, '-frames:v', '1', path.join(outDir, `export_${s.k}.png`)]);
}
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', exportFile]).toString());
const v = probe.streams.find((x) => x.codec_type === 'video');
const a = probe.streams.find((x) => x.codec_type === 'audio');
log('probe', v.codec_name, v.width + 'x' + v.height, v.r_frame_rate, 'frames', v.nb_frames, a.codec_name, a.sample_rate, 'dur', probe.format.duration);
p = await st();
log('timeline out', (p.timeline.outSamples / SR).toFixed(4), 's');

// 10. 再読み込みで復元されるか
await page.evaluate(() => window.__tdm.store.save());
const before = await st();
await page.reload();
await page.waitForSelector('.topbar');
await page.waitForTimeout(800);
const after = await st();
const same = JSON.stringify({ c: before.captions, s: before.scenes, st: before.style, b: before.bgm }) === JSON.stringify({ c: after.captions, s: after.scenes, st: after.style, b: after.bgm });
log('reload restored:', same);
if (!same) throw new Error('再読み込み後に内容が一致しません');

// 11. Undo/Redo
const capsBefore = after.captions.length;
await page.evaluate(() => window.__tdm.store.commit((pp) => ({ ...pp, captions: pp.captions.slice(1) })));
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const undone = (await st()).captions.length;
log('undo', capsBefore, '→', undone);
if (undone !== capsBefore) throw new Error('Undo が効いていません');

fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ export: job.result, probe: { width: v.width, height: v.height, fps: v.r_frame_rate, frames: v.nb_frames, duration: probe.format.duration }, outSec: p.timeline.outSamples / SR }, null, 1));
await browser.close();
log('OK');
