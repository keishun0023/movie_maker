// プロジェクトのデータモデル。ブラウザとサーバーの両方から使う。
// 時刻はすべて「元音声(ナレーション)の48kHzサンプル位置」を整数で保持する。
// 出力(編集後)時刻は保持区間の対応表(timeline)から都度計算する。

export const SCHEMA_VERSION = 1;
/** 内部の時間単位: 1秒 = 48000 サンプル */
export const SR = 48000;

export type AssetKind = 'audio' | 'video' | 'image' | 'font';

export interface AudioStreamInfo {
  /** ffprobe のストリーム番号 */
  index: number;
  /** 音声ストリーム内での番号 (0:a:N の N) */
  audioIndex: number;
  codec: string;
  channels: number;
  sampleRate: number;
  language?: string;
  title?: string;
}

export interface Asset {
  id: string;
  kind: AssetKind;
  /** 元のファイル名(表示用) */
  name: string;
  /** プロジェクトフォルダからの相対パス */
  file: string;
  size: number;
  hash: string;
  importedAt: string;
  status: 'ok' | 'error';
  error?: string;
  warnings: string[];
  durationSec?: number;
  /** 回転適用後の表示サイズ */
  width?: number;
  height?: number;
  rotation?: number;
  fps?: number;
  vfr?: boolean;
  videoCodec?: string;
  /** 動画の開始時刻と音声の開始時刻の差の補正用 */
  videoStartSec?: number;
  audioStartSec?: number;
  audioStreams?: AudioStreamInfo[];
  /** プレビュー用に変換したファイル(相対パス) */
  proxy?: string;
  thumb?: string;
  /** フォント素材の場合のフォントID */
  fontIds?: string[];
}

export interface Narration {
  assetId: string;
  /** 0:a:N の N */
  audioIndex: number;
  durationSamples: number;
  /** 抽出元の識別(素材ハッシュ+トラック) */
  sourceKey: string;
  preparedAt: string;
  warnings: string[];
}

export type TokenFlag = 'silence' | 'lowConf' | 'hallucination';

export interface Token {
  id: string;
  text: string;
  /** 元音声のサンプル位置 */
  start: number;
  end: number;
  /** 認識確率 0..1 */
  p: number;
  /** whisper のセグメント番号 */
  seg: number;
  /** 時刻の出どころ。segment は区間単位しか取れなかったことを示す */
  /** chunk は無音で区切った音声片の中を文字量で配分した推定時刻(クラウド認識) */
  /** aligned はクラウド認識の文字を、ローカル認識(whisper)の時刻に合わせたもの */
  timing: 'token' | 'dtw' | 'segment' | 'chunk' | 'aligned';
  flags?: TokenFlag[];
}

export interface Transcript {
  engine: string;
  model: string;
  createdAt: string;
  basis: 'source' | 'edited';
  tokens: Token[];
  notes: string[];
}

export type CutPresetId = 'tsuratsura' | 'jumpcut' | 'tempo' | 'natural' | 'custom';

export interface CutParams {
  /** これより短い無音は触らない */
  minSilenceMs: number;
  /** 無音を縮めた後に残す長さ(前後の保護余白の合計より短くはならない) */
  keepMs: number;
  /** 発話の立ち上がりを守る余白 */
  padBeforeMs: number;
  /** 語尾を守る余白 */
  padAfterMs: number;
  /** 冒頭に残す無音 */
  headMs: number;
  /** 末尾に残す無音 */
  tailMs: number;
  /** 無音判定の感度(dB)。+にすると大きめの音も無音扱い */
  sensitivityDb: number;
  /** 接合点のフェード */
  fadeMs: number;
  /**
   * 被せ: カットの両側の発話(語尾の余韻・語頭)にこの長さだけ食い込んで詰め、
   * 詰めた部分はクロスフェードで重ねてつなぐ。0 なら発話は削らない
   */
  overlapMs: number;
}

export interface CutSettings {
  preset: CutPresetId;
  params: CutParams;
  /** 「この間は残す」を指定した元音声の範囲 */
  keepRanges: { start: number; end: number }[];
  /** false にすると、認識結果で「発話の可能性あり」と判断した間(保護)も詰める */
  protectSpeech?: boolean;
}

export interface SilenceCandidate {
  id: string;
  start: number;
  end: number;
  /** 認識結果から発話がある可能性が高く、削らないと判断した */
  protectedBySpeech: boolean;
}

export interface KeepSegment {
  srcStart: number;
  srcEnd: number;
  outStart: number;
  outEnd: number;
  /** 話す速さ(1 = 等速)。出力の長さ = 元の長さ / speed */
  speed?: number;
  /** 足した間(無音)。元音声は使わない(srcStart = srcEnd) */
  gap?: boolean;
}

/** 元音声の位置 at の後に足す間(無音) */
export interface PauseInsert {
  at: number;
  /** 足す長さ(サンプル) */
  samples: number;
}

/** 元音声の範囲ごとの話す速さ(シーンの設定から作る) */
export interface SpeedRange {
  start: number;
  end: number;
  speed: number;
}

export interface Timeline {
  segments: KeepSegment[];
  outSamples: number;
  srcSamples: number;
  fadeMs: number;
  /** カット点で前後の音声を重ねるクロスフェードの長さ(被せ) */
  xfadeMs?: number;
  hash: string;
  /** 対応表を作ったときの速さ設定(変更検出用) */
  speedKey?: string;
}

export interface CaptionStyle {
  fontId: string;
  /** 可変フォントのみ有効 */
  weight: number;
  size: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetY: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  maxWidth: number;
  maxLines: number;
  /** 中心位置(0..1, 画面比) */
  x: number;
  y: number;
  band: boolean;
  bandColor: string;
  bandOpacity: number;
  bandPadding: number;
}

export interface Caption {
  id: string;
  srcStart: number;
  srcEnd: number;
  tokenIds: string[];
  /** 聞き取った原文(トークンの連結) */
  rawText: string;
  /** 表示用テロップ(\n で手動改行) */
  text: string;
  textEdited: boolean;
  timingEdited: boolean;
  style?: Partial<CaptionStyle>;
  review?: string;
}

export type MotionType = 'none' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown' | 'punchIn' | 'impact' | 'shake';

/** カット内の背景の動き */
export interface Motion {
  type: MotionType;
  /** 強さ 0.3〜2(1 が標準) */
  strength: number;
}

export interface BgPlacement {
  assetId: string;
  fit: 'cover' | 'contain';
  zoom: number;
  /** -1..1 はみ出し量(または余白)に対する位置 */
  offsetX: number;
  offsetY: number;
  /** 動画の使用開始位置(秒) */
  startSec: number;
  shortMode: 'freeze' | 'loop';
  /** synced: ナレーション元動画に対応表を適用 / independent: 独立した背景 */
  mode: 'independent' | 'synced';
  audio: boolean;
  volumeDb: number;
  /** 旧設定(ゆっくりズーム)。motion があればそちらを使う */
  kenBurns: boolean;
  motion?: Motion;
}

export interface InsetPlacement {
  assetId: string;
  /** 中心位置 0..1 */
  x: number;
  y: number;
  /** 幅(画面幅に対する比) */
  width: number;
  /** シーン開始からの秒 */
  startSec: number;
  /** シーン開始からの秒。null ならシーン終了まで */
  endSec: number | null;
}

export interface Scene {
  id: string;
  srcStart: number;
  srcEnd: number;
  bg: BgPlacement | null;
  inset: InsetPlacement | null;
  boundaryEdited?: boolean;
  /** このシーンの話す速さ(0.5〜2.0、初期値 1)。音程は変えずに速さだけ変える */
  speed?: number;
  /** このカットの後に足す間(ミリ秒)。テンポよく詰めた後でも、ここだけ間を空けたいとき */
  pauseAfterMs?: number;
  /** AI が素材を提案したときの理由(表示用) */
  aiNote?: string;
  /** AI が挙げたほかの候補(「別の候補にする」で順に切り替える) */
  aiAlternatives?: { assetId: string; startSec: number; reason: string }[];
}

export interface BgmSettings {
  assetId: string;
  volumeDb: number;
  startSec: number;
  loop: boolean;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  crf: number;
  bgColor: string;
  alsoWav: boolean;
  alsoSrt: boolean;
  /** CapCut の下書きフォルダ(空なら既定の場所) */
  capcutDir?: string;
}

export interface SafeAreaGuide {
  show: boolean;
  topPct: number;
  bottomPct: number;
  rightPct: number;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
  narration: Narration | null;
  script: string;
  useScriptHints: boolean;
  transcript: Transcript | null;
  cut: CutSettings;
  silenceCandidates: SilenceCandidate[];
  timeline: Timeline | null;
  scenes: Scene[];
  captions: Caption[];
  style: CaptionStyle;
  bgm: BgmSettings | null;
  mix: { narrationDb: number };
  export: ExportSettings;
  safeArea: SafeAreaGuide;
  /** 1カット(シーン)の長さの目安(秒) */
  sceneLen: {
    minSec: number;
    maxSec: number;
    /** 冒頭 introSec 秒は、1カットを introMaxSec 秒以下にする(0 なら無効) */
    introSec?: number;
    introMaxSec?: number;
    /** caption: テロップ1つ=1カット / even: 長さの目安で均等 / mix: 速いカットと遅いカットを織り交ぜる */
    rhythm?: 'even' | 'mix' | 'caption' | 'reference';
  };
  /** 文字起こしの直し(「白球」→「白玉」など)。テロップを作り直すたびに当てはめ、認識のヒントにも使う */
  textFixes?: TextFix[];
  /** テロップの長さ: normal(2行まで) / short(1行・短く区切る) */
  captionLen?: 'normal' | 'short';
  /** 素材を割り当てたときに、おまかせで動きも付ける(初期値 true) */
  motionAuto?: boolean;
  /** おまかせの動きの強さ */
  motionStrength?: number;
  /** Claude による素材の自動割り当て */
  aiAssign: {
    /** 素材のフレーム画像と文章を Claude API に送ることに同意したか */
    consent: boolean;
    /** 割り当てに使う素材(空なら全部) */
    assetIds: string[];
    /** 素材の指定(参考)をもとに割り当てる */
    useReference?: boolean;
    /** スプレッドシートから貼り付けた「台本 / 使う素材」の表(タブ区切り) */
    reference?: string;
  };
  asr: {
    /** whisper: ローカル(whisper.cpp) / gemini: Google Gemini API(音声を送信する) */
    engine: 'whisper' | 'gemini';
    quality: 'speed' | 'accuracy';
    model: string | null;
    dtw: boolean;
    geminiModel: string;
    /** このプロジェクトの音声を Gemini に送ることに利用者が同意したか */
    cloudConsent: boolean;
  };
}

export interface TextFix {
  from: string;
  to: string;
}

export interface StylePreset {
  name: string;
  style: CaptionStyle;
}

export interface FontInfo {
  id: string;
  family: string;
  /** 日本語名があれば */
  familyJa?: string;
  subfamily: string;
  fullName: string;
  weight: number;
  variable: boolean;
  weightRange?: [number, number];
  hasJapanese: boolean;
  source: 'bundled' | 'system' | 'project';
  status: 'ok' | 'error';
  error?: string;
  license?: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface JobInfo {
  id: string;
  type: string;
  label: string;
  projectId?: string;
  status: JobStatus;
  progress: number;
  message: string;
  error?: string;
  result?: unknown;
  createdAt: string;
  finishedAt?: string;
}

export interface AnalysisData {
  /** 1フレームのサンプル数(48kHz) */
  frameSamples: number;
  /** フレームごとのRMS (dBFS, 小数1桁) */
  db: number[];
  /** フレームごとのピーク 0..1 (小数3桁) */
  peak: number[];
  durationSamples: number;
}
