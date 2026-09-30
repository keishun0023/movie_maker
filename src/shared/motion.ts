// カット内の背景の動き(ズーム・パン・揺れなど)。
// 動きは「拡大率 s」「横ずれ dx」「縦ずれ dy」(出力画面のpx)の式で表し、
// 同じ式の文字列をプレビュー(JavaScript)と書き出し(FFmpeg の式)の両方で評価する。
// 端に黒い余白が出ないよう、ずれは常に拡大で生まれた余白 (s-1)*W/2 の内側に収める。
import type { BgPlacement, Motion, MotionType, Scene } from './types.js';

export type { Motion, MotionType };

export const MOTION_LABELS: Record<MotionType, string> = {
  none: 'なし',
  zoomIn: 'ゆっくりズームイン',
  zoomOut: 'ゆっくりズームアウト',
  panLeft: '左へパン',
  panRight: '右へパン',
  panUp: '上へパン',
  panDown: '下へパン',
  punchIn: 'パンチイン(頭でグッと寄る)',
  impact: 'インパクト(寄りから戻る)',
  shake: '揺れ(手持ち風)',
};

export interface MotionExprs {
  /** 変数 T(カット開始からの秒)だけを使う式 */
  s: string;
  dx: string;
  dy: string;
}

const f = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

/** 動きの式を作る。D はカットの長さ(秒)、W/H は出力サイズ */
export function motionExprs(m: Motion | null | undefined, D: number, W: number, H: number): MotionExprs | null {
  if (!m || m.type === 'none') return null;
  const k = Math.max(0.3, Math.min(2, m.strength || 1));
  const dur = Math.max(0.1, D);
  const P = `min(1,max(0,T/${f(dur)}))`;
  const panAmp = (s: number, size: number) => ((s - 1) * size) / 2 * 0.9;
  switch (m.type) {
    case 'zoomIn':
      return { s: `1+${f(0.1 * k)}*${P}`, dx: '0', dy: '0' };
    case 'zoomOut':
      return { s: `1+${f(0.1 * k)}*(1-${P})`, dx: '0', dy: '0' };
    case 'panLeft':
    case 'panRight':
    case 'panUp':
    case 'panDown': {
      const s = 1 + 0.08 * k;
      const horiz = m.type === 'panLeft' || m.type === 'panRight';
      const a = panAmp(s, horiz ? W : H);
      // 画面の中身が進む向きに動く(左へパン = 中身が左へ流れる)
      const sign = m.type === 'panLeft' || m.type === 'panUp' ? 1 : -1;
      const e = `${f(sign * a)}*(1-2*${P})`;
      return { s: f(s), dx: horiz ? e : '0', dy: horiz ? '0' : e };
    }
    case 'punchIn':
      // 0.1秒ほどで寄って、そのあと少しだけ寄り続ける
      return { s: `1+${f(0.14 * k)}*(1-exp(-T/0.07))+${f(0.03 * k)}*${P}`, dx: '0', dy: '0' };
    case 'impact':
      // 大きく寄った状態から素早く戻り、少しだけ寄った状態で落ち着く
      return { s: `1+${f(0.04 * k)}+${f(0.16 * k)}*exp(-T/0.12)`, dx: '0', dy: '0' };
    case 'shake': {
      const s = 1 + 0.05 * k;
      const ax = panAmp(s, W) * 0.85;
      const ay = panAmp(s, H) * 0.35;
      return {
        s: f(s),
        dx: `${f(ax)}*(0.6*sin(2*PI*5.3*T)+0.4*sin(2*PI*11.7*T+1.3))`,
        dy: `${f(ay)}*(0.6*sin(2*PI*4.1*T+0.7)+0.4*sin(2*PI*9.3*T+2.1))`,
      };
    }
    default:
      return null;
  }
}

/**
 * 式を評価する関数にする。eval / new Function は使わず(画面のセキュリティ設定で禁止されているため)、
 * 数字・T・四則演算・括弧・min/max/sin/exp・PI だけの小さな構文解析で読む。
 */
type Node = (T: number) => number;
const cache = new Map<string, Node>();
const FUNCS: Record<string, (...a: number[]) => number> = { min: Math.min, max: Math.max, sin: Math.sin, exp: Math.exp };

export function compileExpr(expr: string): Node {
  const hit = cache.get(expr);
  if (hit) return hit;
  const src = expr.replace(/\s+/g, '');
  let i = 0;
  const fail = (): never => {
    throw new Error(`motion expression parse error at ${i}: ${expr}`);
  };
  const peek = () => src[i];
  const parseExpr = (): Node => {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const l = left;
      const r = parseTerm();
      left = op === '+' ? (T) => l(T) + r(T) : (T) => l(T) - r(T);
    }
    return left;
  };
  const parseTerm = (): Node => {
    let left = parseUnary();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const l = left;
      const r = parseUnary();
      left = op === '*' ? (T) => l(T) * r(T) : (T) => l(T) / r(T);
    }
    return left;
  };
  const parseUnary = (): Node => {
    if (peek() === '-') {
      i++;
      const v = parseUnary();
      return (T) => -v(T);
    }
    return parseAtom();
  };
  const parseAtom = (): Node => {
    const c = peek();
    if (c === '(') {
      i++;
      const v = parseExpr();
      if (src[i++] !== ')') fail();
      return v;
    }
    const num = /^\d+(\.\d+)?(e-?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      const v = Number(num[0]);
      return () => v;
    }
    const id = /^[A-Za-z]+/.exec(src.slice(i));
    if (!id) return fail();
    i += id[0].length;
    const name = id[0];
    if (name === 'T') return (T) => T;
    if (name === 'PI') return () => Math.PI;
    const fn = FUNCS[name];
    if (!fn || src[i++] !== '(') return fail();
    const args: Node[] = [parseExpr()];
    while (peek() === ',') {
      i++;
      args.push(parseExpr());
    }
    if (src[i++] !== ')') fail();
    return (T) => fn(...args.map((a) => a(T)));
  };
  const node = parseExpr();
  if (i !== src.length) fail();
  cache.set(expr, node);
  return node;
}

export interface MotionFrame {
  s: number;
  dx: number;
  dy: number;
}

export function evalMotion(ex: MotionExprs, T: number): MotionFrame {
  return { s: compileExpr(ex.s)(T), dx: compileExpr(ex.dx)(T), dy: compileExpr(ex.dy)(T) };
}

/** FFmpeg 用: T をフレーム番号から計算した秒に置き換える */
export function toFfmpegExpr(expr: string, fps: number): string {
  return expr.replace(/\bT\b/g, `(n/${fps})`);
}

/** 古い「ゆっくりズーム」設定を動きに読み替える */
export function motionOf(bg: BgPlacement | null | undefined): Motion | null {
  if (!bg) return null;
  if (bg.motion) return bg.motion;
  if (bg.kenBurns) return { type: 'zoomIn', strength: 0.8 };
  return null;
}

const CALM: MotionType[] = ['zoomIn', 'panRight', 'zoomOut', 'panLeft', 'panUp', 'zoomIn', 'panDown'];
const STRONG: MotionType[] = ['punchIn', 'impact', 'shake'];

/**
 * おまかせで各カットに動きを割り振る。
 * 連続するカットで同じ動きにならないようにし、「！」「？」のあるカットや話の頭は強めの動きにする。
 */
export function autoMotions(scenes: Scene[], textOf: (s: Scene) => string, strength = 1): Motion[] {
  const out: Motion[] = [];
  let calmI = 0;
  let strongI = 0;
  scenes.forEach((s, i) => {
    const text = textOf(s);
    const emphatic = /[！!？?]/.test(text) || i === 0;
    let type: MotionType;
    if (emphatic) {
      type = STRONG[strongI++ % STRONG.length]!;
    } else {
      type = CALM[calmI++ % CALM.length]!;
    }
    if (out[i - 1]?.type === type) type = emphatic ? STRONG[strongI++ % STRONG.length]! : CALM[calmI++ % CALM.length]!;
    // 揺れは強すぎると見づらいので控えめに
    out.push({ type, strength: type === 'shake' ? strength * 0.7 : strength });
  });
  return out;
}
