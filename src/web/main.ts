// 画面の起動と全体レイアウト。
import { SR, type Project } from '../shared/types.js';
import { recomputeCut, timelineOf } from '../shared/project.js';
import { formatTime, srcToOut } from '../shared/timemap.js';
import { api } from './api.js';
import { button, fmtSec, h, mount, toast } from './dom.js';
import { importFiles, loadAnalysis } from './actions.js';
import { ensureFont, setFontInfos, setFontLoadedCallback } from './fonts.js';
import { renderLeft } from './leftPanel.js';
import { Player } from './preview.js';
import { renderRight } from './rightPanel.js';
import { store, type Step } from './state.js';
import { TimelineView } from './timeline.js';

const app = document.getElementById('app')!;

async function boot() {
  const id = new URLSearchParams(location.search).get('p');
  if (id) await openEditor(id);
  else await showHome();
}

// ---------- ホーム ----------

async function showHome() {
  document.title = '縦型動画メーカー';
  const [projects, sys] = await Promise.all([api.projects(), api.system().catch(() => null)]);
  const nameIn = h('input', { type: 'text', placeholder: '動画の名前(例: 節約術その1)' });
  const create = async () => {
    const p = await api.createProject(nameIn.value || '新しい動画');
    location.search = `?p=${p.id}`;
  };
  nameIn.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
  const envItems = sys
    ? [
        `CPU: ${sys.system.cpuModel}(${sys.system.cpuKind === 'apple-silicon' ? 'Apple Silicon' : sys.system.cpuKind === 'intel' ? 'Intel' : 'その他'})`,
        `メモリ ${sys.system.memGB}GB / 空き容量 ${sys.system.diskFreeGB ?? '?'}GB`,
        `ffmpeg: ${sys.system.tools.ffmpeg ? 'OK' : '未検出(brew install ffmpeg)'}`,
        `whisper.cpp: ${sys.system.tools.whisper ? 'OK' : '未検出(brew install whisper-cpp)'}`,
        `文字起こしモデル: ${sys.models.filter((m) => m.installed).map((m) => m.label).join('、') || '未導入(自動編集の画面からダウンロードできます)'}`,
      ]
    : ['状態を取得できませんでした'];
  mount(
    app,
    h(
      'div',
      { class: 'home' },
      h('h1', null, '縦型動画メーカー'),
      h('p', { class: 'lead' }, '読み上げ音声から、無音カット・文字起こし・テロップ・シーンを自動で作り、画像や動画をあてはめて 9:16 の動画を書き出します。'),
      h('div', { class: 'card' }, h('h2', null, '新しく作る'), h('div', { class: 'row gap' }, nameIn, button('作成', () => void create(), { class: 'primary' }))),
      h(
        'div',
        { class: 'card' },
        h('h2', null, 'プロジェクト'),
        projects.length
          ? h(
              'ul',
              { class: 'project-list' },
              projects.map((p) =>
                h(
                  'li',
                  null,
                  h('a', { href: `?p=${p.id}` }, p.name),
                  h('span', { class: 'hint' }, ' ' + new Date(p.updatedAt).toLocaleString('ja-JP')),
                  button('削除', async () => {
                    if (!confirm(`「${p.name}」を削除しますか?取り込んだ素材のコピーと書き出したファイルも消えます。`)) return;
                    await api.deleteProject(p.id);
                    void showHome();
                  }, { class: 'small danger' }),
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'まだありません'),
      ),
      h('div', { class: 'card' }, h('h2', null, 'このMacの状態'), h('ul', { class: 'env' }, envItems.map((t) => h('li', null, t))), sys ? h('p', { class: 'hint' }, `保存先: ${sys.system.dataDir}`) : null),
    ),
  );
}

// ---------- 編集画面 ----------

async function openEditor(id: string) {
  let project: Project;
  try {
    project = await api.project(id);
  } catch (e) {
    toast((e as Error).message, 'error');
    history.replaceState(null, '', location.pathname);
    return showHome();
  }
  const [fonts, presets, system] = await Promise.all([api.fonts(), api.presets(), api.system().catch(() => null)]);
  setFontInfos(fonts);
  store.init({
    project,
    analysis: null,
    fonts,
    presets,
    system,
    jobs: [],
    saveState: 'saved',
    ui: {
      step: project.narration ? (project.captions.length ? 3 : 2) : 1,
      rightTab: 'selected',
      leftTab: project.scenes.length > 1 ? 'scenes' : 'assets',
      selection: null,
      playhead: 0,
      playing: false,
      timelineView: 'output',
      selectedCandidate: null,
      checkedAssets: [],
      leftCollapsed: window.innerWidth < 1100,
      rightCollapsed: false,
    },
  });
  if (!project.asr.model && system && project.asr.quality !== system.recommend.defaultQuality && !project.transcript) {
    store.state.project = { ...project, asr: { ...project.asr, quality: system.recommend.defaultQuality } };
  }
  await loadAnalysis();
  // 無音カットの判定ルールが更新されている場合に備え、開いたときにカットを計算し直す(元に戻す履歴には積まない)
  if (store.state.analysis && project.narration) {
    const a = store.state.analysis;
    const re = recomputeCut(store.state.project, a);
    if (re.timeline?.hash !== store.state.project.timeline?.hash) store.commit(() => re, { noHistory: true });
  }
  void ensureFont(project.style.fontId);
  document.title = `${project.name} - 縦型動画メーカー`;

  const player = new Player();
  const timeline = new TimelineView();
  const header = h('header', { class: 'topbar' });
  const left = h('aside', { class: 'left' });
  const right = h('aside', { class: 'right' });
  const transport = h('div', { class: 'transport' });
  const center = h('section', { class: 'center' }, player.root, transport);
  const main = h('main', { class: 'editor' }, left, center, right);
  mount(app, h('div', { class: 'shell' }, header, main, timeline.root));

  const seek = (t: number) => player.seek(t);
  timeline.onSeek = seek;
  player.onTick = (t) => {
    timeline.follow(t);
    updateTime(t);
  };
  document.addEventListener('tdm:seek', (e) => {
    store.setUi({ step: 3 });
    seek((e as CustomEvent<number>).detail);
  });
  setFontLoadedCallback(() => {
    player.update(store.p);
    renderAll('fonts');
  });

  const timeLabel = h('span', { class: 'time' });
  const updateTime = (t: number) => {
    const tl = timelineOf(store.p);
    timeLabel.textContent = `${formatTime(t)} / ${formatTime(tl?.outSamples ?? 0)}`;
  };

  const renderHeader = () => {
    const ui = store.state.ui;
    const steps: [Step, string][] = [
      [1, '素材を取り込む'],
      [2, '自動編集'],
      [3, '確認して修正'],
      [4, '動画を書き出す'],
    ];
    const nameIn = h('input', { class: 'proj-name', type: 'text', value: store.p.name });
    nameIn.addEventListener('change', () => store.commit((p) => ({ ...p, name: nameIn.value.trim() || p.name })));
    const saveLabel = { saved: '保存済み', saving: '保存中…', dirty: '未保存の変更', error: '保存に失敗しました' }[store.state.saveState];
    mount(
      header,
      h('a', { class: 'home-link', href: './', title: 'プロジェクト一覧へ' }, '◀'),
      nameIn,
      h(
        'nav',
        { class: 'steps' },
        steps.map(([n, label]) => h('button', { type: 'button', class: ui.step === n ? 'on' : '', onclick: () => store.setUi({ step: n }) }, h('b', null, String(n)), ' ', label)),
      ),
      h('span', { class: 'spacer' }),
      button('↶', () => store.undo(), { title: '元に戻す (⌘Z)', disabled: !store.canUndo(), class: 'icon-btn' }),
      button('↷', () => store.redo(), { title: 'やり直す (⇧⌘Z)', disabled: !store.canRedo(), class: 'icon-btn' }),
      h('span', { class: 'save ' + store.state.saveState }, saveLabel),
      buildLabel(),
    );
  };

  const renderTransport = () => {
    const playing = store.state.ui.playing;
    const sel = store.state.ui.selection;
    mount(
      transport,
      button(ui_left_label(), () => store.setUi({ leftCollapsed: !store.state.ui.leftCollapsed }), { class: 'icon-btn', title: '左パネルの表示切替' }),
      button('⏮', () => seek(0), { class: 'icon-btn', title: '先頭へ' }),
      button(playing ? '⏸ 一時停止' : '▶ 再生', () => player.toggle(), { class: 'primary', title: 'スペースキーでも再生/停止' }),
      sel?.kind === 'scene'
        ? button('▶ 選択シーン', () => {
            const tl = timelineOf(store.p);
            const s = store.p.scenes.find((x) => x.id === sel.id);
            if (tl && s) void player.play(srcToOut(tl, s.srcStart), srcToOut(tl, s.srcEnd));
          })
        : null,
      timeLabel,
      h('span', { class: 'spacer' }),
      button(store.state.ui.rightCollapsed ? '設定 ◀' : '設定 ▶', () => store.setUi({ rightCollapsed: !store.state.ui.rightCollapsed }), { class: 'icon-btn', title: '右パネルの表示切替' }),
    );
    updateTime(player.currentTime());
  };
  const ui_left_label = () => (store.state.ui.leftCollapsed ? '▶ 素材' : '◀ 素材');

  let lastLeftKey = '';
  const renderAll = (reason: string) => {
    const ui = store.state.ui;
    main.classList.toggle('left-collapsed', ui.leftCollapsed);
    main.classList.toggle('right-collapsed', ui.rightCollapsed);
    renderHeader();
    renderTransport();
    if (reason === 'play') return;
    if (reason === 'seek') {
      timeline.draw();
      return;
    }
    const leftKey = JSON.stringify([ui.leftTab, ui.selection, ui.checkedAssets, store.p.assets, store.p.scenes, store.p.captions.map((c) => c.text), store.p.timeline?.hash, reason === 'preview' || reason === 'left' ? Math.random() : 0]);
    if (leftKey !== lastLeftKey) {
      lastLeftKey = leftKey;
      renderLeft(left, seek);
    }
    if (store.skipPanel !== 'right' && reason !== 'save') renderRight(right, player);
    timeline.draw();
  };

  store.subscribe((reason) => {
    if (reason === 'project' || reason === 'fonts') player.update(store.p);
    if (reason === 'select') player.render(player.currentTime());
    renderAll(reason);
  });

  // ファイルのドロップ(画面全体)
  app.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      app.classList.add('dragging');
    }
  });
  app.addEventListener('dragleave', (e) => {
    if (e.target === app || !(e.relatedTarget instanceof Node)) app.classList.remove('dragging');
  });
  app.addEventListener('drop', (e) => {
    app.classList.remove('dragging');
    if (e.dataTransfer?.files.length) {
      e.preventDefault();
      void importFiles([...e.dataTransfer.files]);
    }
  });

  // キーボード
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      store.redo();
    } else if (e.key === ' ' && !typing) {
      e.preventDefault();
      player.toggle();
    } else if (e.key === 'ArrowLeft' && !typing) {
      seek(player.currentTime() - SR * (e.shiftKey ? 1 : 0.1));
    } else if (e.key === 'ArrowRight' && !typing) {
      seek(player.currentTime() + SR * (e.shiftKey ? 1 : 0.1));
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (store.state.saveState !== 'saved') {
      void store.save();
      e.preventDefault();
    }
  });

  player.update(store.p);
  renderAll('init');
  void fmtSec;
}

// 動作確認(自動テスト)用に状態を参照できるようにする
declare global {
  interface Window {
    __tdm: { store: typeof store };
  }
}
window.__tdm = { store };

boot().catch((e) => {
  console.error(e);
  mount(app, h('div', { class: 'fatal' }, '起動に失敗しました: ' + (e as Error).message));
});

/** 今動いている版(アプリ版か、ターミナルから起動した開発版か) */
function buildLabel(): HTMLElement | null {
  const b = store.state.system?.build;
  if (!b) return null;
  const text = b.kind === 'app' ? `アプリ版 ${b.date ?? ''} ${b.commit ?? ''}`.trim() : '開発版';
  return h('span', { class: 'build-label', title: b.kind === 'app' ? `Mac アプリ版(${b.arch ?? ''})` : 'ターミナルから起動した版(git pull で最新)' }, text);
}
