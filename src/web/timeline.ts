// 下部のタイムライン: 波形・カット位置・シーン・テロップの区間。
import { SR, type Project } from '../shared/types.js';
import { captionOutputTimings, sceneOutputRanges } from '../shared/segment.js';
import { cutPoints, formatTime, outToSrc, srcToOut } from '../shared/timemap.js';
import { decideCuts } from '../shared/silence.js';
import { timelineOf } from '../shared/project.js';
import { h } from './dom.js';
import { store } from './state.js';
import { moveCaptionJoint, toggleKeepCandidate } from './actions.js';

const TRACK = { ruler: 18, wave: 64, scenes: 30, caps: 30 };
const COLORS = ['#3b6ea8', '#6a4fa3', '#2f8a6d', '#a3643a', '#8a3b5c', '#4f7f2f'];

type DragKind = { type: 'scene-boundary'; index: number } | { type: 'cap-start' | 'cap-end'; id: string } | { type: 'cap-joint'; a: string; b: string } | { type: 'seek' } | null;

export class TimelineView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private scroller: HTMLElement;
  private inner: HTMLElement;
  private pxPerSec = 60;
  private fitMode = true;
  private drag: DragKind = null;
  private hover: string | null = null;
  onSeek: ((t: number) => void) | null = null;

  constructor() {
    this.canvas = h('canvas', { class: 'tl-canvas' });
    this.inner = h('div', { class: 'tl-inner' });
    this.scroller = h('div', { class: 'tl-scroller' }, this.inner);
    const zoomIn = h('button', { type: 'button', title: '拡大' }, '＋');
    const zoomOut = h('button', { type: 'button', title: '縮小' }, '－');
    const fit = h('button', { type: 'button', title: '全体を表示' }, '全体');
    zoomIn.onclick = () => this.zoom(1.5);
    zoomOut.onclick = () => this.zoom(1 / 1.5);
    fit.onclick = () => {
      this.fitMode = true;
      this.draw();
    };
    const viewSel = h('div', { class: 'tl-view' });
    this.root = h('div', { class: 'timeline' }, h('div', { class: 'tl-tools' }, viewSel, h('span', { class: 'spacer' }), zoomOut, fit, zoomIn), h('div', { class: 'tl-body' }, this.canvas, this.scroller));
    this.renderViewSel(viewSel);
    store.subscribe((r) => {
      if (r === 'ui' || r === 'project') this.renderViewSel(viewSel);
    });
    this.scroller.addEventListener('scroll', () => this.draw());
    this.scroller.addEventListener('pointerdown', (e) => this.onDown(e));
    this.scroller.addEventListener('dblclick', (e) => {
      const hit = this.hit(e as unknown as PointerEvent);
      if (hit.candidate) toggleKeepCandidate(hit.candidate);
    });
    this.scroller.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    this.scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
      }
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  private renderViewSel(el: HTMLElement) {
    const v = store.state.ui.timelineView;
    el.replaceChildren(
      h('button', { type: 'button', class: v === 'output' ? 'on' : '', onclick: () => store.setUi({ timelineView: 'output' }) }, '編集後'),
      h('button', { type: 'button', class: v === 'source' ? 'on' : '', onclick: () => store.setUi({ timelineView: 'source' }), title: '元音声の上で無音カットの位置を確認・変更します' }, '元音声(カット確認)'),
      h('span', { class: 'hint' }, v === 'source' ? '赤=削る / 緑=残す指定 / 黄=発話の可能性で保護。クリックで「この間は残す」を切替' : 'クリックで移動、境界をドラッグで調整'),
    );
  }

  private zoom(f: number) {
    this.fitMode = false;
    this.pxPerSec = Math.max(8, Math.min(800, this.pxPerSec * f));
    this.draw();
  }

  private totalSamples(p: Project): number {
    const tl = timelineOf(p);
    if (!tl) return 0;
    return store.state.ui.timelineView === 'source' ? tl.srcSamples : tl.outSamples;
  }

  private xOf(samples: number): number {
    return (samples / SR) * this.pxPerSec - this.scroller.scrollLeft;
  }

  private tOf(x: number): number {
    return Math.max(0, ((x + this.scroller.scrollLeft) / this.pxPerSec) * SR);
  }

  draw() {
    const p = store.p;
    const width = this.scroller.clientWidth;
    const height = TRACK.ruler + TRACK.wave + TRACK.scenes + TRACK.caps;
    const total = this.totalSamples(p);
    if (this.fitMode && total > 0) this.pxPerSec = Math.max(4, (width - 10) / (total / SR));
    this.inner.style.width = `${Math.max(width, (total / SR) * this.pxPerSec + 20)}px`;
    this.inner.style.height = `${height}px`;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#15171b';
    g.fillRect(0, 0, width, height);
    const tl = timelineOf(p);
    if (!tl) {
      g.fillStyle = '#888';
      g.font = '13px sans-serif';
      g.fillText('ナレーション音声を取り込むと、ここに波形とシーン・テロップが表示されます', 12, 50);
      return;
    }
    const src = store.state.ui.timelineView === 'source';
    // 目盛り
    g.fillStyle = '#9aa0a6';
    g.font = '10px sans-serif';
    const step = this.pxPerSec > 120 ? 0.5 : this.pxPerSec > 40 ? 1 : this.pxPerSec > 15 ? 5 : 10;
    const t0 = Math.floor(this.tOf(0) / SR / step) * step;
    for (let s = t0; s * this.pxPerSec - this.scroller.scrollLeft < width; s += step) {
      const x = s * this.pxPerSec - this.scroller.scrollLeft;
      g.fillRect(x, TRACK.ruler - 5, 1, 5);
      g.fillText(formatTime(s * SR, false), x + 2, 10);
    }
    // 波形
    const a = store.state.analysis;
    const wy = TRACK.ruler;
    const mid = wy + TRACK.wave / 2;
    if (a) {
      g.fillStyle = '#5fb3a1';
      for (let x = 0; x < width; x++) {
        const o0 = this.tOf(x);
        const o1 = this.tOf(x + 1);
        const s0 = src ? o0 : outToSrc(tl, o0);
        const s1 = src ? o1 : Math.max(s0 + 1, outToSrc(tl, o1));
        if (!src && o0 >= tl.outSamples) break;
        if (src && o0 >= tl.srcSamples) break;
        const f0 = Math.floor(s0 / a.frameSamples);
        const f1 = Math.max(f0 + 1, Math.ceil(s1 / a.frameSamples));
        let pk = 0;
        for (let f = f0; f < f1 && f < a.peak.length; f++) pk = Math.max(pk, a.peak[f]!);
        const hgt = Math.max(1, pk * (TRACK.wave - 6));
        g.fillRect(x, mid - hgt / 2, 1, hgt);
      }
    }
    if (src) {
      // 無音候補とカット
      const cuts = decideCuts(p.silenceCandidates, p.cut.params, tl.srcSamples, p.cut.keepRanges);
      for (const c of p.silenceCandidates) {
        const kept = p.cut.keepRanges.some((k) => k.start < c.end && k.end > c.start);
        const x0 = this.xOf(c.start);
        const x1 = this.xOf(c.end);
        if (x1 < 0 || x0 > width) continue;
        g.fillStyle = kept ? 'rgba(80,200,120,0.25)' : c.protectedBySpeech ? 'rgba(240,200,60,0.3)' : 'rgba(255,255,255,0.06)';
        g.fillRect(x0, wy, Math.max(1, x1 - x0), TRACK.wave);
        if (store.state.ui.selectedCandidate === c.id) {
          g.strokeStyle = '#4da3ff';
          g.lineWidth = 2;
          g.strokeRect(x0, wy + 1, Math.max(2, x1 - x0), TRACK.wave - 2);
        }
      }
      g.fillStyle = 'rgba(255,70,70,0.45)';
      for (const c of cuts) {
        const x0 = this.xOf(c.start);
        const x1 = this.xOf(c.end);
        if (x1 < 0 || x0 > width) continue;
        g.fillRect(x0, wy + 8, Math.max(1, x1 - x0), TRACK.wave - 16);
      }
    } else {
      g.fillStyle = 'rgba(255,90,90,0.9)';
      for (const cp of cutPoints(tl)) {
        const x = this.xOf(cp);
        if (x >= 0 && x <= width) g.fillRect(x, wy, 1, 6);
      }
    }
    // シーン
    const toX = (outS: number) => (src ? this.xOf(outToSrc(tl, outS)) : this.xOf(outS));
    const sy = TRACK.ruler + TRACK.wave;
    const scenes = sceneOutputRanges(p.scenes, tl);
    const sel = store.state.ui.selection;
    scenes.forEach((s, i) => {
      const scn = src ? p.scenes[i]! : null;
      const x0 = src ? this.xOf(scn!.srcStart) : toX(s.outStart);
      const x1 = src ? this.xOf(scn!.srcEnd) : toX(s.outEnd);
      if (x1 < 0 || x0 > width) return;
      g.fillStyle = COLORS[i % COLORS.length]!;
      g.fillRect(x0 + 1, sy + 2, Math.max(1, x1 - x0 - 2), TRACK.scenes - 4);
      if (sel?.kind === 'scene' && sel.id === s.id) {
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, sy + 2, Math.max(1, x1 - x0 - 2), TRACK.scenes - 4);
      }
      g.fillStyle = '#fff';
      g.font = '11px sans-serif';
      const asset = p.scenes[i]?.bg ? p.assets.find((a2) => a2.id === p.scenes[i]!.bg!.assetId) : null;
      clipText(g, `#${i + 1} ${asset ? asset.name : '(背景なし)'}`, x0 + 5, sy + 19, x1 - x0 - 8);
    });
    // テロップ
    const cy = sy + TRACK.scenes;
    const caps = captionOutputTimings(p.captions, tl);
    const capById = new Map(p.captions.map((c) => [c.id, c]));
    for (const c of caps) {
      const cap = capById.get(c.id)!;
      const x0 = src ? this.xOf(cap.srcStart) : toX(c.outStart);
      const x1 = src ? this.xOf(cap.srcEnd) : toX(c.outEnd);
      if (x1 < 0 || x0 > width) continue;
      g.fillStyle = cap.review ? '#7a5b16' : '#2b3340';
      g.fillRect(x0 + 1, cy + 2, Math.max(1, x1 - x0 - 2), TRACK.caps - 4);
      if (sel?.kind === 'caption' && sel.id === c.id) {
        g.strokeStyle = '#4da3ff';
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, cy + 2, Math.max(1, x1 - x0 - 2), TRACK.caps - 4);
      }
      g.fillStyle = '#e8eaed';
      g.font = '11px sans-serif';
      clipText(g, cap.text.replace(/\n/g, ' '), x0 + 4, cy + 19, x1 - x0 - 6);
    }
    // 再生位置
    const ph = store.state.ui.playhead;
    const px = src ? this.xOf(outToSrc(tl, ph)) : this.xOf(ph);
    g.fillStyle = '#ff5252';
    g.fillRect(px - 1, 0, 2, height);
  }

  /** 再生中のスクロール追従 */
  follow(t: number) {
    const tl = timelineOf(store.p);
    if (!tl) return;
    const s = store.state.ui.timelineView === 'source' ? outToSrc(tl, t) : t;
    const x = (s / SR) * this.pxPerSec;
    const w = this.scroller.clientWidth;
    if (x < this.scroller.scrollLeft || x > this.scroller.scrollLeft + w - 40) this.scroller.scrollLeft = Math.max(0, x - w * 0.2);
    this.draw();
  }

  private hit(e: PointerEvent): { kind: DragKind; select?: { kind: 'scene' | 'caption'; id: string }; candidate?: string } {
    const p = store.p;
    const tl = timelineOf(p);
    if (!tl) return { kind: null };
    const r = this.scroller.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const src = store.state.ui.timelineView === 'source';
    const sy = TRACK.ruler + TRACK.wave;
    const cy = sy + TRACK.scenes;
    if (src && y >= TRACK.ruler && y < sy) {
      const s = this.tOf(x);
      const c = p.silenceCandidates.find((k) => s >= k.start && s < k.end);
      if (c) return { kind: { type: 'seek' }, candidate: c.id };
    }
    if (y >= sy && y < cy) {
      const ranges = sceneOutputRanges(p.scenes, tl);
      for (let i = 0; i < ranges.length - 1; i++) {
        const bx = src ? this.xOf(p.scenes[i]!.srcEnd) : this.xOf(ranges[i]!.outEnd);
        if (Math.abs(bx - x) < 6) return { kind: { type: 'scene-boundary', index: i } };
      }
      const t = src ? srcToOut(tl, this.tOf(x)) : this.tOf(x);
      const s = ranges.find((rg) => t >= rg.outStart && t < rg.outEnd);
      if (s) return { kind: { type: 'seek' }, select: { kind: 'scene', id: s.id } };
    }
    if (y >= cy) {
      const caps = captionOutputTimings(p.captions, tl);
      const capById = new Map(p.captions.map((c) => [c.id, c]));
      const x0Of = (c: (typeof caps)[number]) => (src ? this.xOf(capById.get(c.id)!.srcStart) : this.xOf(c.outStart));
      const x1Of = (c: (typeof caps)[number]) => (src ? this.xOf(capById.get(c.id)!.srcEnd) : this.xOf(c.outEnd));
      // 続いているテロップのつなぎ目は、両方いっしょに動かす(語も入れ替わる)
      for (let i = 0; i < caps.length - 1; i++) {
        const a = caps[i]!;
        const b = caps[i + 1]!;
        const xa = x1Of(a);
        if (Math.abs(xa - x0Of(b)) < 4 && Math.abs(x - xa) < 6) return { kind: { type: 'cap-joint', a: a.id, b: b.id }, select: { kind: 'caption', id: x < xa ? a.id : b.id } };
      }
      for (const c of caps) {
        if (Math.abs(x - x0Of(c)) < 5) return { kind: { type: 'cap-start', id: c.id }, select: { kind: 'caption', id: c.id } };
        if (Math.abs(x - x1Of(c)) < 5) return { kind: { type: 'cap-end', id: c.id }, select: { kind: 'caption', id: c.id } };
      }
      const t = src ? srcToOut(tl, this.tOf(x)) : this.tOf(x);
      const c = caps.find((k) => t >= k.outStart && t < k.outEnd);
      if (c) return { kind: { type: 'seek' }, select: { kind: 'caption', id: c.id } };
    }
    return { kind: { type: 'seek' } };
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const r = this.scroller.getBoundingClientRect();
    if (e.clientY - r.top > this.inner.clientHeight) return;
    const hit = this.hit(e);
    const tl = timelineOf(store.p);
    if (!tl) return;
    if (hit.candidate) {
      // クリックは選ぶだけ(右で「この間は残す」を切り替え)。うっかり残してしまわないよう、切り替えはダブルクリックかボタンで
      store.setUi({ selectedCandidate: hit.candidate, step: 2 }, 'candidate');
      return;
    }
    if (hit.select) store.setUi({ selection: hit.select, rightTab: 'selected' }, 'select');
    this.drag = hit.kind;
    if (hit.kind?.type === 'seek') {
      const x = e.clientX - r.left;
      const t = store.state.ui.timelineView === 'source' ? srcToOut(tl, this.tOf(x)) : this.tOf(x);
      this.onSeek?.(t);
    }
    this.scroller.setPointerCapture(e.pointerId);
  }



  private onMove(e: PointerEvent) {
    const r = this.scroller.getBoundingClientRect();
    const x = e.clientX - r.left;
    const tl = timelineOf(store.p);
    if (!tl) return;
    if (!this.drag) {
      const hit = this.hit(e);
      const cursor = hit.kind?.type === 'scene-boundary' || hit.kind?.type === 'cap-start' || hit.kind?.type === 'cap-end' || hit.kind?.type === 'cap-joint' ? 'ew-resize' : hit.candidate ? 'pointer' : 'default';
      if (cursor !== this.hover) {
        this.scroller.style.cursor = cursor;
        this.hover = cursor;
      }
      return;
    }
    const src = store.state.ui.timelineView === 'source';
    const t = Math.min(tl.outSamples, this.tOf(x));
    // ドラッグ位置の元音声の時刻(「元音声」表示ではそのまま、「編集後」表示では換算)
    const sAt = src ? Math.max(0, Math.min(tl.srcSamples, this.tOf(x))) : outToSrc(tl, t);
    const d = this.drag;
    if (d.type === 'seek') {
      this.onSeek?.(src ? srcToOut(tl, this.tOf(x)) : t);
    } else if (d.type === 'scene-boundary') {
      const p = store.p;
      const minGap = 0.3 * SR;
      let s: number;
      if (src) {
        s = Math.max(p.scenes[d.index]!.srcStart + minGap, Math.min(p.scenes[d.index + 1]!.srcEnd - minGap, sAt));
      } else {
        const ranges = sceneOutputRanges(p.scenes, tl);
        const lo = ranges[d.index]!.outStart + minGap;
        const hi = ranges[d.index + 1]!.outEnd - minGap;
        s = outToSrc(tl, Math.max(lo, Math.min(hi, t)));
      }
      store.commit(
        (pp) => ({
          ...pp,
          scenes: pp.scenes.map((sc, i) => (i === d.index ? { ...sc, srcEnd: s, boundaryEdited: true } : i === d.index + 1 ? { ...sc, srcStart: s, boundaryEdited: true } : sc)),
        }),
        { coalesce: 'scene-boundary-' + d.index },
      );
    } else if (d.type === 'cap-joint') {
      moveCaptionJoint(d.a, d.b, sAt);
    } else if (d.type === 'cap-start' || d.type === 'cap-end') {
      // 隣のテロップには重ならないようにする
      const sorted = [...store.p.captions].sort((a, b) => a.srcStart - b.srcStart);
      const k = sorted.findIndex((c) => c.id === d.id);
      const prevEnd = sorted[k - 1]?.srcEnd ?? 0;
      const nextStart = sorted[k + 1]?.srcStart ?? tl.srcSamples;
      store.commit(
        (pp) => ({
          ...pp,
          captions: pp.captions.map((c) => {
            if (c.id !== d.id) return c;
            if (d.type === 'cap-start') return { ...c, srcStart: Math.max(prevEnd, Math.min(sAt, c.srcEnd - 0.1 * SR)), timingEdited: true };
            return { ...c, srcEnd: Math.min(nextStart, Math.max(sAt, c.srcStart + 0.1 * SR)), timingEdited: true };
          }),
        }),
        { coalesce: 'cap-drag-' + d.id },
      );
    }
  }

  private onUp() {
    this.drag = null;
  }
}

function clipText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number) {
  if (maxW < 12) return;
  let t = text;
  if (g.measureText(t).width > maxW) {
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    t += '…';
  }
  g.fillText(t, x, y);
}
