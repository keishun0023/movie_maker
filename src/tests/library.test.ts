import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-lib-'));
process.env.TDM_DATA_DIR = dataDir;
const lib = await import('../server/library.js');
const { sub } = await import('../server/store.js');
const { listCapcutMedia, exportCapcut } = await import('../server/capcut.js');
const { createProject } = await import('../shared/project.js');
import type { JobContext } from '../server/jobs.js';
import type { Project } from '../shared/types.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm-libsrc-'));
const png = path.join(work, '写真.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=400x300', '-frames:v', '1', png]);

function fakeUpload(file: string, name: string): IncomingMessage {
  const r = Readable.from([fs.readFileSync(file)]) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = { 'x-filename': encodeURIComponent(name) };
  return r;
}

test('素材ライブラリ: 同じファイルを2回取り込んでも、保存は1回だけ', async () => {
  const a = await lib.uploadToLibrary(fakeUpload(png, '写真.png'));
  assert.equal(a.existing, false);
  assert.equal(a.asset.kind, 'image');
  assert.ok(a.asset.library);
  const b = await lib.uploadToLibrary(fakeUpload(png, 'コピー.png'));
  assert.equal(b.existing, true);
  assert.equal(b.asset.id, a.asset.id);
  const files = fs.readdirSync(path.join(dataDir, 'library', 'files'));
  assert.equal(files.length, 1);
  // どのプロジェクトからも、ライブラリのファイルの場所を使える
  assert.equal(sub('p20261002-anyproj', a.asset.file), a.asset.file);
  // ライブラリにない外のファイルは使えない
  assert.throws(() => sub('p20261002-anyproj', '/etc/passwd'));
});

test('素材ライブラリ: 元の場所のファイルをコピーせずに加える', async () => {
  const r = await lib.linkToLibrary([png]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.asset.file, png);
  assert.ok(r[0]!.asset.linked);
  assert.equal(sub('p20261002-anyproj', png), png);
  // 消しても元のファイルは残る
  await lib.removeFromLibrary(r[0]!.asset.id);
  assert.ok(fs.existsSync(png));
  assert.throws(() => sub('p20261002-anyproj', png));
});

test('CapCut の素材の一覧と、CapCut への書き出しで素材を下書きの中に置く', async () => {
  const drafts = path.join(work, 'drafts');
  const d1 = path.join(drafts, 'P1');
  fs.mkdirSync(d1, { recursive: true });
  fs.writeFileSync(path.join(d1, 'draft_info.json'), JSON.stringify({ tracks: [], version: 360000, platform: { app_version: '8.9.1' }, materials: { videos: [{ id: 'v', path: png }] } }));
  fs.writeFileSync(path.join(d1, 'draft_meta_info.json'), JSON.stringify({ draft_materials: [{ type: 0, value: [{ file_Path: png }, { file_Path: '/nai/file.mp4' }] }] }));
  const media = listCapcutMedia(drafts);
  assert.deepEqual(media.map((m) => [m.file, m.drafts]), [[png, ['P1']]]);

  const linked = (await lib.linkToLibrary([png]))[0]!.asset;
  const p0 = createProject('p20261002-libtest', 'ライブラリ');
  const SR = 48000;
  const p: Project = {
    ...p0,
    narration: { assetId: 'n', audioIndex: 0, durationSamples: SR, sourceKey: 'k', preparedAt: '', warnings: [] },
    assets: [linked],
    scenes: [{ id: 's', srcStart: 0, srcEnd: SR, bg: { assetId: linked.id, fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0, startSec: 0, shortMode: 'freeze', mode: 'independent', audio: false, volumeDb: 0, kenBurns: false }, inset: null }],
  };
  // ナレーションの音声(書き出しで使う)
  const { writeWav } = await import('../server/media.js');
  fs.mkdirSync(sub(p.id, 'work'), { recursive: true });
  await writeWav(sub(p.id, 'work', 'source-k.wav'), { sampleRate: SR, channels: 2, data: new Int16Array(SR * 2) });
  const ctx = { signal: new AbortController().signal, progress: () => undefined } as unknown as JobContext;
  const r = await exportCapcut(p, drafts, ctx);
  const out = JSON.parse(fs.readFileSync(path.join(r.draftDir, 'draft_info.json'), 'utf8'));
  const photo = out.materials.videos.find((m: { type: string }) => m.type === 'photo');
  // CapCut が読めるよう、素材は下書きの中に置く(Mac ではクローンなので容量はほとんど増えない)。拡張子は実際の形式(PNG)
  assert.ok(photo.path.startsWith(r.draftDir + path.sep), photo.path);
  assert.ok(fs.existsSync(photo.path));
  assert.equal(path.extname(photo.path), '.png');
});
