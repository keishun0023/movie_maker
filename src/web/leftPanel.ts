// 左パネル: 素材置き場とシーン一覧。
import { SR, type Asset } from '../shared/types.js';
import { captionOutputTimings, sceneOutputRanges } from '../shared/segment.js';
import { timelineOf } from '../shared/project.js';
import { mediaUrl } from './api.js';
import { button, fmtSec, h } from './dom.js';
import { addFromLibrary, moveAssetsToLibrary, assignBg, assignInOrder, deleteFromLibrary, importFiles, libraryState, linkIntoLibrary, loadLibrary, pickIntoLibrary, previewVersion, removeAsset } from './actions.js';
import { api } from './api.js';
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
  const drop = h(
    'div',
    { class: 'dropzone' },
    h('div', null, 'ここにファイルをドロップ'),
    h('div', { class: 'hint' }, '音声・動画・画像は素材ライブラリに1回だけ保存し、どのプロジェクトからも使えます'),
    button('素材を取り込む', () => input.click(), { class: 'primary' }),
    h(
      'div',
      { class: 'row gap wrap' },
      button('ファイルを選ぶ(コピーしない)', () => void pickIntoLibrary('files'), { class: 'small', title: '元の場所のファイルをそのまま使います(容量を食いません)。ファイルを移動・削除すると使えなくなります' }),
      button('フォルダから(コピーしない)', () => void pickIntoLibrary('folder'), { class: 'small', title: 'フォルダの中の動画・画像・音声をまとめて追加します(コピーしません)' }),
      button('CapCut の素材から', () => toggleCapcutMedia(), { class: 'small', title: 'CapCut のプロジェクトで使っている素材を、コピーせずに追加します' }),
    ),
    input,
  );
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
  const local = p.assets.filter((a) => !a.library && a.status === 'ok' && a.kind !== 'font');
  const migrate = local.length
    ? h('div', { class: 'note' }, `このプロジェクトだけにコピーされている素材が ${local.length} 個あります。`, button('素材ライブラリに移す(容量を減らす)', () => void moveAssetsToLibrary(), { class: 'small' }))
    : null;
  return h('div', { class: 'panel-body' }, drop, capcutMediaBox(), migrate, p.assets.length ? actions : null, list, libraryBox());
}

/** 素材ライブラリ(このプロジェクトでまだ使っていない素材) */
function libraryBox(): HTMLElement {
  if (libraryState.items === null) {
    void loadLibrary();
    return h('p', { class: 'hint' }, '素材ライブラリを読み込んでいます…');
  }
  const have = new Set(store.p.assets.map((a) => a.id));
  const rest = libraryState.items.filter((a) => !have.has(a.id) && a.status === 'ok');
  return h(
    'div',
    { class: 'library' },
    h('div', { class: 'section-title' }, `素材ライブラリ(${libraryState.items.length})`),
    h('p', { class: 'hint' }, rest.length ? 'ほかのプロジェクトで取り込んだ素材です。「＋」でこのプロジェクトでも使えます(コピーはしません)。' : 'ライブラリの素材はすべてこのプロジェクトで使っています。'),
    rest.length > 1 ? button(`すべて追加 (${rest.length})`, () => addFromLibrary(rest), { class: 'small' }) : null,
    h(
      'div',
      { class: 'asset-list' },
      rest.map((a) =>
        h(
          'div',
          { class: 'asset' },
          a.kind === 'image' || a.kind === 'video'
            ? h('img', { class: 'thumb', src: `/api/library/${a.id}/thumb?v=${previewVersion}`, alt: '', draggable: false, onerror: (e: Event) => ((e.target as HTMLImageElement).style.visibility = 'hidden') })
            : h('div', { class: 'thumb icon' }, '♪'),
          h(
            'div',
            { class: 'asset-info' },
            h('div', { class: 'asset-name', title: a.linked ? a.file : a.name }, a.name),
            h('div', { class: 'hint' }, [KIND_LABEL[a.kind], a.durationSec ? fmtSec(a.durationSec, 1) : null, a.linked ? '元の場所' : null].filter(Boolean).join(' / ')),
          ),
          button('＋', () => addFromLibrary([a]), { class: 'icon-btn', title: 'このプロジェクトで使う' }),
          button('🗑', () => void deleteFromLibrary(a), { class: 'icon-btn', title: 'ライブラリから削除' }),
        ),
      ),
    ),
  );
}

// CapCut で使っている素材の一覧(開いているときだけ)
let capcutMedia: { open: boolean; files: { file: string; name: string; size: number; drafts: string[]; inLibrary: boolean }[] | null; checked: Set<string> } = { open: false, files: null, checked: new Set() };

function toggleCapcutMedia() {
  capcutMedia = { open: !capcutMedia.open, files: null, checked: new Set() };
  store.emit('left');
  if (capcutMedia.open) {
    void api.libraryCapcut((store.p.export.capcutDir ?? '').trim() || undefined).then((r) => {
      capcutMedia.files = r.files;
      store.emit('left');
    }).catch((e) => {
      capcutMedia.files = [];
      store.emit('left');
      void e;
    });
  }
}

function capcutMediaBox(): HTMLElement | null {
  if (!capcutMedia.open) return null;
  const files = capcutMedia.files;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)}MB`;
  return h(
    'div',
    { class: 'note' },
    h('div', { class: 'section-title' }, 'CapCut の素材から追加(コピーしない)'),
    files === null
      ? h('p', { class: 'hint' }, 'CapCut のプロジェクトを調べています…')
      : files.length === 0
        ? h('p', { class: 'hint' }, 'CapCut のプロジェクトで使っている素材が見つかりませんでした。')
        : h(
            'div',
            null,
            h('p', { class: 'hint' }, 'CapCut と同じファイルをそのまま使うので、容量は増えません。'),
            h(
              'div',
              { class: 'capcut-media' },
              files.map((f) => {
                const cb = h('input', { type: 'checkbox', checked: capcutMedia.checked.has(f.file), disabled: f.inLibrary });
                cb.addEventListener('change', () => (cb.checked ? capcutMedia.checked.add(f.file) : capcutMedia.checked.delete(f.file)));
                return h('label', { class: 'row gap', title: f.file }, cb, h('span', null, f.name), h('span', { class: 'hint' }, ` ${mb(f.size)}・${f.inLibrary ? '追加済み' : f.drafts.slice(0, 2).join('、')}`));
              }),
            ),
            h(
              'div',
              { class: 'row gap' },
              button('選んだ素材を追加', () => {
                const paths = [...capcutMedia.checked];
                if (!paths.length) return;
                capcutMedia.open = false;
                void linkIntoLibrary(paths);
              }, { class: 'primary small' }),
              button('閉じる', () => toggleCapcutMedia(), { class: 'small' }),
            ),
          ),
  );
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
        h('div', { class: 'scene-title' }, `#${i + 1}  ${fmtSec(r.outStart / SR)}–${fmtSec(r.outEnd / SR)}`, h('span', { class: 'hint' }, ` ${dur.toFixed(1)}秒`), s.speed && s.speed !== 1 ? h('span', { class: 'tag' }, `${s.speed}倍`) : null),
        h('div', { class: 'scene-caps' }, texts.length ? texts.join(' / ') : '(テロップなし)'),
        dur <= 0 ? h('div', { class: 'warn' }, '無音カットで長さが0になりました') : null,
        s.aiNote ? h('div', { class: 'hint' }, `🤖 ${s.aiNote}`) : null,
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
