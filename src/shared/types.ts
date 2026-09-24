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
  timing: 'token' | 'dtw' | 'segment';
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

export type CutPresetId = 'jumpcut' | 'tempo' | 'natural' | 'custom';

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
}

export interface CutSettings {
  preset: CutPresetId;
  params: CutParams;
  /** 「この間は残す」を指定した元音声の範囲 */
  keepRanges: { start: number; end: number }[];
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
}

export interface Timeline {
  segments: KeepSegment[];
  outSamples: number;
  srcSamples: number;
  fadeMs: number;
  hash: string;
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
  kenBurns: boolean;
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
  asr: { quality: 'speed' | 'accuracy'; model: string | null; dtw: boolean };
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
