import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSeed, wrapTimeline } from '../server/capcut.js';

test('CapCut: template-2.tmp のように包まれた本体は、同じ包み方で書く', () => {
  const draft = { tracks: [1], id: 'new' };
  assert.deepEqual(wrapTimeline({ tracks: [], id: 'old' }, draft), draft);
  assert.deepEqual(wrapTimeline({ draft_content: { tracks: [], id: 'old' }, other: 1 }, draft), { draft_content: draft, other: 1 });
  const s = wrapTimeline({ payload: JSON.stringify({ tracks: [] }) }, draft) as { payload: string };
  assert.deepEqual(JSON.parse(s.payload), draft);
  assert.equal(wrapTimeline({ draft_id: 'x' }, draft), null);
});

test('CapCut: 見本には CapCut が作った新しい版のプロジェクトを選ぶ', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capstore-'));
  const put = (name: string, file: string, body: unknown) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, file), typeof body === 'string' ? body : JSON.stringify(body));
  };
  put('old', 'draft_info.json', { tracks: [], platform: { app_version: '9.1.0' } });
  put('app', 'draft_info.json', { tracks: [], version: 360000, platform: { app_version: '8.9.1' } });
  put('enc', 'draft_info.json', 'x9fk2...');
  put('notadraft', 'readme.txt', 'hi');
  const r = findSeed(root);
  assert.equal(r.projects, 3);
  assert.equal(r.unreadable, 1);
  // 版の印(version)がある CapCut 製のものを優先する
  assert.equal(path.basename(r.seed!.dir), 'app');
  assert.deepEqual(r.seed!.files, ['draft_info.json']);
  fs.rmSync(root, { recursive: true, force: true });
});
