// 左パネル: 素材置き場とシーン一覧。
import { SR, type Asset } from '../shared/types.js';
import { captionOutputTimings, sceneOutputRanges } from '../shared/segment.js';
import { timelineOf } from '../shared/project.js';
import { mediaUrl } from './api.js';
import { button, fmtSec, h } from './dom.js';
import { assignBg, assignInOrder, importFiles, previewVersion, removeAsset } from './actions.js';
import { store } from './state.js';

const KIND_LABEL: Record<string, string> = { audio: '音声', video: '動画', image: '画像', font: 'フォント' };

export function renderLeft(el: HTMLElement, seek: (t: number) => void) {
  const ui = store.state.ui;
  const tabs = h(
    'div',
    { class: 'tabs' },
    h('button', { type: 'button', class: ui.leftTab === 'assets' ? 'on' : '', onclick: () => store.setUi({ leftTab: 'assets' }) }, `素材 (${store.p.assets.length})`),
    h('button', { type: 'button', class: ui.leftTab === 'scenes' ? 'on' : '', onclick: () => store.setUi({ leftTab: 'scenes' }) }, `シーン (${store.p.scenes.length})`),
  );
  el.replaceChildren(tabs, ui.leftTab === 'assets' ? assetsView() : scenesView(seek));
}

function assetsView(): HTMLElement {
  const p = store.p;
  const input = h('input', { type: 'file', multiple: true, accept: '.mp3,.wav,.m4a,.aac,.flac,.aif,.aiff,.mp4,.mov,.m4v,.png,.jpg,.jpeg,.webp,.gif,.heic,.ttf,.otf,.ttc', style: { display: 'none' } });
  input.addEventListener('change', () => {
    if (input.files?.length) void importFiles([...input.files]);
    input.value = '';
  });
  const drop = h('div', { class: 'dropzone' }, h('div', null, 'ここにファイルをドロップ'), h('div', { class: 'hint' }, '音声・動画・画像・フォント(TTF/OTF)'), button('素材を取り込む', () => input.click(), { class: 'primary' }), input);
  const checked = store.state.ui.checkedAssets;
  const list = h(
    'div',
    { class: 'asset-list' },
    p.assets.map((a) => assetRow(a, checked.includes(a.id))),
  );
  const actions = h(
    'div',
    { class: 'row gap' },
    button(`選択順にシーンへ仮配置 (${checked.length})`, () => assignInOrder(checked), { disabled: checked.length === 0, title: '選択した順番に、選択中のシーンから並べて配置します(内容の判断はしません)' }),
    button('選択解除', () => store.setUi({ checkedAssets: [] }), { disabled: checked.length === 0 }),
  );
  return h('div', { class: 'panel-body' }, drop, p.assets.length ? actions : null, list);
}

function assetRow(a: Asset, checked: boolean): HTMLElement {
  const p = store.p;
  const cb = h('input', { type: 'checkbox', checked, disabled: a.kind !== 'image' && a.kind !== 'video' });
  cb.addEventListener('change', () => {
    const cur = store.state.ui.checkedAssets.filter((x) => x !== a.id);
    store.setUi({ checkedAssets: cb.checked ? [...cur, a.id] : cur });
  });
  const order = store.state.ui.checkedAssets.indexOf(a.id);
  const thumb =
    a.kind === 'image' || a.kind === 'video'
      ? h('img', { class: 'thumb', src: `${mediaUrl(p.id, a.id, 'thumb')}?v=${previewVersion}`, alt: '', draggable: false, onerror: (e: Event) => ((e.target as HTMLImageElement).style.visibility = 'hidden') })
      : h('div', { class: 'thumb icon' }, a.kind === 'audio' ? '♪' : 'Aa');
  const tags: string[] = [];
  if (p.narration?.assetId === a.id) tags.push('ナレーション');
  if (p.bgm?.assetId === a.id) tags.push('BGM');
  const meta = [KIND_LABEL[a.kind], a.durationSec ? fmtSec(a.durationSec, 1) : null, a.width ? `${a.width}×${a.height}` : null].filter(Boolean).join(' / ');
  const row = h(
    'div',
    { class: 'asset' + (a.status === 'error' ? ' error' : ''), draggable: a.kind === 'image' || a.kind === 'video' },
    cb,
    order >= 0 ? h('span', { class: 'order' }, String(order + 1)) : null,
    thumb,
    h(
      'div',
      { class: 'asset-info' },
      h('div', { class: 'asset-name', title: a.name }, a.name),
      h('div', { class: 'hint' }, meta, tags.length ? h('span', { class: 'tag' }, tags.join('・')) : null),
      a.status === 'error' ? h('div', { class: 'err' }, a.error ?? '読み込めません') : null,
      a.warnings.map((w) => h('div', { class: 'warn' }, w)),
    ),
    button('×', () => void removeAsset(a), { class: 'icon-btn', title: 'プロジェクトから削除' }),
  );
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/x-tdm-asset', a.id);
    e.dataTransfer!.effectAllowed = 'copy';
  });
  return row;
}

function scenesView(seek: (t: number) => void): HTMLElement {
  const p = store.p;
  const tl = timelineOf(p);
  if (!tl || p.scenes.length === 0) return h('div', { class: 'panel-body hint' }, 'ナレーションを取り込み、自動編集を行うとシーンが作られます。');
  const ranges = sceneOutputRanges(p.scenes, tl);
  const caps = captionOutputTimings(p.captions, tl);
  const capById = new Map(p.captions.map((c) => [c.id, c]));
  const sel = store.state.ui.selection;
  const cards = p.scenes.map((s, i) => {
    const r = ranges[i]!;
    const dur = (r.outEnd - r.outStart) / SR;
    const asset = s.bg ? p.assets.find((a) => a.id === s.bg!.assetId) : null;
    const texts = caps.filter((c) => { const m = (c.outStart + c.outEnd) / 2; return m >= r.outStart && m < r.outEnd; }).map((c) => capById.get(c.id)?.text ?? '');
    const card = h(
      'div',
      { class: 'scene-card' + (sel?.kind === 'scene' && sel.id === s.id ? ' selected' : '') + (dur <= 0 ? ' empty' : '') },
      asset
        ? h('img', { class: 'thumb', src: `${mediaUrl(p.id, asset.id, 'thumb')}?v=${previewVersion}`, alt: '', draggable: false })
        : h('div', { class: 'thumb color', style: { background: p.export.bgColor } }, '背景なし'),
      h(
        'div',
        { class: 'scene-info' },
        h('div', { class: 'scene-title' }, `#${i + 1}  ${fmtSec(r.outStart / SR)}–${fmtSec(r.outEnd / SR)}`, h('span', { class: 'hint' }, ` ${dur.toFixed(1)}秒`)),
        h('div', { class: 'scene-caps' }, texts.length ? texts.join(' / ') : '(テロップなし)'),
        dur <= 0 ? h('div', { class: 'warn' }, '無音カットで長さが0になりました') : null,
      ),
    );
    card.addEventListener('click', () => {
      store.setUi({ selection: { kind: 'scene', id: s.id }, rightTab: 'selected', step: store.state.ui.step === 4 ? 4 : 3 }, 'select');
      seek(r.outStart);
    });
    card.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('text/x-tdm-asset')) {
        e.preventDefault();
        card.classList.add('drop');
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop');
      const id = e.dataTransfer?.getData('text/x-tdm-asset');
      if (id) assignBg(s.id, id);
    });
    return card;
  });
  return h('div', { class: 'panel-body' }, h('div', { class: 'hint' }, '素材をシーンにドラッグすると背景に割り当てます'), cards);
}
