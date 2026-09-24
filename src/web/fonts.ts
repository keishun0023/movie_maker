// フォントの読み込み。サーバーからフォントIDで取得し、専用の名前で登録する。
// 読み込めないフォントを黙って別フォントに置き換えないよう、状態を管理する。
import type { CaptionStyle, FontInfo } from '../shared/types.js';
import { fontAlias, type RenderFont } from '../shared/captionRender.js';

type Status = { state: 'loading' | 'loaded' | 'error'; error?: string; promise: Promise<void> };
const status = new Map<string, Status>();
let infos = new Map<string, FontInfo>();
let onLoaded: (() => void) | null = null;

export function setFontInfos(list: FontInfo[]) {
  infos = new Map(list.map((f) => [f.id, f]));
}

export function setFontLoadedCallback(fn: () => void) {
  onLoaded = fn;
}

export function fontInfo(id: string): FontInfo | undefined {
  return infos.get(id);
}

export function fontState(id: string): Status['state'] | 'unknown' {
  return status.get(id)?.state ?? 'unknown';
}

export function fontError(id: string): string | undefined {
  return status.get(id)?.error;
}

export function ensureFont(id: string): Promise<void> {
  const s = status.get(id);
  if (s) return s.promise;
  const info = infos.get(id);
  const entry: Status = { state: 'loading', promise: Promise.resolve() };
  entry.promise = (async () => {
    try {
      if (!info) throw new Error('フォントが見つかりません(削除されたか、別のMacで作ったプロジェクトの可能性があります)');
      if (info.status !== 'ok') throw new Error(info.error ?? '読み込めないフォントです');
      const desc: FontFaceDescriptors = {};
      if (info.variable && info.weightRange) desc.weight = `${info.weightRange[0]} ${info.weightRange[1]}`;
      else desc.weight = String(info.weight);
      const ff = new FontFace(fontAlias(id), `url(/api/fonts/file?id=${encodeURIComponent(id)})`, desc);
      await ff.load();
      document.fonts.add(ff);
      entry.state = 'loaded';
    } catch (e) {
      entry.state = 'error';
      entry.error = e instanceof Error ? e.message : String(e);
    }
    onLoaded?.();
  })();
  status.set(id, entry);
  return entry.promise;
}

/** 描画に使うフォント。未読み込みなら null(代替フォントでは描かない) */
export function renderFontFor(style: CaptionStyle): RenderFont | null {
  if (fontState(style.fontId) !== 'loaded') {
    void ensureFont(style.fontId);
    return null;
  }
  const info = infos.get(style.fontId)!;
  let weight = info.weight;
  if (info.variable && info.weightRange) weight = Math.max(info.weightRange[0], Math.min(info.weightRange[1], style.weight));
  return { family: fontAlias(style.fontId), weight };
}

export function fontLabel(f: FontInfo): string {
  const name = f.familyJa ?? f.family;
  const sub = f.variable ? '可変' : f.subfamily;
  const src = f.source === 'bundled' ? '同梱' : f.source === 'project' ? 'プロジェクト' : 'Mac';
  return `${name} ${sub} (${src})${f.hasJapanese ? '' : ' ※日本語なし'}${f.status !== 'ok' ? ' ※読み込み不可' : ''}`;
}
