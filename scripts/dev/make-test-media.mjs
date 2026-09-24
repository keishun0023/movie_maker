// 動作確認用のテスト素材を作る(開発用)。本物の発話の代わりに、音節状に揺れる倍音の塊を使う。
// 使い方: node scripts/dev/make-test-media.mjs <出力フォルダ>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const out = process.argv[2] ?? 'test-media';
fs.mkdirSync(out, { recursive: true });
const SR = 48000;
// [文, 直後の間(秒)]
export const PHRASES = [
  ['今日はみなさんにとっておきの節約術を紹介します。', 0.9],
  ['まず一つ目はコンビニで買い物をしないこと。', 0.45],
  ['なぜならついで買いが増えてしまうからです。', 1.4],
  ['二つ目は固定費の見直しです。', 0.2],
  ['スマホのプランを変えるだけで月に3000円安くなります。', 0.7],
  ['三つ目は、', 0.15],
  ['買う前に一日待つこと。', 1.1],
  ['本当に必要なものかどうか冷静に考えられます。', 0.5],
  ['最後に家計簿アプリで支出を見える化しましょう。', 0.8],
  ['以上、今日から始められる節約術でした。', 1.0],
];
const lead = 0.8;
let t = lead;
const spans = [];
for (const [text, gap] of PHRASES) {
  const d = Array.from(text).length * 0.13;
  spans.push({ text, start: t, end: t + d });
  t += d + gap;
}
const total = t + 0.6;
const n = Math.round(total * SR);
const pcm = new Int16Array(n);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
for (let i = 0; i < n; i++) pcm[i] = Math.round(rnd() * 25); // 小さな雑音床
for (const s of spans) {
  const a = Math.round(s.start * SR), b = Math.round(s.end * SR);
  const f0 = 140 + Math.random() * 60;
  for (let i = a; i < b; i++) {
    const x = (i - a) / SR;
    const env = Math.min(1, x / 0.02, (b - i) / SR / 0.03) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 5.5 * x) ** 2);
    let v = 0;
    for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * f0 * k * x + k) / k;
    pcm[i] += Math.round(v * env * 6000);
  }
}
function wav(file, data, ch = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.byteLength, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2 * ch, 28); h.writeUInt16LE(2 * ch, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.byteLength, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(data.buffer)]));
}
const tmpWav = path.join(out, 'narration.wav');
wav(tmpWav, pcm);
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
ff(['-i', tmpWav, '-ar', '44100', '-c:a', 'aac', '-b:a', '160k', path.join(out, 'ナレーション 音声.m4a')]);
// ナレーション入りの回転メタデータ付きMOV(横長で記録し90度回転 → 縦表示)
ff(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${total.toFixed(2)}`, '-i', tmpWav, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(out, 'tmp.mov')]);
ff(['-display_rotation:v:0', '90', '-i', path.join(out, 'tmp.mov'), '-c', 'copy', path.join(out, '撮影 動画.mov')]);
fs.rmSync(path.join(out, 'tmp.mov'));
// 背景用の短い動画(可変フレームレート風: 24fps)
ff(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=24:d=3', '-f', 'lavfi', '-i', 'sine=f=660:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(out, '背景 動画.mp4')]);
// 画像
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', path.join(out, '横長 写真.png')]);
ff(['-f', 'lavfi', '-i', 'mandelbrot=s=1080x1350', '-frames:v', '1', path.join(out, '縦長 写真.jpg')]);
ff(['-f', 'lavfi', '-i', 'color=c=orange:s=600x600', '-vf', "drawbox=x=100:y=100:w=400:h=400:color=blue:t=fill", '-frames:v', '1', path.join(out, '差し込み.png')]);
// BGM
ff(['-f', 'lavfi', '-i', 'sine=f=330:d=12', '-f', 'lavfi', '-i', 'sine=f=495:d=12', '-filter_complex', 'amix=inputs=2,volume=0.5', '-c:a', 'aac', path.join(out, 'BGM 曲.m4a')]);
fs.writeFileSync(path.join(out, 'spans.json'), JSON.stringify({ lead, total, spans }, null, 1));
console.log('作成しました:', out, `(${total.toFixed(2)}秒)`);
