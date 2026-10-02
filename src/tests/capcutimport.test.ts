import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// データの保存先をテスト用の一時フォルダにする(設定の読み込み前に)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-data-'));
process.env.TDM_DATA_DIR = dataDir;
const { parseDraft, readDraftTimeline, renderDraftAudio, exportCapcutInto, listCapcutDrafts, textOfContent } = await import('../server/capcut.js');
const { readWav, writeWav } = await import('../server/media.js');
const { createProject, autoEdit } = await import('../shared/project.js');
const { SR } = await import('../shared/types.js');
import type { JobContext } from '../server/jobs.js';
import type { Project } from '../shared/types.js';

const ctx = { signal: new AbortController().signal, progress: () => undefined } as unknown as JobContext;
const US = 1_000_000;

/** CapCut が書くような下書きを作る(音声 2 区間・テロップ 2 つ) */
async function makeDraft(root: string): Promise<string> {
  const dir = path.join(root, 'ナレーション編集');
  fs.mkdirSync(dir, { recursive: true });
  // 0〜1s は 300Hz、1〜2s は 600Hz の音
  const n = 2 * SR;
  const data = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const f = i < SR ? 300 : 600;
    const v = Math.round(8000 * Math.sin((2 * Math.PI * f * i) / SR));
    data[i * 2] = v;
    data[i * 2 + 1] = v;
  }
  await writeWav(path.join(dir, 'narr.wav'), { sampleRate: SR, channels: 2, data });
  const draft = {
    id: 'DRAFT-1',
    name: 'ナレーション編集',
    version: 360000,
    platform: { app_version: '8.9.1' },
    canvas_config: { width: 1080, height: 1920, ratio: 'original' },
    duration: 750_000,
    fps: 30,
    materials: {
      audios: [{ id: 'au1', path: '##_draftpath_placeholder_0E68-AB_##/narr.wav', type: 'extract_music' }],
      texts: [
        { id: 'tx1', content: JSON.stringify({ styles: [], text: 'こんにちは' }) },
        { id: 'tx2', content: '<font id="" path=""><color=(1,1,1,1)><size=15>[せかい]</size></color></font>' },
      ],
      videos: [],
    },
    tracks: [
      {
        type: 'audio',
        segments: [
          // 元の 0〜0.5s を 0〜0.5s に
          { material_id: 'au1', source_timerange: { start: 0, duration: 0.5 * US }, target_timerange: { start: 0, duration: 0.5 * US }, volume: 1 },
          // 元の 1.0〜1.5s を 2倍速で 0.5〜0.75s に
          { material_id: 'au1', source_timerange: { start: 1 * US, duration: 0.5 * US }, target_timerange: { start: 0.5 * US, duration: 0.25 * US }, speed: 2, volume: 1 },
        ],
      },
      {
        type: 'text',
        segments: [
          { material_id: 'tx1', target_timerange: { start: 0, duration: 0.5 * US } },
          { material_id: 'tx2', target_timerange: { start: 0.5 * US, duration: 0.25 * US } },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'draft_info.json'), JSON.stringify(draft));
  fs.writeFileSync(path.join(dir, 'draft_meta_info.json'), JSON.stringify({ draft_id: 'DRAFT-1', draft_name: 'ナレーション編集', draft_materials: [{ type: 0, value: [{ id: 'm-old', file_Path: 'narr.wav' }] }] }));
  fs.writeFileSync(path.join(root, 'root_meta_info.json'), JSON.stringify({ all_draft_store: [{ draft_id: 'DRAFT-1', draft_fold_path: dir, draft_name: 'ナレーション編集' }] }));
  return dir;
}

test('CapCut の文字素材から文字を取り出す(新旧の形式)', () => {
  assert.equal(textOfContent(JSON.stringify({ text: 'あいう' })), 'あいう');
  assert.equal(textOfContent('<font id=""><size=15>[えお]</size></font>'), 'えお');
  assert.equal(textOfContent('かき'), 'かき');
});

test('CapCut の下書きから、音声の区間とテロップを読み、音声を1本にする', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capimp-'));
  const dir = await makeDraft(root);
  const list = listCapcutDrafts(root);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.captions, 2);
  const t = readDraftTimeline(dir)!;
  const d = parseDraft(t.draft, dir);
  assert.deepEqual(d.captions.map((c) => c.text), ['こんにちは', 'せかい']);
  assert.equal(d.audio.length, 2);
  assert.equal(d.audio[0]!.file, path.join(dir, 'narr.wav'));
  assert.equal(d.durationUs, 0.75 * US);
  const out = path.join(root, 'out.wav');
  await renderDraftAudio(d, out, ctx);
  const pcm = await readWav(out);
  assert.equal(pcm.data.length / 2, Math.round(0.75 * SR));
  // 0.5s より前は 300Hz、後ろは(元の 1s 以降の)600Hz を音程そのままで速めたもの: ゼロ交差の数で確かめる
  const zc = (a: number, b: number) => {
    let c = 0;
    for (let i = Math.round(a * SR) + 1; i < Math.round(b * SR); i++) if ((pcm.data[(i - 1) * 2]! < 0) !== (pcm.data[i * 2]! < 0)) c++;
    return c / (b - a) / 2;
  };
  assert.ok(Math.abs(zc(0.05, 0.45) - 300) < 20, `前半 ${zc(0.05, 0.45)}Hz`);
  assert.ok(Math.abs(zc(0.55, 0.7) - 600) < 40, `後半 ${zc(0.55, 0.7)}Hz`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CapCut の下書きに素材を加えた複製を作る(元の下書きは変えない)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capimp-'));
  const dir = await makeDraft(root);
  const before = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  // 素材の画像をプロジェクトに置く
  const p0 = createProject('p20261002-cap0001', 'テスト');
  const assetsDir = path.join(dataDir, 'projects', p0.id, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', path.join(assetsDir, 'img.png')]);
  const durationSamples = Math.round(0.75 * SR);
  const p: Project = {
    ...p0,
    narration: { assetId: 'n1', audioIndex: 0, durationSamples, sourceKey: 'k', preparedAt: '', warnings: [] },
    capcut: { dir, name: 'ナレーション編集', draftId: 'DRAFT-1', mtime: readDraftTimeline(dir)!.mtime, importedAt: '' },
    assets: [{ id: 'img', kind: 'image', name: 'img.png', file: 'assets/img.png', size: 1, hash: 'x', importedAt: '', status: 'ok', warnings: [], width: 320, height: 240 }],
    captions: [
      { id: 'c1', srcStart: 0, srcEnd: Math.round(0.5 * SR), tokenIds: [], rawText: 'こんにちは', text: 'こんにちは', textEdited: true, timingEdited: true },
      { id: 'c2', srcStart: Math.round(0.5 * SR), srcEnd: durationSamples, tokenIds: [], rawText: 'せかい', text: 'せかい', textEdited: true, timingEdited: true },
    ],
    scenes: [
      { id: 's1', srcStart: 0, srcEnd: Math.round(0.5 * SR), bg: { assetId: 'img', fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0, startSec: 0, shortMode: 'freeze', mode: 'independent', audio: false, volumeDb: 0, kenBurns: false }, inset: null },
      { id: 's2', srcStart: Math.round(0.5 * SR), srcEnd: durationSamples, bg: null, inset: null },
    ],
  };
  const r = await exportCapcutInto(p, root, ctx);
  assert.equal(r.draftName, 'ナレーション編集 素材入り');
  // 元の下書きはそのまま
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'), before);
  const out = JSON.parse(fs.readFileSync(path.join(r.draftDir, 'draft_info.json'), 'utf8'));
  assert.notEqual(out.id, 'DRAFT-1');
  // 元の音声・テロップのトラックは残り、素材の映像トラックが加わる
  assert.deepEqual(out.tracks.map((t: { type: string }) => t.type), ['video', 'audio', 'text']);
  assert.equal(out.tracks[0].segments.length, 1);
  assert.equal(out.tracks[0].segments[0].target_timerange.start, 0);
  assert.ok(out.materials.audios.some((m: { id: string }) => m.id === 'au1'));
  assert.ok(out.materials.videos.some((m: { type: string }) => m.type === 'photo'));
  // 素材のファイルは複製した下書きの中にコピーされ、一覧に登録される
  const meta = JSON.parse(fs.readFileSync(path.join(r.draftDir, 'draft_meta_info.json'), 'utf8'));
  assert.equal(meta.draft_materials[0].value.length, 2);
  assert.equal(meta.draft_fold_path, r.draftDir);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'root_meta_info.json'), 'utf8'));
  assert.equal(index.all_draft_store.length, 2);
  assert.equal(index.all_draft_store[0].draft_name, 'ナレーション編集 素材入り');
  void autoEdit;
  fs.rmSync(root, { recursive: true, force: true });
});
