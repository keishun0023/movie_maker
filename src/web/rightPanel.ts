// 右パネル: 手順ごとの設定(取り込み / 自動編集 / 確認して修正 / 書き出し)。
import { SR, type Asset, type Caption, type CaptionStyle, type CutParams, type CutPresetId, type Project, type Scene } from '../shared/types.js';
import { CUT_PRESETS } from '../shared/silence.js';
import { presetParams, splitScenesToCutLength, timelineOf } from '../shared/project.js';
import { captionOutputTimings, sceneOutputRanges } from '../shared/segment.js';
import { suggestFromScript } from '../shared/script.js';
import { DEFAULT_STYLE, effectiveStyle } from '../shared/captionRender.js';
import { outToSrc, srcToOut } from '../shared/timemap.js';
import { api, mediaUrl } from './api.js';
import { button, checkbox, colorInput, field, fmtBytes, fmtSec, h, numInput, select, slider, toast } from './dom.js';
import {
  addCaptionAt,
  applyCutChange,
  cancelJob,
  checkExport,
  deleteCaption,
  downloadModel,
  mergeCaptionWithNext,
  mergeScene,
  rebuildCaptions,
  runAiAssign,
  runAutoEdit,
  selectedModelId,
  setNarration,
  splitCaption,
  splitSceneAt,
  startExport,
  updateCaption,
  updateScene,
} from './actions.js';
import { ensureFont, fontLabel } from './fonts.js';
import type { Player } from './preview.js';
import { store } from './state.js';

let exportsCache: { name: string; size: number; mtime: string }[] = [];
let exportCheck: { errors: string[]; warnings: string[] } | null = null;

export function renderRight(el: HTMLElement, player: Player) {
  const step = store.state.ui.step;
  const body = step === 1 ? importView() : step === 2 ? autoView(player) : step === 3 ? editView(player) : exportView(player);
  el.replaceChildren(body);
}

function section(title: string, ...children: (Node | null | false | undefined)[]): HTMLElement {
  return h('section', { class: 'sec' }, h('h3', null, title), ...children);
}

function jobsBox(types: string[]): HTMLElement | null {
  const jobs = store.state.jobs.filter((j) => types.includes(j.type) && (j.status === 'queued' || j.status === 'running' || j.status === 'failed'));
  if (!jobs.length) return null;
  return h(
    'div',
    { class: 'jobs' },
    jobs.map((j) =>
      h(
        'div',
        { class: 'job ' + j.status },
        h('div', { class: 'job-label' }, j.label),
        h('div', { class: 'progress' }, h('div', { class: 'bar', style: { width: `${Math.round(j.progress * 100)}%` } })),
        h('div', { class: 'hint' }, j.status === 'failed' ? `失敗: ${j.error ?? ''}` : j.message),
        j.status === 'failed'
          ? button('閉じる', () => {
              store.state.jobs = store.state.jobs.filter((x) => x.id !== j.id);
              store.emit('jobs');
            }, { class: 'small' })
          : null,
        j.status === 'failed'
          ? button('再試行', async () => {
              // 文字起こし・素材の割り当ては「いまの設定」でやり直す(選び直したモデルなどを反映するため)
              if (j.type === 'transcribe' || j.type === 'ai-assign') {
                store.state.jobs = store.state.jobs.filter((x) => x.id !== j.id);
                store.emit('jobs');
                if (j.type === 'transcribe') void runAutoEdit();
                else void runAiAssign();
                return;
              }
              try {
                const nj = await api.retryJob(j.id);
                store.state.jobs = store.state.jobs.filter((x) => x.id !== j.id);
                const { watchJob } = await import('./actions.js');
                watchJob(nj);
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            })
          : button('キャンセル', () => void cancelJob(j.id)),
      ),
    ),
  );
}

// ---------- 1. 素材を取り込む ----------

function importView(): HTMLElement {
  const p = store.p;
  const sys = store.state.system;
  const audioAssets = p.assets.filter((a) => a.status === 'ok' && (a.kind === 'audio' || (a.kind === 'video' && (a.audioStreams?.length ?? 0) > 0)));
  const narr = p.narration;
  const narrAsset = narr ? p.assets.find((a) => a.id === narr.assetId) : null;
  let chosen = narrAsset?.id ?? audioAssets[audioAssets.length - 1]?.id ?? '';
  let track = narr?.audioIndex ?? 0;
  const trackSel = h('div');
  const renderTrack = () => {
    const a = p.assets.find((x) => x.id === chosen);
    const streams = a?.audioStreams ?? [];
    trackSel.replaceChildren(
      streams.length > 1
        ? field(
            '音声トラック',
            select(String(track), streams.map((s) => [String(s.audioIndex), `トラック${s.audioIndex + 1} (${s.codec} ${s.channels}ch${s.language && s.language !== 'und' ? ' ' + s.language : ''}${s.title ? ' ' + s.title : ''})`] as [string, string]), (v) => (track = Number(v))),
          )
        : h('span'),
    );
  };
  renderTrack();
  const narrSection = section(
    'ナレーション音声',
    h('p', { class: 'hint' }, 'CapCut や TikTok で作った読み上げ音声(MP3/WAV/M4A)または動画(MP4/MOV)を左の素材置き場に取り込み、ここで選びます。'),
    h('p', { class: 'note' }, '💡 BGMが混ざっていると無音カットと文字起こしの精度が落ちます。できればナレーションだけの音声を取り込んでください。BGMは後から追加できます。'),
    audioAssets.length
      ? h(
          'div',
          null,
          field('使う素材', select(chosen, audioAssets.map((a) => [a.id, a.name] as [string, string]), (v) => {
            chosen = v;
            track = 0;
            renderTrack();
          })),
          trackSel,
          button(narr ? 'この音声でナレーションを設定し直す' : 'この音声をナレーションにする', () => {
            const a = p.assets.find((x) => x.id === chosen);
            if (a) void setNarration(a, track);
          }, { class: 'primary' }),
        )
      : h('p', { class: 'warn' }, 'まだ音声・動画の素材がありません。'),
    narr && narrAsset
      ? h('div', { class: 'ok-box' }, `設定済み: ${narrAsset.name} / 長さ ${fmtSec(narr.durationSamples / SR)}`, narr.warnings.map((w) => h('div', { class: 'warn' }, w)))
      : null,
    jobsBox(['narration', 'preview']),
  );
  const scriptArea = h('textarea', { rows: 5, placeholder: '(任意)元の台本を貼り付けると、固有名詞・数字の認識のヒントと表記確認に使います。台本の文章をそのまま字幕に入れることはしません。' });
  scriptArea.value = p.script;
  scriptArea.addEventListener('input', () => store.commit((pp) => ({ ...pp, script: scriptArea.value }), { coalesce: 'script', skip: 'right' }));
  const scriptSection = section('台本(任意)', scriptArea, checkbox(p.useScriptHints, '台本の語句を文字起こしのヒントに使う', (v) => store.commit((pp) => ({ ...pp, useScriptHints: v }))));
  const envSection = sys
    ? section(
        'このMacの状態',
        h(
          'ul',
          { class: 'env' },
          h('li', null, `CPU: ${sys.system.cpuModel}(${sys.system.cpuKind === 'apple-silicon' ? 'Apple Silicon' : sys.system.cpuKind === 'intel' ? 'Intel' : 'その他'}${sys.system.rosetta ? '・Rosetta経由' : ''})`),
          h('li', null, `メモリ: ${sys.system.memGB} GB / 空き容量: ${sys.system.diskFreeGB ?? '?'} GB`),
          h('li', { class: sys.system.tools.ffmpeg ? '' : 'err' }, `ffmpeg: ${sys.system.tools.ffmpeg ? `OK (${sys.system.ffmpegVersion ?? ''})` : '見つかりません → brew install ffmpeg'}`),
          h('li', { class: sys.system.tools.whisper ? '' : 'err' }, `whisper.cpp: ${sys.system.tools.whisper ? 'OK' : '見つかりません → brew install whisper-cpp'}`),
        ),
      )
    : null;
  return h('div', { class: 'panel-body' }, narrSection, scriptSection, envSection, button('次へ: 自動編集 →', () => store.setUi({ step: 2 }), { class: 'next', disabled: !narr }));
}

// ---------- 2. 自動編集 ----------

const PARAM_DEFS: [keyof CutParams, string, number, number, number, string][] = [
  ['minSilenceMs', 'この長さ以上の無音を対象', 50, 1500, 10, 'ms'],
  ['keepMs', '縮めた後に残す間', 0, 1000, 10, 'ms'],
  ['padBeforeMs', '話し始めの保護余白', 0, 300, 5, 'ms'],
  ['padAfterMs', '語尾の保護余白', 0, 400, 5, 'ms'],
  ['headMs', '冒頭に残す無音', 0, 1000, 10, 'ms'],
  ['tailMs', '末尾に残す無音', 0, 2000, 10, 'ms'],
  ['sensitivityDb', '無音判定の感度(+で大きめの音も無音扱い)', -15, 15, 1, 'dB'],
  ['overlapMs', '被せ(語尾・語頭に食い込んで重ねる量)', 0, 200, 5, 'ms'],
  ['fadeMs', '接合点のフェード', 0, 30, 1, 'ms'],
];

function autoView(player: Player): HTMLElement {
  const p = store.p;
  const sys = store.state.system;
  const tl = timelineOf(p);
  const presetRow = h(
    'div',
    { class: 'seg-buttons' },
    (['tsuratsura', 'jumpcut', 'tempo', 'natural', 'custom'] as CutPresetId[]).map((id) =>
      h(
        'button',
        {
          type: 'button',
          class: p.cut.preset === id ? 'on' : '',
          onclick: () => applyCutChange((pp) => ({ ...pp, cut: { ...pp.cut, preset: id, params: presetParams(id, pp.cut.params) } })),
        },
        id === 'custom' ? 'カスタム' : CUT_PRESETS[id].label,
      ),
    ),
  );
  const params = h(
    'div',
    { class: 'params' + (p.cut.preset === 'custom' ? '' : ' readonly') },
    PARAM_DEFS.map(([k, label, min, max, stepv, unit]) =>
      field(
        label,
        slider(p.cut.params[k], {
          min,
          max,
          step: stepv,
          format: (v) => `${v}${unit}`,
          onChange: (v) => applyCutChange((pp) => ({ ...pp, cut: { ...pp.cut, preset: 'custom', params: { ...pp.cut.params, [k]: v } } }), 'cut-' + k),
        }),
      ),
    ),
  );
  const cutCount = tl ? tl.segments.length - 1 + (tl.segments[0]?.srcStart ? 1 : 0) : 0;
  const summary = tl
    ? h('div', { class: 'ok-box' }, `元の長さ ${fmtSec(tl.srcSamples / SR)} → 編集後 ${fmtSec(tl.outSamples / SR)}(${cutCount}か所カット、${((1 - tl.outSamples / Math.max(1, tl.srcSamples)) * 100).toFixed(0)}%短縮)`)
    : h('p', { class: 'warn' }, '先に「1 素材を取り込む」でナレーションを設定してください。');
  const protectedN = p.silenceCandidates.filter((c) => c.protectedBySpeech).length;
  const keptN = p.cut.keepRanges.length;
  const protectBox = h(
    'div',
    null,
    protectedN || p.cut.protectSpeech === false
      ? h('p', { class: 'hint' }, p.cut.protectSpeech === false ? '発話保護は無効です(黄色の間も詰めます)。' : `発話の可能性があるため残した間: ${protectedN} か所(タイムラインの「元音声」で黄色)`)
      : null,
    keptN ? h('p', { class: 'hint' }, `「この間は残す」を指定した間: ${keptN} か所(緑)`, button('指定をすべて解除', () => applyCutChange((pp) => ({ ...pp, cut: { ...pp.cut, keepRanges: [] } })), { class: 'small' })) : null,
    checkbox(p.cut.protectSpeech !== false, '小声の発話かもしれない間は削らない(発話保護)', (v) => applyCutChange((pp) => ({ ...pp, cut: { ...pp.cut, protectSpeech: v } }))),
  );
  const selCand = store.state.ui.selectedCandidate ? p.silenceCandidates.find((c) => c.id === store.state.ui.selectedCandidate) : null;
  const compare = selCand && tl
    ? h(
        'div',
        { class: 'compare' },
        h('div', { class: 'hint' }, `選択中の間: ${fmtSec(selCand.start / SR)}〜${fmtSec(selCand.end / SR)}(${((selCand.end - selCand.start) / SR).toFixed(2)}秒)${selCand.protectedBySpeech ? ' ※発話の可能性があるため削っていません' : ''}`),
        button('▶ カット前', () => void player.playSource(Math.max(0, selCand.start - SR), Math.min(tl.srcSamples, selCand.end + SR))),
        button('▶ カット後', () => {
          const o0 = srcToOut(tl, selCand.start);
          const o1 = srcToOut(tl, selCand.end);
          void player.play(Math.max(0, o0 - SR), Math.min(tl.outSamples, o1 + SR));
        }),
      )
    : h('p', { class: 'hint' }, 'タイムラインを「元音声(カット確認)」にすると、無音候補をクリックして「この間は残す」を切り替えたり、カット前後を聞き比べたりできます。');
  const cutSection = section(
    '無音カット',
    h('p', { class: 'hint' }, '「即カット」は無音が来たらすぐ切ります(語頭・語尾を守る数十msだけ残します)。「つらつら(被せ)」はさらに語尾の余韻や語頭に少し食い込んで、前後をクロスフェードで重ねてつなぎます。話す速さはシーンごとに「確認して修正」で変えられます。'),
    presetRow,
    params,
    summary,
    protectBox,
    button('タイムラインで元音声を表示', () => store.setUi({ timelineView: 'source' })),
    compare,
  );

  // 文字起こし
  const modelId = selectedModelId();
  const models = sys?.models ?? [];
  const model = models.find((m) => m.id === modelId);
  const whisperBox = h(
    'div',
    null,
    sys && !sys.asrAvailable ? h('p', { class: 'err' }, 'whisper.cpp が見つかりません。README のセットアップ手順(brew install whisper-cpp)を実行してください。') : null,
    h(
      'div',
      { class: 'seg-buttons' },
      h('button', { type: 'button', class: p.asr.quality === 'speed' && !p.asr.model ? 'on' : '', onclick: () => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, quality: 'speed', model: null } })) }, '速度重視'),
      h('button', { type: 'button', class: p.asr.quality === 'accuracy' && !p.asr.model ? 'on' : '', onclick: () => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, quality: 'accuracy', model: null } })) }, '精度重視'),
    ),
    sys ? h('p', { class: 'hint' }, sys.recommend.reason) : null,
    field(
      'モデル',
      select(modelId ?? '', models.map((m) => [m.id, `${m.label}${m.installed ? '' : '(未導入)'}`] as [string, string]), (v) => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, model: v } }))),
      model ? `${model.note} 約${model.sizeMB}MB` : undefined,
    ),
    model && !model.installed
      ? h(
          'div',
          { class: 'note' },
          `このモデルは初回だけダウンロードが必要です(約${model.sizeMB}MB、保存先: ${model.path})。音声データは送信しません。`,
          h('div', null, button('モデルをダウンロード', () => void downloadModel(model.id), { class: 'primary' })),
        )
      : null,
    jobsBox(['model-download']),
    checkbox(p.asr.dtw, 'DTWでトークン時刻を推定する(実験的・精度が上がる場合があります)', (v) => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, dtw: v } }))),
  );
  const gemini = p.asr.engine === 'gemini';
  const asrSection = section(
    '文字起こし',
    h(
      'div',
      { class: 'seg-buttons' },
      h('button', { type: 'button', class: !gemini ? 'on' : '', onclick: () => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, engine: 'whisper' } })) }, 'ローカル(whisper.cpp)'),
      h('button', { type: 'button', class: gemini ? 'on' : '', onclick: () => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, engine: 'gemini' } })) }, 'Gemini API(クラウド)'),
    ),
    gemini ? geminiBox(p) : whisperBox,
  );
  const run = section(
    '実行',
    button('自動編集を実行(文字起こし → カット → シーン・テロップ)', () => void runAutoEdit(), { class: 'primary big', disabled: !p.narration || (gemini ? !p.asr.cloudConsent || !geminiState.keySource : !model?.installed) }),
    jobsBox(['transcribe']),
    p.transcript
      ? h(
          'div',
          { class: 'ok-box' },
          `文字起こし済み(${p.transcript.model}、${p.transcript.tokens.length}語)`,
          p.transcript.notes.map((n) => h('div', { class: 'hint' }, n)),
        )
      : null,
    p.transcript
      ? h(
          'div',
          { class: 'row gap wrap' },
          button('テロップ・シーンを作り直す(手動修正は保持)', () => rebuildCaptions(true)),
          button('すべて作り直す', () => rebuildCaptions(false)),
          gemini ? null : button('編集後の音声で再認識', () => void runAutoEdit({ basis: 'edited' }), { title: '無音カット後の音声で認識し直し、時刻を元音声に戻して使います' }),
        )
      : null,
    h('p', { class: 'hint' }, 'ナレーションだけで字幕なしの動画や、手入力のテロップで作る場合は、文字起こしをせずに「3 確認して修正」へ進めます。'),
  );
  return h('div', { class: 'panel-body' }, cutSection, asrSection, sceneLenSection(p), run, aiAssignSection(p), button('次へ: 確認して修正 →', () => store.setUi({ step: 3 }), { class: 'next' }));
}

// Gemini の設定状態(APIキーそのものは画面に返さない)
const geminiState: { loaded: boolean; keySource: 'env' | 'file' | null; anthropicKeySource: 'env' | 'file' | null; models: string[]; loading: boolean } = { loaded: false, keySource: null, anthropicKeySource: null, models: [], loading: false };

function loadSettings() {
  if (geminiState.loaded || geminiState.loading) return;
  geminiState.loading = true;
  void api.settings().then((r) => {
    geminiState.keySource = r.geminiKeySource;
    geminiState.anthropicKeySource = r.anthropicKeySource;
    geminiState.loaded = true;
    geminiState.loading = false;
    store.emit('settings');
  }).catch(() => (geminiState.loading = false));
}

function geminiBox(p: Project): HTMLElement {
  if (!geminiState.loaded && !geminiState.loading) {
    geminiState.loading = true;
    void api.settings().then((r) => {
      geminiState.keySource = r.geminiKeySource;
      geminiState.anthropicKeySource = r.anthropicKeySource;
      geminiState.loaded = true;
      geminiState.loading = false;
      store.emit('settings');
    }).catch(() => (geminiState.loading = false));
  }
  const keyIn = h('input', { type: 'password', placeholder: 'Google AI Studio で発行したキーを貼り付け', autocomplete: 'off' });
  const saveKey = async (k: string | null) => {
    try {
      const r = await api.setGeminiKey(k);
      geminiState.keySource = r.geminiKeySource;
      toast(k ? 'APIキーを保存しました(このMacのデータフォルダに保存。プロジェクトには含めません)' : 'APIキーを削除しました', 'ok');
      store.emit('settings');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const models = [...geminiState.models];
  if (p.asr.geminiModel !== 'auto' && !models.includes(p.asr.geminiModel)) models.unshift(p.asr.geminiModel);
  return h(
    'div',
    null,
    h('p', { class: 'hint' }, '日本語の聞き取り精度を上げたいときに使います。文字は Gemini、表示のタイミングは無音で区切った話の切れ目(音量解析)で決めます。利用料は Google の料金体系に従います(Claude の契約とは別です)。'),
    section(
      'APIキー',
      geminiState.keySource === 'env'
        ? h('div', { class: 'ok-box' }, '環境変数 GEMINI_API_KEY のキーを使います')
        : geminiState.keySource === 'file'
          ? h('div', { class: 'ok-box' }, '設定済み ', button('削除', () => void saveKey(null), { class: 'small' }))
          : h('div', null, h('div', { class: 'row gap' }, keyIn, button('保存', () => void saveKey(keyIn.value.trim() || null), { class: 'primary' })), h('p', { class: 'hint' }, 'キーは https://aistudio.google.com/apikey で発行できます。project.json やログには保存しません。')),
    ),
    field(
      'モデル',
      h(
        'div',
        { class: 'row gap' },
        select(p.asr.geminiModel, [['auto', '自動(最新の flash)'] as [string, string], ...models.map((m) => [m, m] as [string, string])], (v) => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, geminiModel: v } }))),
        button('モデル一覧を取得', async () => {
          try {
            geminiState.models = await api.geminiModels();
            store.emit('settings');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }, { disabled: !geminiState.keySource }),
      ),
      '「自動」は実行時に最新の flash モデルを選びます。flash 系は速く安価、pro 系はより高精度です',
    ),
    h(
      'div',
      { class: 'note' },
      h('b', null, '送信される内容: '),
      'このプロジェクトのナレーション音声(無音で区切った音声片、16kHz モノラル)',
      p.useScriptHints && p.script.trim() ? 'と、台本から抜き出した語句ヒント' : '',
      '。背景の画像・動画・BGM は送信しません。',
      checkbox(p.asr.cloudConsent, 'このプロジェクトの音声を Google Gemini API に送信することに同意する', (v) => store.commit((pp) => ({ ...pp, asr: { ...pp.asr, cloudConsent: v } }))),
    ),
  );
}

/** 1カットの長さ */
function sceneLenSection(p: Project): HTMLElement {
  const presets: [string, number, number][] = [
    ['1〜2秒(テンポ重視)', 1, 2],
    ['2〜3秒', 2, 3],
    ['2〜5秒(標準)', 2, 5],
  ];
  const cur = presets.find(([, a, b]) => a === p.sceneLen.minSec && b === p.sceneLen.maxSec);
  return section(
    '1カットの長さ',
    h(
      'div',
      { class: 'seg-buttons' },
      presets.map(([label, a, b]) =>
        h('button', { type: 'button', class: cur?.[1] === a && cur?.[2] === b ? 'on' : '', onclick: () => store.commit((pp) => splitScenesToCutLength({ ...pp, sceneLen: { minSec: a, maxSec: b } })) }, label),
      ),
    ),
    h('p', { class: 'hint' }, '背景を切り替える間隔の目安です。自動編集(または下の「テロップ・シーンを作り直す」)のときに反映されます。長い文でも、この長さを超えるカットは語の切れ目で分けます。'),
  );
}

/** Claude による素材の自動割り当て */
function aiAssignSection(p: Project): HTMLElement {
  loadSettings();
  const visual = p.assets.filter((a) => a.status === 'ok' && (a.kind === 'image' || a.kind === 'video') && a.id !== p.narration?.assetId);
  const chosen = new Set(p.aiAssign.assetIds.length ? p.aiAssign.assetIds : visual.map((a) => a.id));
  const keyIn = h('input', { type: 'password', placeholder: 'sk-ant-… (Claude Console で発行)', autocomplete: 'off' });
  const saveKey = async (k: string | null) => {
    try {
      const r = await api.setAnthropicKey(k);
      geminiState.anthropicKeySource = r.anthropicKeySource;
      toast(k ? 'APIキーを保存しました(このMacのデータフォルダに保存。プロジェクトには含めません)' : 'APIキーを削除しました', 'ok');
      store.emit('settings');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    const ids = next.size === visual.length ? [] : [...next];
    store.commit((pp) => ({ ...pp, aiAssign: { ...pp.aiAssign, assetIds: ids } }));
  };
  const nFrames = visual.filter((a) => chosen.has(a.id)).length;
  const ready = !!geminiState.anthropicKeySource && p.aiAssign.consent && p.scenes.length > 0 && nFrames > 0;
  return section(
    'Claude で素材を割り当てる(任意)',
    h('p', { class: 'hint' }, '取り込んだ画像・動画の中身を Claude が見て、各カットで話している内容に合う素材と、動画のどの場面から使うかを選びます。結果は提案なので、あとから自由に変えられます(元に戻す も可)。'),
    geminiState.anthropicKeySource === 'env'
      ? h('div', { class: 'ok-box' }, '環境変数 ANTHROPIC_API_KEY のキーを使います')
      : geminiState.anthropicKeySource === 'file'
        ? h('div', { class: 'ok-box' }, 'Claude APIキー: 設定済み ', button('削除', () => void saveKey(null), { class: 'small' }))
        : h('div', null, h('div', { class: 'row gap' }, keyIn, button('保存', () => void saveKey(keyIn.value.trim() || null), { class: 'primary' })), h('p', { class: 'hint' }, 'キーは https://platform.claude.com の API Keys で発行できます。利用料は Claude API の従量課金です(Claude の月額プランとは別)。')),
    visual.length
      ? field('使う素材', h('div', { class: 'ai-assets' }, visual.map((a) => checkbox(chosen.has(a.id), `${a.kind === 'video' ? '🎞' : '🖼'} ${a.name}`, (v) => toggle(a.id, v)))))
      : h('p', { class: 'warn' }, '画像・動画の素材がまだありません。'),
    h(
      'div',
      { class: 'note' },
      h('b', null, '送信される内容: '),
      `選んだ素材のフレーム画像(動画は数枚ずつ、長辺384px)、各カットのテロップの文章${p.script.trim() ? '、台本' : ''}。音声や元のファイルそのものは送りません。`,
      checkbox(p.aiAssign.consent, 'これらを Claude API(Anthropic)に送信することに同意する', (v) => store.commit((pp) => ({ ...pp, aiAssign: { ...pp.aiAssign, consent: v } }))),
    ),
    (() => {
      const n = splitScenesToCutLength(p).scenes.length;
      return h(
        'div',
        null,
        p.captions.length === 0
          ? h('p', { class: 'warn' }, '⚠ まだ自動編集(文字起こし)をしていないため、テロップがありません。このままだと話の内容で素材を選べないので、先に上の「自動編集を実行」を押してください。')
          : null,
        n !== p.scenes.length ? h('p', { class: 'note' }, `今のカットは ${p.scenes.length} 個です。「1カットの長さ」に合わせて ${n} 個に分けてから割り当てます。`) : null,
        button(`Claude で ${n} カットに素材を割り当てる`, () => void runAiAssign(), { class: 'primary big', disabled: !ready }),
      );
    })(),
    jobsBox(['ai-assign']),
  );
}

// ---------- 3. 確認して修正 ----------

function editView(player: Player): HTMLElement {
  const tab = store.state.ui.rightTab;
  const tabs = h(
    'div',
    { class: 'tabs' },
    h('button', { type: 'button', class: tab === 'selected' ? 'on' : '', onclick: () => store.setUi({ rightTab: 'selected' }) }, '選択中'),
    h('button', { type: 'button', class: tab === 'style' ? 'on' : '', onclick: () => store.setUi({ rightTab: 'style' }) }, 'テロップ共通'),
    h('button', { type: 'button', class: tab === 'audio' ? 'on' : '', onclick: () => store.setUi({ rightTab: 'audio' }) }, 'BGM・音量'),
  );
  const body = tab === 'selected' ? selectedView(player) : tab === 'style' ? styleView() : audioView();
  return h('div', { class: 'panel-body' }, tabs, body, button('次へ: 動画を書き出す →', () => store.setUi({ step: 4 }), { class: 'next' }));
}

function selectedView(player: Player): HTMLElement {
  const sel = store.state.ui.selection;
  const p = store.p;
  if (sel?.kind === 'scene') {
    const s = p.scenes.find((x) => x.id === sel.id);
    if (s) return sceneInspector(s, player);
  }
  if (sel?.kind === 'caption') {
    const c = p.captions.find((x) => x.id === sel.id);
    if (c) return captionInspector(c, player);
  }
  return h(
    'div',
    null,
    h('p', { class: 'hint' }, 'タイムラインやシーン一覧でシーン・テロップを選ぶと、ここで編集できます。プレビューのテロップはドラッグで全テロップの位置を変えられます(⌥Option を押しながらだとそのテロップだけ)。'),
    button('再生位置にテロップを追加', () => addCaptionAt(store.state.ui.playhead)),
    button('再生位置でシーンを分割', () => splitSceneAt(store.state.ui.playhead)),
  );
}

function sceneInspector(s: Scene, player: Player): HTMLElement {
  const p = store.p;
  const tl = timelineOf(p);
  const idx = p.scenes.findIndex((x) => x.id === s.id);
  const r = tl ? sceneOutputRanges(p.scenes, tl)[idx] : null;
  const visual = p.assets.filter((a) => a.status === 'ok' && (a.kind === 'image' || a.kind === 'video'));
  const images = p.assets.filter((a) => a.status === 'ok' && a.kind === 'image');
  const bg = s.bg;
  const asset = bg ? p.assets.find((a) => a.id === bg.assetId) : null;
  const up = (fn: (sc: Scene) => Scene, key?: string) => updateScene(s.id, fn, key);
  const setBg = (patch: Partial<NonNullable<Scene['bg']>>, key?: string) => up((sc) => (sc.bg ? { ...sc, bg: { ...sc.bg, ...patch } } : sc), key);
  const bgFields = bg && asset
    ? h(
        'div',
        null,
        field('表示方法', select(bg.fit, [['cover', '画面いっぱい'], ['contain', '全体を表示']], (v) => setBg({ fit: v }))),
        field('拡大率', slider(bg.zoom, { min: 0.5, max: 3, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => setBg({ zoom: v }, 'zoom') })),
        field('左右の位置', slider(bg.offsetX, { min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2), onChange: (v) => setBg({ offsetX: v }, 'ox') })),
        field('上下の位置', slider(bg.offsetY, { min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2), onChange: (v) => setBg({ offsetY: v }, 'oy') })),
        asset.kind === 'video'
          ? h(
              'div',
              null,
              p.narration?.assetId === asset.id
                ? field('同期', select(bg.mode, [['synced', '元動画と同期(無音カットを映像にも適用)'], ['independent', '独立した背景素材として使う']], (v) => setBg({ mode: v, audio: v === 'synced' ? false : bg.audio })))
                : null,
              bg.mode === 'independent'
                ? h(
                    'div',
                    null,
                    field('使用開始位置(秒)', numInput(bg.startSec, { min: 0, max: asset.durationSec ?? 3600, step: 0.1, onChange: (v) => setBg({ startSec: v }) })),
                    field('シーンより短いとき', select(bg.shortMode, [['freeze', '最後のフレームで静止'], ['loop', 'ループ']], (v) => setBg({ shortMode: v }))),
                    checkbox(bg.audio, '素材の元音声を使う(初期はミュート)', (v) => setBg({ audio: v }), !(asset.audioStreams?.length)),
                    bg.audio ? field('素材音声の音量', slider(bg.volumeDb, { min: -40, max: 6, step: 1, format: (v) => `${v}dB`, onChange: (v) => setBg({ volumeDb: v }, 'bgvol') })) : null,
                  )
                : null,
            )
          : checkbox(bg.kenBurns, 'ゆっくりズーム', (v) => setBg({ kenBurns: v })),
      )
    : null;
  const inset = s.inset;
  const setInset = (patch: Partial<NonNullable<Scene['inset']>>, key?: string) => up((sc) => (sc.inset ? { ...sc, inset: { ...sc.inset, ...patch } } : sc), key);
  const dur = r ? (r.outEnd - r.outStart) / SR : 0;
  return h(
    'div',
    null,
    h('h3', null, `シーン #${idx + 1}`),
    s.aiNote ? h('p', { class: 'note' }, `Claude の提案理由: ${s.aiNote}`) : null,
    r ? h('p', { class: 'hint' }, `${fmtSec(r.outStart / SR)} – ${fmtSec(r.outEnd / SR)}(${dur.toFixed(2)}秒)`) : null,
    h(
      'div',
      { class: 'row gap wrap' },
      button('▶ このシーンを再生', () => r && void player.play(r.outStart, r.outEnd)),
      button('再生位置で分割', () => splitSceneAt(store.state.ui.playhead)),
      button('前と結合', () => mergeScene(s.id, -1), { disabled: idx === 0 }),
      button('次と結合', () => mergeScene(s.id, 1), { disabled: idx === p.scenes.length - 1 }),
    ),
    speedSection(s),
    section(
      '背景',
      field(
        '素材',
        select(bg?.assetId ?? '', [['', '(なし・単色背景)'], ...visual.map((a) => [a.id, `${a.kind === 'video' ? '🎞' : '🖼'} ${a.name}`] as [string, string])], (v) => {
          const a = p.assets.find((x) => x.id === v);
          if (!a) up((sc) => ({ ...sc, bg: null }));
          else import('./actions.js').then(({ assignBg }) => assignBg(s.id, a.id));
        }),
        '左の素材をシーン一覧のカードへドラッグしても割り当てられます',
      ),
      bgFields,
    ),
    section(
      '差し込み画像(1枚)',
      field(
        '画像',
        select(inset?.assetId ?? '', [['', '(なし)'], ...images.map((a) => [a.id, a.name] as [string, string])], (v) =>
          up((sc) => ({ ...sc, inset: v ? { assetId: v, x: 0.5, y: 0.7, width: 0.45, startSec: 0, endSec: null } : null })),
        ),
      ),
      inset
        ? h(
            'div',
            null,
            field('横位置(中心)', slider(inset.x, { min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => setInset({ x: v }, 'ix') })),
            field('縦位置(中心)', slider(inset.y, { min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => setInset({ y: v }, 'iy') })),
            field('幅', slider(inset.width, { min: 0.1, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => setInset({ width: v }, 'iw') })),
            field('表示開始(シーン内の秒)', numInput(inset.startSec, { min: 0, max: dur, step: 0.1, onChange: (v) => setInset({ startSec: v }) })),
            field('表示終了(空欄=最後まで)', (() => {
              const el = h('input', { type: 'number', step: 0.1, min: 0, value: inset.endSec == null ? '' : String(inset.endSec) });
              el.addEventListener('change', () => setInset({ endSec: el.value === '' ? null : Math.max(0, Number(el.value)) }));
              return el;
            })()),
          )
        : null,
    ),
  );
}

/** シーンの話す速さ(音程は変えずに速さだけ変える) */
function speedSection(s: Scene): HTMLElement {
  const speed = s.speed ?? 1;
  const setSpeed = (v: number, all = false) => {
    const sp = Math.round(Math.max(0.5, Math.min(2, v)) * 100) / 100;
    store.commit((p) => ({ ...p, scenes: p.scenes.map((sc) => (all || sc.id === s.id ? { ...sc, speed: sp === 1 ? undefined : sp } : sc)) }));
  };
  const label = h('span', { class: 'slider-value' }, `${speed.toFixed(2)}倍`);
  const range = h('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: String(speed) });
  range.addEventListener('input', () => (label.textContent = `${Number(range.value).toFixed(2)}倍`));
  // 音声の作り直しが重いので、つまみを離したときに確定する
  range.addEventListener('change', () => setSpeed(Number(range.value)));
  return section(
    '話す速さ',
    h('div', { class: 'slider' }, range, label),
    h(
      'div',
      { class: 'seg-buttons' },
      [0.8, 1, 1.1, 1.2, 1.5].map((v) => h('button', { type: 'button', class: Math.abs(speed - v) < 0.001 ? 'on' : '', onclick: () => setSpeed(v) }, `${v}倍`)),
    ),
    button('全シーンをこの速さにする', () => setSpeed(speed, true), { class: 'small' }),
    h('p', { class: 'hint' }, '声の高さは変えずに速さだけ変えます。テロップの表示時間や、元動画と同期した背景の映像も一緒に変わります。'),
  );
}

function captionInspector(c: Caption, player: Player): HTMLElement {
  const p = store.p;
  const tl = timelineOf(p);
  const timing = tl ? captionOutputTimings(p.captions, tl).find((t) => t.id === c.id) : null;
  const ta = h('textarea', { rows: 3, class: 'cap-text' });
  ta.value = c.text;
  ta.addEventListener('input', () => updateCaption(c.id, (cc) => ({ ...cc, text: ta.value, textEdited: true }), `cap-text-${c.id}`));
  const suggestion = p.script ? suggestFromScript(c.rawText || c.text, p.script) : null;
  const style = effectiveStyle(p.style, c);
  const ov = c.style ?? {};
  const setOv = (patch: Partial<CaptionStyle>, key?: string) => updateCaption(c.id, (cc) => ({ ...cc, style: { ...cc.style, ...patch } }), key ? `${key}-${c.id}` : undefined, key ? 'right' : '');
  const overridden = Object.keys(ov).length > 0;
  const ownPos = ov.x !== undefined || ov.y !== undefined;
  const startIn = numInput(timing ? timing.outStart / SR : 0, {
    min: 0,
    step: 0.05,
    onChange: (v) => tl && updateCaption(c.id, (cc) => ({ ...cc, srcStart: Math.min(outToSrc(tl, Math.round(v * SR)), cc.srcEnd - 4800), timingEdited: true }), undefined, ''),
  });
  const endIn = numInput(timing ? timing.outEnd / SR : 0, {
    min: 0,
    step: 0.05,
    onChange: (v) => tl && updateCaption(c.id, (cc) => ({ ...cc, srcEnd: Math.max(outToSrc(tl, Math.round(v * SR)), cc.srcStart + 4800), timingEdited: true }), undefined, ''),
  });
  return h(
    'div',
    null,
    h('h3', null, 'テロップ'),
    c.review ? h('div', { class: 'warn' }, '要確認: ' + c.review) : null,
    c.rawText ? field('聞き取った原文', h('div', { class: 'raw' }, c.rawText)) : null,
    field('表示するテロップ(改行で2行に)', ta, '文章を直しても音声は変わりません'),
    suggestion
      ? h('div', { class: 'note' }, `台本の表記候補: 「${suggestion.text}」`, button('この表記にする', () => updateCaption(c.id, (cc) => ({ ...cc, text: suggestion.text, textEdited: true }), undefined, '')))
      : null,
    h(
      'div',
      { class: 'row gap wrap' },
      button('▶ 再生', () => timing && void player.play(Math.max(0, timing.outStart - 0.2 * SR), timing.outEnd + 0.2 * SR)),
      button('カーソル位置で分割', () => splitCaption(c.id, Array.from(ta.value.slice(0, ta.selectionStart)).length)),
      button('次と結合', () => mergeCaptionWithNext(c.id)),
      button('削除', () => deleteCaption(c.id), { class: 'danger' }),
    ),
    h('div', { class: 'row gap' }, field('表示開始(秒)', startIn), field('表示終了(秒)', endIn)),
    c.timingEdited ? button('時刻を自動に戻す', () => updateCaption(c.id, (cc) => ({ ...cc, timingEdited: false }), undefined, '')) : null,
    section(
      'このテロップだけの見た目',
      ownPos
        ? h(
            'div',
            null,
            h('p', { class: 'note' }, 'このテロップは個別の位置になっています(ほかのテロップの位置とは連動しません)。'),
            h('div', { class: 'seg-buttons' }, button('上', () => setOv({ y: 0.2 })), button('中央', () => setOv({ y: 0.43 })), button('下', () => setOv({ y: 0.72 }))),
            h('div', { class: 'row gap' }, field('横(%)', numInput(style.x * 100, { min: 0, max: 100, step: 0.5, onChange: (v) => setOv({ x: v / 100 }) })), field('縦(%)', numInput(style.y * 100, { min: 0, max: 100, step: 0.5, onChange: (v) => setOv({ y: v / 100 }) }))),
            button('共通の位置に戻す', () => updateCaption(c.id, withoutOwnPosition, undefined, '')),
          )
        : h(
            'div',
            null,
            h('p', { class: 'hint' }, '位置は全テロップ共通です(プレビューでドラッグすると全部動きます)。このテロップだけずらしたいときは、⌥(Option)を押しながらドラッグするか、下のボタンを押してください。'),
            button('このテロップだけ位置をずらす', () => setOv({ x: style.x, y: style.y })),
          ),
      field('文字サイズ', slider(style.size, { min: 30, max: 160, step: 1, format: (v) => `${v}px`, onChange: (v) => setOv({ size: v }, 'ovsize') })),
      field('文字色', colorInput(style.color, (v) => setOv({ color: v }, 'ovcolor'))),
      field('縁取りの色', colorInput(style.strokeColor, (v) => setOv({ strokeColor: v }, 'ovstroke'))),
      fontSelect(style.fontId, (v) => setOv({ fontId: v })),
      overridden ? button('共通設定に戻す', () => updateCaption(c.id, (cc) => { const { style: _s, ...rest } = cc; void _s; return rest; }, undefined, '')) : null,
    ),
  );
}

/** テロップの個別の位置(x, y)だけを外す。ほかの個別設定(色など)は残す */
function withoutOwnPosition(c: Caption): Caption {
  const rest = { ...c.style };
  delete rest.x;
  delete rest.y;
  const next: Caption = { ...c };
  if (Object.keys(rest).length) next.style = rest;
  else delete next.style;
  return next;
}

function fontSelect(value: string, onChange: (v: string) => void): HTMLElement {
  const fonts = store.state.fonts;
  const opts: [string, string][] = fonts.filter((f) => f.status === 'ok' || f.id === value).map((f) => [f.id, fontLabel(f)]);
  if (!fonts.some((f) => f.id === value)) opts.unshift([value, `(見つからないフォント: ${value})`]);
  return field('フォント', select(value, opts, (v) => {
    void ensureFont(v);
    onChange(v);
  }, { class: 'font-select' }), '日本語のあるフォントが上に表示されます。TTF/OTFを素材として取り込むとプロジェクト用フォントになります');
}

function styleView(): HTMLElement {
  const p = store.p;
  const s = p.style;
  const set = (patch: Partial<CaptionStyle>, key?: string) => store.commit((pp) => ({ ...pp, style: { ...pp.style, ...patch } }), key ? { coalesce: 'style-' + key, skip: 'right' } : {});
  const info = store.state.fonts.find((f) => f.id === s.fontId);
  const presets = store.state.presets;
  const presetName = h('input', { type: 'text', placeholder: 'プリセット名' });
  return h(
    'div',
    null,
    h('p', { class: 'hint' }, 'すべてのテロップに共通の設定です。個別に変えたテロップ(選択中タブで変更)はそちらが優先されます。'),
    section(
      '文字',
      fontSelect(s.fontId, (v) => set({ fontId: v })),
      info?.variable ? field('太さ', slider(s.weight, { min: info.weightRange?.[0] ?? 100, max: info.weightRange?.[1] ?? 900, step: 100, onChange: (v) => set({ weight: v }, 'weight') })) : h('p', { class: 'hint' }, 'このフォントは太さ固定です(太さを変えるには別の太さのフォントを選んでください)'),
      field('サイズ', slider(s.size, { min: 30, max: 160, step: 1, format: (v) => `${v}px`, onChange: (v) => set({ size: v }, 'size') })),
      field('文字色', colorInput(s.color, (v) => set({ color: v }, 'color'))),
      field('縁取りの色', colorInput(s.strokeColor, (v) => set({ strokeColor: v }, 'stroke'))),
      field('縁取りの太さ', slider(s.strokeWidth, { min: 0, max: 20, step: 1, format: (v) => `${v}px`, onChange: (v) => set({ strokeWidth: v }, 'sw') })),
      checkbox(s.shadow, '影をつける', (v) => set({ shadow: v })),
      s.shadow ? field('影の色', colorInput(s.shadowColor, (v) => set({ shadowColor: v }, 'shc'))) : null,
      s.shadow ? field('影のぼかし', slider(s.shadowBlur, { min: 0, max: 40, step: 1, onChange: (v) => set({ shadowBlur: v }, 'shb') })) : null,
      field('行間', slider(s.lineHeight, { min: 0.9, max: 2, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => set({ lineHeight: v }, 'lh') })),
      field('揃え', select(s.align, [['center', '中央'], ['left', '左'], ['right', '右']], (v) => set({ align: v }))),
      field('最大幅', slider(s.maxWidth, { min: 300, max: 1060, step: 10, format: (v) => `${v}px`, onChange: (v) => set({ maxWidth: v }, 'mw') })),
      field('最大行数', select(String(s.maxLines), [['1', '1行'], ['2', '2行'], ['3', '3行']], (v) => set({ maxLines: Number(v) }))),
      checkbox(s.band, '背景帯をつける', (v) => set({ band: v })),
      s.band ? field('帯の色', colorInput(s.bandColor, (v) => set({ bandColor: v }, 'bc'))) : null,
      s.band ? field('帯の不透明度', slider(s.bandOpacity, { min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => set({ bandOpacity: v }, 'bo') })) : null,
    ),
    section(
      '位置',
      h('div', { class: 'seg-buttons' }, button('上', () => set({ y: 0.2 })), button('中央', () => set({ y: 0.43 })), button('下', () => set({ y: 0.72 }))),
      h('div', { class: 'row gap' }, field('横(%)', numInput(s.x * 100, { min: 0, max: 100, step: 0.5, onChange: (v) => set({ x: v / 100 }) })), field('縦(%)', numInput(s.y * 100, { min: 0, max: 100, step: 0.5, onChange: (v) => set({ y: v / 100 }) }))),
      h('p', { class: 'hint' }, 'プレビュー上のテロップをドラッグしても全テロップの位置を動かせます(⌥Option を押しながらドラッグすると、そのテロップだけ)。'),
      checkbox(p.safeArea.show, 'SNSのUIが重なりやすい領域の目安を表示', (v) => store.commit((pp) => ({ ...pp, safeArea: { ...pp.safeArea, show: v } }))),
      p.safeArea.show
        ? h(
            'div',
            { class: 'row gap' },
            field('上(%)', numInput(p.safeArea.topPct, { min: 0, max: 40, onChange: (v) => store.commit((pp) => ({ ...pp, safeArea: { ...pp.safeArea, topPct: v } })) })),
            field('下(%)', numInput(p.safeArea.bottomPct, { min: 0, max: 50, onChange: (v) => store.commit((pp) => ({ ...pp, safeArea: { ...pp.safeArea, bottomPct: v } })) })),
            field('右(%)', numInput(p.safeArea.rightPct, { min: 0, max: 40, onChange: (v) => store.commit((pp) => ({ ...pp, safeArea: { ...pp.safeArea, rightPct: v } })) })),
          )
        : null,
      p.safeArea.show ? h('p', { class: 'hint' }, '実際のアプリ画面を保証するものではなく、調整可能な目安です。') : null,
    ),
    section(
      'スタイルのプリセット',
      h(
        'div',
        { class: 'preset-list' },
        h('div', { class: 'preset' }, h('span', null, '白太字・黒縁(初期設定)'), button('適用', () => set({ ...DEFAULT_STYLE, fontId: s.fontId }))),
        presets.map((pr, i) =>
          h(
            'div',
            { class: 'preset' },
            h('span', null, pr.name),
            button('適用', () => set({ ...pr.style })),
            button('削除', async () => {
              const list = presets.filter((_, j) => j !== i);
              store.state.presets = await api.savePresets(list);
              store.emit('presets');
            }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row gap' },
        presetName,
        button('今の設定を保存', async () => {
          const name = presetName.value.trim();
          if (!name) return toast('プリセット名を入力してください');
          const list = [...presets.filter((x) => x.name !== name), { name, style: { ...s } }];
          store.state.presets = await api.savePresets(list);
          store.emit('presets');
          toast('保存しました。次のプロジェクトでも使えます。', 'ok');
        }),
      ),
    ),
  );
}

function audioView(): HTMLElement {
  const p = store.p;
  const audios = p.assets.filter((a) => a.status === 'ok' && (a.kind === 'audio' || (a.kind === 'video' && a.audioStreams?.length)) && a.id !== p.narration?.assetId);
  const b = p.bgm;
  const setB = (patch: Partial<NonNullable<Project['bgm']>>, key?: string) => store.commit((pp) => (pp.bgm ? { ...pp, bgm: { ...pp.bgm, ...patch } } : pp), key ? { coalesce: 'bgm-' + key, skip: 'right' } : {});
  return h(
    'div',
    null,
    section(
      'ナレーション',
      field('音量', slider(p.mix.narrationDb, { min: -20, max: 12, step: 0.5, format: (v) => `${v}dB`, onChange: (v) => store.commit((pp) => ({ ...pp, mix: { ...pp.mix, narrationDb: v } }), { coalesce: 'narr-vol', skip: 'right' }) })),
      h('p', { class: 'hint' }, '書き出し時はクリッピングを防ぐリミッターをかけます。'),
    ),
    section(
      'BGM(1曲)',
      h('p', { class: 'hint' }, '元の音声に既にBGMが入っている場合は追加しなくて構いません。'),
      field('曲', select(b?.assetId ?? '', [['', '(なし)'], ...audios.map((a) => [a.id, a.name] as [string, string])], (v) =>
        store.commit((pp) => ({ ...pp, bgm: v ? { assetId: v, volumeDb: -18, startSec: 0, loop: true, fadeInSec: 0.5, fadeOutSec: 1.5 } : null })),
      )),
      b
        ? h(
            'div',
            null,
            field('音量', slider(b.volumeDb, { min: -40, max: 0, step: 1, format: (v) => `${v}dB`, onChange: (v) => setB({ volumeDb: v }, 'vol') })),
            field('使用開始位置(秒)', numInput(b.startSec, { min: 0, step: 0.5, onChange: (v) => setB({ startSec: v }) })),
            checkbox(b.loop, '動画より短ければループ', (v) => setB({ loop: v })),
            field('冒頭フェード(秒)', numInput(b.fadeInSec, { min: 0, max: 10, step: 0.1, onChange: (v) => setB({ fadeInSec: v }) })),
            field('末尾フェード(秒)', numInput(b.fadeOutSec, { min: 0, max: 10, step: 0.1, onChange: (v) => setB({ fadeOutSec: v }) })),
            h('p', { class: 'hint' }, 'プレビューを再生すると一緒に試聴できます。'),
          )
        : null,
    ),
  );
}

// ---------- 4. 書き出し ----------

function exportView(_player: Player): HTMLElement {
  const p = store.p;
  const tl = timelineOf(p);
  const setE = (patch: Partial<Project['export']>) => store.commit((pp) => ({ ...pp, export: { ...pp.export, ...patch } }));
  const exportsBox = h('div', { class: 'exports' });
  const refreshExports = async () => {
    exportsCache = await api.exports(p.id).catch(() => []);
    renderExports(exportsBox, p.id);
  };
  renderExports(exportsBox, p.id);
  void refreshExports();
  const checkBox = h('div', { class: 'checks' });
  const renderChecks = () =>
    checkBox.replaceChildren(
      exportCheck
        ? h(
            'div',
            null,
            exportCheck.errors.map((e) => h('div', { class: 'err' }, '✖ ' + e)),
            exportCheck.warnings.map((w) => h('div', { class: 'warn' }, '⚠ ' + w)),
            !exportCheck.errors.length && !exportCheck.warnings.length ? h('div', { class: 'ok-box' }, '✔ 問題は見つかりませんでした') : null,
          )
        : h('div', { class: 'hint' }, '確認中…'),
    );
  renderChecks();
  void checkExport().then((c) => {
    exportCheck = c;
    renderChecks();
  });
  const doneJobs = store.state.jobs.filter((j) => j.type === 'export' && j.status === 'done').slice(-1);
  return h(
    'div',
    { class: 'panel-body' },
    section(
      '書き出し設定',
      h('p', { class: 'hint' }, `1080×1920(9:16) / H.264 + AAC / MP4${tl ? ` / 長さ ${fmtSec(tl.outSamples / SR)}` : ''}`),
      field('フレームレート', select(String(p.export.fps), [['30', '30fps(推奨)'], ['24', '24fps'], ['25', '25fps'], ['60', '60fps']], (v) => setE({ fps: Number(v) }))),
      field('画質', select(String(p.export.crf), [['18', '高画質'], ['20', '標準'], ['23', 'ファイル小さめ']], (v) => setE({ crf: Number(v) }))),
      field('背景なしシーンの色', colorInput(p.export.bgColor, (v) => store.commit((pp) => ({ ...pp, export: { ...pp.export, bgColor: v } }), { coalesce: 'bgcolor', skip: 'right' }))),
      checkbox(p.export.alsoWav, '編集済みナレーションのWAVも保存', (v) => setE({ alsoWav: v })),
      checkbox(p.export.alsoSrt, '字幕SRTも保存(文章と時刻のみ)', (v) => setE({ alsoSrt: v })),
    ),
    section('書き出し前の確認', checkBox),
    button('動画を書き出す', () => void startExport().then(refreshExports), { class: 'primary big' }),
    jobsBox(['export']),
    doneJobs.length ? framesCompare(doneJobs[0]!.result as { frames: { file: string; timeSec: number }[] } | undefined, p.id) : null,
    section('書き出したファイル', exportsBox, button('Finderで書き出しフォルダを開く', async () => {
      const r = await api.reveal(p.id);
      toast(`保存先: ${r.path}`);
    })),
  );
}

function renderExports(el: HTMLElement, projectId: string) {
  el.replaceChildren(
    exportsCache.length
      ? h(
          'ul',
          { class: 'export-list' },
          exportsCache.map((f) =>
            h(
              'li',
              null,
              h('a', { href: `/api/projects/${projectId}/exports/${encodeURIComponent(f.name)}`, target: '_blank' }, f.name),
              h('span', { class: 'hint' }, ` ${fmtBytes(f.size)}`),
              ' ',
              h('a', { href: `/api/projects/${projectId}/exports/${encodeURIComponent(f.name)}?download=1` }, '保存'),
            ),
          ),
        )
      : h('p', { class: 'hint' }, 'まだありません'),
  );
}

function framesCompare(result: { frames: { file: string; timeSec: number }[] } | undefined, projectId: string): HTMLElement | null {
  if (!result?.frames?.length) return null;
  return section(
    '書き出し結果の確認(代表フレーム)',
    h('p', { class: 'hint' }, 'クリックするとその時刻のプレビューを表示します。文字切れ・改行・フォント・位置をプレビューと見比べてください。'),
    h(
      'div',
      { class: 'frames' },
      result.frames.map((f) =>
        h('img', {
          src: `/api/projects/${projectId}/export-frames/${encodeURIComponent(f.file)}`,
          title: `${f.timeSec.toFixed(2)}秒`,
          onclick: () => document.dispatchEvent(new CustomEvent('tdm:seek', { detail: Math.round(f.timeSec * SR) })),
        }),
      ),
    ),
  );
}

export function mediaThumb(p: Project, a: Asset) {
  return mediaUrl(p.id, a.id, 'thumb');
}
