// 音程を変えずに再生速度を変える(WSOLA: 波形の似た位置を探して重ね合わせる方式)。
// 出力の長さはサンプル単位で指定どおりにする(時間対応表と一致させるため)。

const FRAME = 1440; // 30ms @48kHz
const HOP = FRAME / 2;
const TOL = 480; // ±10ms の範囲で似た波形を探す

let hann: Float32Array | null = null;
function window(): Float32Array {
  if (!hann) {
    hann = new Float32Array(FRAME);
    for (let n = 0; n < FRAME; n++) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FRAME);
  }
  return hann;
}

/** 線形補間で長さを合わせる(とても短い区間用。音程はわずかに変わる) */
function resampleLinear(input: Int16Array, ch: number, outFrames: number): Int16Array {
  const inFrames = input.length / ch;
  const out = new Int16Array(outFrames * ch);
  if (inFrames === 0) return out;
  for (let i = 0; i < outFrames; i++) {
    const x = outFrames > 1 ? (i * (inFrames - 1)) / (outFrames - 1) : 0;
    const i0 = Math.floor(x);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const f = x - i0;
    for (let c = 0; c < ch; c++) out[i * ch + c] = Math.round(input[i0 * ch + c]! * (1 - f) + input[i1 * ch + c]! * f);
  }
  return out;
}

/**
 * インターリーブされた PCM を outFrames フレームの長さに伸縮する(音程は保つ)。
 * speed = 入力の長さ / 出力の長さ。
 */
export function timeStretch(input: Int16Array, ch: number, outFrames: number): Int16Array {
  const inFrames = input.length / ch;
  if (outFrames <= 0) return new Int16Array(0);
  if (outFrames === inFrames) return input.slice();
  if (inFrames < FRAME * 2 || outFrames < FRAME * 2) return resampleLinear(input, ch, outFrames);
  const speed = inFrames / outFrames;
  const w = window();
  // 類似度の計算用のモノラル信号
  const mono = new Float32Array(inFrames);
  for (let i = 0; i < inFrames; i++) {
    let v = 0;
    for (let c = 0; c < ch; c++) v += input[i * ch + c]!;
    mono[i] = v / ch;
  }
  const acc = new Float32Array((outFrames + FRAME) * ch);
  const wsum = new Float32Array(outFrames + FRAME);
  const maxPos = inFrames - FRAME;
  const corr = (a: number, b: number, step: number) => {
    let s = 0;
    for (let n = 0; n < HOP; n += step) s += mono[a + n]! * mono[b + n]!;
    return s;
  };
  let prev = 0;
  for (let k = 0; k * HOP < outFrames; k++) {
    const outPos = k * HOP;
    let pos: number;
    if (k === 0) pos = 0;
    else {
      const nominal = Math.round(outPos * speed);
      const target = Math.min(maxPos, prev + HOP); // 前のフレームの自然な続き
      const lo = Math.max(0, Math.min(maxPos, nominal - TOL));
      const hi = Math.max(0, Math.min(maxPos, nominal + TOL));
      // 粗く探してから細かく探す
      let best = Math.max(lo, Math.min(hi, nominal));
      let bestV = -Infinity;
      for (let p = lo; p <= hi; p += 4) {
        const v = corr(p, target, 4);
        if (v > bestV) {
          bestV = v;
          best = p;
        }
      }
      const c0 = best;
      bestV = -Infinity;
      for (let p = Math.max(lo, c0 - 3); p <= Math.min(hi, c0 + 3); p++) {
        const v = corr(p, target, 2);
        if (v > bestV) {
          bestV = v;
          best = p;
        }
      }
      pos = best;
    }
    for (let n = 0; n < FRAME; n++) {
      const o = outPos + n;
      const i = pos + n;
      if (i >= inFrames) break;
      const g = w[n]!;
      wsum[o]! += g;
      for (let c = 0; c < ch; c++) acc[o * ch + c]! += input[i * ch + c]! * g;
    }
    prev = pos;
  }
  const out = new Int16Array(outFrames * ch);
  for (let i = 0; i < outFrames; i++) {
    const ws = wsum[i]!;
    const inv = ws > 0.05 ? 1 / ws : ws > 0 ? 1 : 0;
    for (let c = 0; c < ch; c++) {
      const v = acc[i * ch + c]! * inv;
      out[i * ch + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
    }
  }
  // 先頭は窓の立ち上がりで無音に近いので、入力の先頭をそのまま使う
  for (let i = 0; i < HOP && i < outFrames; i++) {
    const ws = wsum[i]!;
    if (ws > 0.05) continue;
    for (let c = 0; c < ch; c++) out[i * ch + c] = input[i * ch + c]!;
  }
  return out;
}
