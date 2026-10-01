// 9:16 プレビュー。書き出しと同じ配置計算・同じテロップ描画関数を使う。
import { SR, type Asset, type Caption, type Project, type Scene, type Timeline } from '../shared/types.js';
import { captionOutputTimings, sceneOutputRanges, type CaptionTiming } from '../shared/segment.js';
import { placeBackground, placeInset } from '../shared/fit.js';
import { evalMotion, motionExprs, motionOf } from '../shared/motion.js';
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
  /** 画像・動画の最初のフレームが表示できる状態になったか */
  ready: boolean;
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
  /** 表示を切り替える予定だが、まだ読み込み中の背景(読み込むまで前の背景を出したままにする) */
  private pendingLayer: BgLayer | null = null;
  /** 次のカットの背景を先に読み込んでおく */
  private prepared = new Map<string, BgLayer>();
  private layerZ = 1;
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
  private drag: { startX: number; startY: number; dx: number; dy: number; capId: string; only: boolean } | null = null;
  /** 背景のドラッグ(位置の調整)。ox/oy は動かしている途中の位置 */
  private bgDrag: { startX: number; startY: number; sceneId: string; ox0: number; oy0: number; spanX: number; spanY: number; ox: number; oy: number } | null = null;
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
    this.guideCanvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
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
        this.disposeLayer(this.layer);
        this.layer = null;
      } else this.layer.scene = cur;
    }
    // 設定が変わったら先読みは作り直す
    for (const l of this.prepared.values()) this.disposeLayer(l);
    this.prepared.clear();
    if (this.pendingLayer) {
      this.disposeLayer(this.pendingLayer);
      this.pendingLayer = null;
    }
    this.fit();
    this.refreshAudio(p);
    this.refreshBgm(p);
    this.render(this.currentTime());
  }

  private audioTimer: ReturnType<typeof setTimeout> | null = null;
  private audioTries = 0;
  private audioLoading = false;

  /** 編集後の音声を用意する。連続した変更はまとめ、失敗したら少し待って自動でやり直す */
  private refreshAudio(p: Project, force = false) {
    if (!p.narration || !this.tl) {
      this.audioReady = false;
      return;
    }
    const hash = this.tl.hash + p.narration.sourceKey;
    if (hash === this.audioHash && !force) return;
    this.audioHash = hash;
    this.audioReady = false;
    if (!force) this.audioTries = 0;
    if (this.audioTimer) clearTimeout(this.audioTimer);
    // 素早い操作が続いても、落ち着いてから1回だけ頼む
    this.audioTimer = setTimeout(() => void this.loadAudio(hash), force ? 0 : 250);
  }

  private async loadAudio(hash: string) {
    this.audioTimer = null;
    const p = store.p;
    const tl = this.tl;
    if (!p.narration || !tl || hash !== this.audioHash) return;
    const t = this.currentTime();
    const wasPlaying = this.isPlaying();
    this.audioLoading = true;
    try {
      const { url } = await api.editedAudio(p.id, p.narration.sourceKey, tl);
      if (hash !== this.audioHash) return;
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => cleanup(new Error('音声の読み込みに時間がかかりすぎました')), 20000);
        const ok = () => cleanup();
        const ng = () => cleanup(new Error('音声ファイルを読み込めませんでした'));
        const cleanup = (err?: Error) => {
          clearTimeout(timer);
          this.narration.removeEventListener('loadedmetadata', ok);
          this.narration.removeEventListener('error', ng);
          if (err) rej(err);
          else res();
        };
        this.narration.addEventListener('loadedmetadata', ok);
        this.narration.addEventListener('error', ng);
        this.narration.src = url;
      });
      if (hash !== this.audioHash) return;
      this.narration.currentTime = Math.min(t, tl.outSamples) / SR;
      this.audioReady = true;
      this.audioTries = 0;
      this.sourceAudio.src = `/api/projects/${p.id}/source-audio/${p.narration.sourceKey}`;
      if (wasPlaying) void this.play();
    } catch (e) {
      if (hash !== this.audioHash) return;
      // 失敗したまま止まらないよう、少し待ってやり直す(1, 2, 4, 8秒)
      this.audioTries++;
      if (this.audioTries <= 4) {
        console.warn('編集後の音声の準備に失敗。やり直します', e);
        this.audioTimer = setTimeout(() => void this.loadAudio(hash), 1000 * 2 ** (this.audioTries - 1));
      } else {
        toast('編集後の音声を作れませんでした: ' + (e as Error).message + '(もう一度再生を押すとやり直します)', 'error');
      }
    } finally {
      this.audioLoading = false;
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
    if (!this.audioReady) {
      // 準備が止まっていたらやり直す
      if (!this.audioLoading && !this.audioTimer) {
        this.audioTries = 0;
        this.refreshAudio(p, true);
      }
      return toast('音声を準備中です。少し待ってから再生してください');
    }
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
    // 位置・拡大率・動き・使う区間は毎フレーム当てはめるので、変えても作り直さない(ドラッグで動かしてもちらつかない)
    const bg = scene.bg ? { ...scene.bg, fit: undefined, zoom: undefined, offsetX: undefined, offsetY: undefined, motion: undefined, kenBurns: undefined, startSec: undefined } : null;
    return JSON.stringify([scene.id, bg, scene.inset, scene.speed ?? 1, p.export.width, p.export.height]);
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
        this.disposeLayer(this.layer);
        this.layer = null;
      }
    } else {
      this.switchLayer(scene, p);
      if (this.layer) this.updateLayer(this.layer, t, sr!, W, H, true);
      if (this.pendingLayer) this.updateLayer(this.pendingLayer, t, sr!, W, H, true);
      this.prefetchNext(sr!, p, W, H);
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

  /** 背景レイヤーを作る(最初は非表示。読み込めたら ready) */
  private makeLayer(scene: Scene, p: Project, key: string): BgLayer {
    const el = h('div', { class: 'bg-layer' });
    el.style.visibility = 'hidden';
    const layer: BgLayer = { key, el, scene, ready: true };
    const bg = scene.bg;
    const asset = bg ? p.assets.find((a) => a.id === bg.assetId) : undefined;
    if (bg && asset && asset.status === 'ok') {
      layer.asset = asset;
      layer.ready = false;
      const markReady = () => {
        if (layer.ready) return;
        layer.ready = true;
        if (this.pendingLayer === layer) this.showLayer(layer);
      };
      if (asset.kind === 'image') {
        const img = h('img', { class: 'bg-media', src: mediaUrl(p.id, asset.id, 'preview'), alt: '' });
        img.addEventListener('load', markReady);
        img.addEventListener('error', markReady);
        el.appendChild(img);
        if (img.complete) layer.ready = true;
      } else if (asset.kind === 'video') {
        const v = h('video', { class: 'bg-media', src: mediaUrl(p.id, asset.id, 'preview'), preload: 'auto', playsinline: true });
        v.muted = !bg.audio || bg.mode === 'synced';
        v.volume = Math.min(1, dbToLin(bg.volumeDb));
        if (bg.shortMode === 'loop') v.loop = true;
        // 最初のフレームを表示できるようになったら切り替える
        v.addEventListener('loadeddata', markReady);
        v.addEventListener('seeked', () => {
          if (v.readyState >= 2) markReady();
        });
        v.addEventListener('error', () => {
          el.appendChild(h('div', { class: 'media-error' }, `「${asset.name}」をこのブラウザで再生できません(プレビューのみ。書き出しには影響しません)。Chrome か Safari をお使いください。`));
          markReady();
        });
        el.appendChild(v);
        layer.video = v;
      } else layer.ready = true;
    }
    this.bgHost.appendChild(el);
    return layer;
  }

  private disposeLayer(l: BgLayer) {
    l.video?.pause();
    l.video?.removeAttribute('src');
    l.el.remove();
  }

  /** 新しい背景を表示し、前の背景を片付ける(新しい背景が描ける状態になってから入れ替えるので暗転しない) */
  private showLayer(l: BgLayer) {
    l.el.style.visibility = 'visible';
    l.el.style.zIndex = String(++this.layerZ);
    const old = this.layer;
    this.layer = l;
    if (this.pendingLayer === l) this.pendingLayer = null;
    if (old && old !== l) this.disposeLayer(old);
  }

  private switchLayer(scene: Scene, p: Project) {
    const key = this.layerKey(scene, p);
    if (this.layer?.key === key) {
      this.layer.scene = scene;
      if (this.pendingLayer) {
        this.disposeLayer(this.pendingLayer);
        this.pendingLayer = null;
      }
      return;
    }
    if (this.pendingLayer?.key === key) return; // 読み込み待ち
    if (this.pendingLayer) {
      this.disposeLayer(this.pendingLayer);
      this.pendingLayer = null;
    }
    let next = this.prepared.get(key);
    if (next) this.prepared.delete(key);
    else next = this.makeLayer(scene, p, key);
    if (next.ready || !this.layer) this.showLayer(next);
    else this.pendingLayer = next;
  }

  /** 次のカットの背景を、開始位置まで進めた状態で先に読み込んでおく */
  private prefetchNext(sr: { id: string; outStart: number; outEnd: number }, p: Project, W: number, H: number) {
    const i = this.sceneRanges.findIndex((r) => r.id === sr.id);
    const nr = this.sceneRanges[i + 1];
    const nextScene = nr ? p.scenes.find((s) => s.id === nr.id) : undefined;
    const want = nextScene && nextScene.bg ? this.layerKey(nextScene, p) : null;
    for (const [k, l] of this.prepared) {
      if (k !== want) {
        this.disposeLayer(l);
        this.prepared.delete(k);
      }
    }
    if (!want || !nextScene || !nr || want === this.layer?.key || want === this.pendingLayer?.key) return;
    let l = this.prepared.get(want);
    if (!l) {
      l = this.makeLayer(nextScene, p, want);
      this.prepared.set(want, l);
    }
    this.updateLayer(l, nr.outStart, nr, W, H, false);
  }

  private updateLayer(layer: BgLayer, t: number, sr: { outStart: number; outEnd: number }, W: number, H: number, active: boolean) {
    if (!layer.asset || !layer.scene.bg) return;
    const bg = layer.scene.bg;
    const a = layer.asset;
    const media = layer.el.firstElementChild as HTMLElement | null;
    if (!media || !a.width || !a.height) return;
    // 背景をドラッグ中は、その位置で表示する
    const o = this.bgDrag && this.bgDrag.sceneId === layer.scene.id ? { offsetX: this.bgDrag.ox, offsetY: this.bgDrag.oy } : {};
    const pl = placeBackground(a.width, a.height, W, H, { ...bg, ...o });
    Object.assign(media.style, { left: `${pl.x}px`, top: `${pl.y}px`, width: `${pl.w}px`, height: `${pl.h}px` });
    // カット内の動き(書き出しと同じ式)
    const mex = motionExprs(motionOf(bg), (sr.outEnd - sr.outStart) / SR, W, H);
    if (mex) {
      const m = evalMotion(mex, Math.max(0, (t - sr.outStart) / SR));
      const lim = (v: number, size: number) => Math.max(-((m.s - 1) * size) / 2, Math.min(((m.s - 1) * size) / 2, v));
      layer.el.style.transform = `translate(${lim(m.dx, W)}px, ${lim(m.dy, H)}px) scale(${m.s})`;
    } else layer.el.style.transform = '';
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
      // 元動画と同期する場合は、シーンの話す速さで映像も再生する
      const rate = bg.mode === 'synced' ? layer.scene.speed ?? 1 : 1;
      if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;
      const playing = active && this.isPlaying() && this.mode === 'edited';
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
      this.drag = { startX: pt.x, startY: pt.y, dx: 0, dy: 0, capId: this.capId, only: e.altKey };
      store.setUi({ selection: { kind: 'caption', id: this.capId } }, 'select');
      e.preventDefault();
      return;
    }
    // 「確認して修正」では、背景をドラッグして見せる位置を変えられる
    const bgTarget = this.editableBg();
    if (bgTarget) {
      const { scene, pl } = bgTarget;
      const W = store.p.export.width;
      const H = store.p.export.height;
      const bg = scene.bg!;
      this.bgDrag = { startX: pt.x, startY: pt.y, sceneId: scene.id, ox0: bg.offsetX, oy0: bg.offsetY, spanX: Math.abs(W - pl.w), spanY: Math.abs(H - pl.h), ox: bg.offsetX, oy: bg.offsetY };
      store.setUi({ selection: { kind: 'scene', id: scene.id }, rightTab: 'selected' }, 'select');
      this.guideCanvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  }

  /** いま表示している、位置を動かせる背景(停止中・「確認して修正」のときだけ) */
  private editableBg(): { scene: Scene; pl: { w: number; h: number } } | null {
    if (store.state.ui.step !== 3 || this.isPlaying()) return null;
    const layer = this.layer;
    const bg = layer?.scene.bg;
    const a = layer?.asset;
    if (!layer || !bg || !a?.width || !a.height) return null;
    const pl = placeBackground(a.width, a.height, store.p.export.width, store.p.export.height, bg);
    return { scene: layer.scene, pl };
  }

  /** ホイール(トラックパッドのピンチ・2本指スクロール)で背景を拡大縮小 */
  private onWheel(e: WheelEvent) {
    const t = this.editableBg();
    if (!t) return;
    e.preventDefault();
    const id = t.scene.id;
    const z0 = t.scene.bg!.zoom;
    const z = Math.round(Math.max(0.5, Math.min(3, z0 * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))) * 1000) / 1000;
    if (z === z0) return;
    store.setUi({ selection: { kind: 'scene', id } }, 'select');
    store.commit((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === id && s.bg ? { ...s, bg: { ...s.bg, zoom: z } } : s)) }), { coalesce: `bgzoom-${id}` });
  }

  private onPointerMove(e: PointerEvent) {
    const bd = this.bgDrag;
    if (bd) {
      const pt = this.toStage(e);
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      // はみ出している量の範囲で動かす(はみ出しがない向きには動かない)
      if (bd.spanX > 1) bd.ox = clamp(bd.ox0 + (2 * (pt.x - bd.startX)) / bd.spanX);
      if (bd.spanY > 1) bd.oy = clamp(bd.oy0 + (2 * (pt.y - bd.startY)) / bd.spanY);
      this.render(this.currentTime());
      return;
    }
    if (!this.drag) return;
    const pt = this.toStage(e);
    this.drag.dx = pt.x - this.drag.startX;
    this.drag.dy = pt.y - this.drag.startY;
    // ドラッグ中は簡易表示(描画済みの画像を動かすだけ)
    this.capCanvas.style.transform = `translate(${this.drag.dx}px, ${this.drag.dy}px)`;
  }

  private onPointerUp() {
    const bd = this.bgDrag;
    if (bd) {
      this.bgDrag = null;
      this.guideCanvas.style.cursor = '';
      const ox = Math.round(bd.ox * 1000) / 1000;
      const oy = Math.round(bd.oy * 1000) / 1000;
      if (ox !== bd.ox0 || oy !== bd.oy0) {
        store.commit((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === bd.sceneId && s.bg ? { ...s, bg: { ...s.bg, offsetX: ox, offsetY: oy } } : s)) }));
      } else this.render(this.currentTime());
      return;
    }
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
    // 通常は全テロップ共通の位置を動かす。⌥(Option)を押しながら、またはすでに個別の位置があるテロップは、そのテロップだけ動かす
    const own = cap.style?.x !== undefined || cap.style?.y !== undefined;
    if (d.only || own) {
      store.commit((p) => ({ ...p, captions: p.captions.map((c) => (c.id === d.capId ? { ...c, style: { ...c.style, x: nx, y: ny } } : c)) }));
    } else {
      store.commit((p) => ({ ...p, style: { ...p.style, x: nx, y: ny } }));
    }
  }
}
