// 9:16 プレビュー。書き出しと同じ配置計算・同じテロップ描画関数を使う。
import { SR, type Asset, type Caption, type Project, type Scene, type Timeline } from '../shared/types.js';
import { captionOutputTimings, sceneOutputRanges, type CaptionTiming } from '../shared/segment.js';
import { kenBurnsScale, placeBackground, placeInset } from '../shared/fit.js';
import { drawCaption, effectiveStyle, type CaptionBox } from '../shared/captionRender.js';
import { outToSrc, srcToOut } from '../shared/timemap.js';
import { timelineOf } from '../shared/project.js';
import { api, mediaUrl } from './api.js';
import { h, toast } from './dom.js';
import { fontState, renderFontFor } from './fonts.js';
import { store } from './state.js';

const dbToLin = (db: number) => Math.pow(10, db / 20);

interface BgLayer {
  key: string;
  el: HTMLElement;
  video?: HTMLVideoElement;
  scene: Scene;
  asset?: Asset;
}

export class Player {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private bgHost: HTMLElement;
  private insetImg: HTMLImageElement;
  private capCanvas: HTMLCanvasElement;
  private guideCanvas: HTMLCanvasElement;
  private warn: HTMLElement;
  private narration = new Audio();
  private sourceAudio = new Audio();
  private bgm = new Audio();
  private ctx: AudioContext | null = null;
  private narrGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private layer: BgLayer | null = null;
  private tl: Timeline | null = null;
  private captionTimes: CaptionTiming[] = [];
  private captionMap = new Map<string, Caption>();
  private sceneRanges: { id: string; outStart: number; outEnd: number }[] = [];
  private audioHash = '';
  private audioReady = false;
  private capKey = '';
  private capBox: CaptionBox | null = null;
  private capId: string | null = null;
  private stopAt: number | null = null;
  private mode: 'edited' | 'source' = 'edited';
  private drag: { startX: number; startY: number; dx: number; dy: number; capId: string } | null = null;
  scale = 0.3;
  onTick: ((t: number) => void) | null = null;

  constructor() {
    this.bgHost = h('div', { class: 'bg-host' });
    this.insetImg = h('img', { class: 'inset', alt: '' });
    this.capCanvas = h('canvas', { class: 'cap-canvas', width: 1080, height: 1920 });
    this.guideCanvas = h('canvas', { class: 'guide-canvas', width: 1080, height: 1920 });
    this.warn = h('div', { class: 'preview-warn' });
    this.stage = h('div', { class: 'stage' }, this.bgHost, this.insetImg, this.capCanvas, this.guideCanvas, this.warn);
    this.root = h('div', { class: 'stage-wrap' }, this.stage);
    for (const a of [this.narration, this.sourceAudio, this.bgm]) {
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
    }
    this.narration.addEventListener('ended', () => this.pause());
    this.guideCanvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
    new ResizeObserver(() => this.fit()).observe(this.root);
    requestAnimationFrame(() => this.loop());
  }

  private fit() {
    const r = this.root.getBoundingClientRect();
    const W = store.p.export.width;
    const H = store.p.export.height;
    this.scale = Math.max(0.05, Math.min(r.width / W, r.height / H));
    this.stage.style.width = `${W}px`;
    this.stage.style.height = `${H}px`;
    this.stage.style.transform = `translate(-50%, -50%) scale(${this.scale})`;
  }

  /** プロジェクト変更時に呼ぶ */
  update(p: Project) {
    this.tl = timelineOf(p);
    this.captionTimes = captionOutputTimings(p.captions, this.tl);
    this.captionMap = new Map(p.captions.map((c) => [c.id, c]));
    this.sceneRanges = sceneOutputRanges(p.scenes, this.tl);
    this.stage.style.background = p.export.bgColor;
    this.capKey = '';
    if (this.layer) {
      const cur = p.scenes.find((s) => s.id === this.layer!.scene.id);
      if (!cur || this.layerKey(cur, p) !== this.layer.key) {
        this.layer.video?.pause();
        this.layer.el.remove();
        this.layer = null;
      }
    }
    this.fit();
    void this.refreshAudio(p);
    this.refreshBgm(p);
    this.render(this.currentTime());
  }

  private async refreshAudio(p: Project) {
    if (!p.narration || !this.tl) {
      this.audioReady = false;
      return;
    }
    const hash = this.tl.hash + p.narration.sourceKey;
    if (hash === this.audioHash) return;
    this.audioHash = hash;
    this.audioReady = false;
    const t = this.currentTime();
    const wasPlaying = this.isPlaying();
    try {
      const { url } = await api.editedAudio(p.id, p.narration.sourceKey, this.tl);
      if (hash !== this.audioHash) return;
      this.narration.src = url;
      await new Promise<void>((res) => {
        const done = () => res();
        this.narration.addEventListener('loadedmetadata', done, { once: true });
        this.narration.addEventListener('error', done, { once: true });
      });
      this.narration.currentTime = Math.min(t, this.tl.outSamples) / SR;
      this.audioReady = true;
      this.sourceAudio.src = `/api/projects/${p.id}/source-audio/${p.narration.sourceKey}`;
      if (wasPlaying) void this.play();
    } catch (e) {
      toast('編集後の音声を作れませんでした: ' + (e as Error).message, 'error');
    }
  }

  private refreshBgm(p: Project) {
    const url = p.bgm ? mediaUrl(p.id, p.bgm.assetId, 'file') : '';
    if (!url) {
      this.bgm.pause();
      this.bgm.removeAttribute('src');
      return;
    }
    if (!this.bgm.src.endsWith(url)) this.bgm.src = url;
  }

  private ensureAudioGraph() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.narrGain = this.ctx.createGain();
      this.bgmGain = this.ctx.createGain();
      this.ctx.createMediaElementSource(this.narration).connect(this.narrGain).connect(this.ctx.destination);
      this.ctx.createMediaElementSource(this.bgm).connect(this.bgmGain).connect(this.ctx.destination);
      this.ctx.createMediaElementSource(this.sourceAudio).connect(this.ctx.destination);
    } catch (e) {
      console.warn('WebAudio が使えません', e);
    }
  }

  currentTime(): number {
    if (this.mode === 'edited' && this.isPlaying()) return Math.round(this.narration.currentTime * SR);
    return store.state.ui.playhead;
  }

  isPlaying(): boolean {
    return store.state.ui.playing;
  }

  async play(from?: number, to?: number) {
    const p = store.p;
    if (!p.narration || !this.tl) return toast('先にナレーション音声を取り込んでください');
    if (!this.audioReady) return toast('音声を準備中です。少し待ってから再生してください');
    this.ensureAudioGraph();
    await this.ctx?.resume();
    this.mode = 'edited';
    this.sourceAudio.pause();
    const start = from ?? (store.state.ui.playhead >= this.tl.outSamples - SR * 0.05 ? 0 : store.state.ui.playhead);
    this.narration.currentTime = start / SR;
    this.stopAt = to ?? null;
    store.setUi({ playing: true, playhead: start }, 'play');
    try {
      await this.narration.play();
    } catch (e) {
      store.setUi({ playing: false }, 'play');
      toast('再生できませんでした: ' + (e as Error).message, 'error');
    }
  }

  pause() {
    const t = this.mode === 'edited' ? Math.round(this.narration.currentTime * SR) : store.state.ui.playhead;
    this.narration.pause();
    this.sourceAudio.pause();
    this.bgm.pause();
    this.layer?.video?.pause();
    this.stopAt = null;
    this.mode = 'edited';
    store.setUi({ playing: false, playhead: t }, 'play');
  }

  toggle() {
    if (this.isPlaying()) this.pause();
    else void this.play();
  }

  seek(t: number) {
    const max = this.tl?.outSamples ?? 0;
    const v = Math.max(0, Math.min(max, Math.round(t)));
    if (this.isPlaying() && this.mode === 'edited') this.narration.currentTime = v / SR;
    store.setUi({ playhead: v }, 'seek');
    this.render(v);
  }

  /** 元音声の範囲を再生(カット前の比較用) */
  async playSource(srcStart: number, srcEnd: number) {
    if (!store.p.narration) return;
    this.ensureAudioGraph();
    await this.ctx?.resume();
    this.pause();
    this.mode = 'source';
    this.sourceAudio.currentTime = srcStart / SR;
    this.stopAt = srcEnd;
    store.setUi({ playing: true }, 'play');
    await this.sourceAudio.play().catch(() => undefined);
  }

  private loop() {
    requestAnimationFrame(() => this.loop());
    if (!this.isPlaying()) return;
    if (this.mode === 'source') {
      const s = Math.round(this.sourceAudio.currentTime * SR);
      if ((this.stopAt !== null && s >= this.stopAt) || this.sourceAudio.ended) this.pause();
      if (this.tl) this.render(srcToOut(this.tl, s));
      return;
    }
    const t = Math.round(this.narration.currentTime * SR);
    if (this.stopAt !== null && t >= this.stopAt) {
      this.pause();
      return;
    }
    store.state.ui.playhead = t;
    this.syncBgm(t);
    this.render(t);
    this.onTick?.(t);
  }

  private syncBgm(t: number) {
    const b = store.p.bgm;
    if (!b || !this.bgm.src) return;
    const T = (this.tl?.outSamples ?? 0) / SR;
    const sec = t / SR;
    const dur = this.bgm.duration;
    let pos = b.startSec + sec;
    if (isFinite(dur) && dur > 0 && pos >= dur) {
      if (b.loop) pos = pos % dur;
      else {
        this.bgm.pause();
        return;
      }
    }
    if (Math.abs(this.bgm.currentTime - pos) > 0.25) this.bgm.currentTime = pos;
    if (this.bgm.paused) void this.bgm.play().catch(() => undefined);
    let g = dbToLin(b.volumeDb);
    if (b.fadeInSec > 0 && sec < b.fadeInSec) g *= sec / b.fadeInSec;
    if (b.fadeOutSec > 0 && sec > T - b.fadeOutSec) g *= Math.max(0, (T - sec) / b.fadeOutSec);
    if (this.bgmGain) this.bgmGain.gain.value = g;
    else this.bgm.volume = Math.min(1, g);
    if (this.narrGain) this.narrGain.gain.value = dbToLin(store.p.mix.narrationDb);
  }

  private layerKey(scene: Scene, p: Project): string {
    const bg = scene.bg;
    return JSON.stringify([scene.id, bg, scene.inset, p.export.width, p.export.height]);
  }

  /** 指定時刻の画面を描く */
  render(t: number) {
    const p = store.p;
    const W = p.export.width;
    const H = p.export.height;
    const sr = this.sceneRanges.find((s) => t >= s.outStart && t < s.outEnd) ?? this.sceneRanges[this.sceneRanges.length - 1];
    const scene = sr ? p.scenes.find((s) => s.id === sr.id) ?? null : null;
    // 背景
    if (!scene) {
      if (this.layer) {
        this.layer.el.remove();
        this.layer = null;
      }
    } else {
      const key = this.layerKey(scene, p);
      if (!this.layer || this.layer.key !== key) this.buildLayer(scene, p, key);
      this.updateLayer(t, sr!, p, W, H);
    }
    // 差し込み画像
    const inset = scene?.inset;
    const insetAsset = inset ? p.assets.find((a) => a.id === inset.assetId) : undefined;
    if (inset && insetAsset?.width && insetAsset.height && sr) {
      const rel = (t - sr.outStart) / SR;
      const visible = rel >= inset.startSec && (inset.endSec == null || rel < inset.endSec);
      const pl = placeInset(insetAsset.width, insetAsset.height, W, H, inset);
      const url = mediaUrl(p.id, insetAsset.id, 'preview');
      if (!this.insetImg.src.endsWith(url)) this.insetImg.src = url;
      Object.assign(this.insetImg.style, { left: `${pl.x}px`, top: `${pl.y}px`, width: `${pl.w}px`, height: `${pl.h}px`, display: visible ? 'block' : 'none' });
    } else this.insetImg.style.display = 'none';
    // テロップ
    this.renderCaption(t, p, W, H);
    this.renderGuide(p, W, H);
  }

  private buildLayer(scene: Scene, p: Project, key: string) {
    this.layer?.video?.pause();
    this.layer?.el.remove();
    const el = h('div', { class: 'bg-layer' });
    const layer: BgLayer = { key, el, scene };
    const bg = scene.bg;
    const asset = bg ? p.assets.find((a) => a.id === bg.assetId) : undefined;
    if (bg && asset && asset.status === 'ok') {
      layer.asset = asset;
      if (asset.kind === 'image') {
        el.appendChild(h('img', { class: 'bg-media', src: mediaUrl(p.id, asset.id, 'preview'), alt: '' }));
      } else if (asset.kind === 'video') {
        const v = h('video', { class: 'bg-media', src: mediaUrl(p.id, asset.id, 'preview'), preload: 'auto', playsinline: true });
        v.muted = !bg.audio || bg.mode === 'synced';
        v.volume = Math.min(1, dbToLin(bg.volumeDb));
        if (bg.shortMode === 'loop') v.loop = true;
        v.addEventListener('error', () => {
          el.appendChild(h('div', { class: 'media-error' }, `「${asset.name}」をこのブラウザで再生できません(プレビューのみ。書き出しには影響しません)。Chrome か Safari をお使いください。`));
        });
        el.appendChild(v);
        layer.video = v;
      }
    }
    this.bgHost.appendChild(el);
    this.layer = layer;
  }

  private updateLayer(t: number, sr: { outStart: number; outEnd: number }, p: Project, W: number, H: number) {
    const layer = this.layer;
    if (!layer || !layer.asset || !layer.scene.bg) return;
    const bg = layer.scene.bg;
    const a = layer.asset;
    const media = layer.el.firstElementChild as HTMLElement | null;
    if (!media || !a.width || !a.height) return;
    const pl = placeBackground(a.width, a.height, W, H, bg);
    Object.assign(media.style, { left: `${pl.x}px`, top: `${pl.y}px`, width: `${pl.w}px`, height: `${pl.h}px` });
    const progress = (t - sr.outStart) / Math.max(1, sr.outEnd - sr.outStart);
    layer.el.style.transform = bg.kenBurns ? `scale(${kenBurnsScale(progress)})` : '';
    const v = layer.video;
    if (v) {
      let want: number;
      const dur = isFinite(v.duration) ? v.duration : a.durationSec ?? 0;
      if (bg.mode === 'synced' && this.tl) {
        want = outToSrc(this.tl, t) / SR + (a.audioStartSec ?? 0) - (a.videoStartSec ?? 0);
      } else {
        want = bg.startSec + (t - sr.outStart) / SR;
        if (dur > 0 && want >= dur) want = bg.shortMode === 'loop' ? want % dur : Math.max(0, dur - 0.04);
      }
      const playing = this.isPlaying() && this.mode === 'edited';
      const frozen = bg.mode !== 'synced' && bg.shortMode === 'freeze' && dur > 0 && want >= dur - 0.05;
      if (playing && !frozen) {
        if (Math.abs(v.currentTime - want) > (bg.mode === 'synced' ? 0.12 : 0.25)) v.currentTime = want;
        if (v.paused) void v.play().catch(() => undefined);
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want;
      }
    }
  }

  private currentCaption(t: number): Caption | null {
    const ct = this.captionTimes.find((c) => t >= c.outStart && t < c.outEnd);
    return ct ? this.captionMap.get(ct.id) ?? null : null;
  }

  private renderCaption(t: number, p: Project, W: number, H: number) {
    let cap = this.currentCaption(t);
    // 選択中のテロップは停止中なら常に表示して確認しやすくする
    const sel = store.state.ui.selection;
    if (!cap && !this.isPlaying() && sel?.kind === 'caption') cap = this.captionMap.get(sel.id) ?? null;
    const style = cap ? effectiveStyle(p.style, cap) : p.style;
    const key = cap ? JSON.stringify([cap.id, cap.text, style, fontState(style.fontId)]) : 'none';
    if (key === this.capKey) return;
    this.capKey = key;
    const g = this.capCanvas.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    this.capBox = null;
    this.capId = cap?.id ?? null;
    this.warn.textContent = '';
    if (!cap || !cap.text.trim()) return;
    const font = renderFontFor(style);
    if (!font) {
      const st = fontState(style.fontId);
      this.warn.textContent = st === 'error' ? 'フォントを読み込めません(テロップ設定を確認)' : 'フォント読み込み中…';
      return;
    }
    this.capBox = drawCaption(g, cap.text, style, font, W, H);
  }

  private renderGuide(p: Project, W: number, H: number) {
    const g = this.guideCanvas.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    const sa = p.safeArea;
    if (sa.show) {
      g.fillStyle = 'rgba(255, 60, 60, 0.18)';
      g.fillRect(0, 0, W, (H * sa.topPct) / 100);
      g.fillRect(0, H - (H * sa.bottomPct) / 100, W, (H * sa.bottomPct) / 100);
      g.fillRect(W - (W * sa.rightPct) / 100, 0, (W * sa.rightPct) / 100, H);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.font = '28px sans-serif';
      g.fillText('UIが重なる可能性のある領域(目安)', 24, (H * sa.topPct) / 100 - 14);
    }
    const sel = store.state.ui.selection;
    if (this.capBox && sel?.kind === 'caption' && sel.id === this.capId && !this.isPlaying()) {
      g.setLineDash([14, 10]);
      g.strokeStyle = '#4da3ff';
      g.lineWidth = 4;
      g.strokeRect(this.capBox.x, this.capBox.y, this.capBox.w, this.capBox.h);
      g.setLineDash([]);
    }
  }

  // ---- テロップのドラッグ ----
  private toStage(e: PointerEvent): { x: number; y: number } {
    const r = this.guideCanvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * store.p.export.width, y: ((e.clientY - r.top) / r.height) * store.p.export.height };
  }

  private onPointerDown(e: PointerEvent) {
    const pt = this.toStage(e);
    const b = this.capBox;
    if (b && this.capId && pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) {
      this.drag = { startX: pt.x, startY: pt.y, dx: 0, dy: 0, capId: this.capId };
      store.setUi({ selection: { kind: 'caption', id: this.capId } }, 'select');
      e.preventDefault();
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.drag) return;
    const pt = this.toStage(e);
    this.drag.dx = pt.x - this.drag.startX;
    this.drag.dy = pt.y - this.drag.startY;
    // ドラッグ中は簡易表示(描画済みの画像を動かすだけ)
    this.capCanvas.style.transform = `translate(${this.drag.dx}px, ${this.drag.dy}px)`;
  }

  private onPointerUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.capCanvas.style.transform = '';
    if (Math.abs(d.dx) < 2 && Math.abs(d.dy) < 2) return;
    const W = store.p.export.width;
    const H = store.p.export.height;
    const cap = store.p.captions.find((c) => c.id === d.capId);
    if (!cap) return;
    const st = effectiveStyle(store.p.style, cap);
    const nx = Math.round(Math.max(0, Math.min(1, st.x + d.dx / W)) * 1000) / 1000;
    const ny = Math.round(Math.max(0, Math.min(1, st.y + d.dy / H)) * 1000) / 1000;
    // 確定後は書き出しと同じ描画で表示し直す
    if (store.state.ui.applyDragToAll) {
      store.commit((p) => ({ ...p, style: { ...p.style, x: nx, y: ny } }));
    } else {
      store.commit((p) => ({ ...p, captions: p.captions.map((c) => (c.id === d.capId ? { ...c, style: { ...c.style, x: nx, y: ny } } : c)) }));
    }
  }
}
