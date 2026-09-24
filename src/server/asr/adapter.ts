// 音声認識(ASR)の交換可能なアダプター定義。
import type { Token } from '../../shared/types.js';

export interface AsrRequest {
  /** 16kHz モノラル WAV */
  wavPath: string;
  language: string;
  modelPath: string;
  /** DTW でトークン時刻を推定する場合のプリセット名 */
  dtwPreset?: string;
  /** 固有名詞などのヒント(台本から抽出) */
  prompt?: string;
  workDir: string;
  signal: AbortSignal;
  progress: (p: number, message?: string) => void;
}

export interface AsrResult {
  /** 入力音声の先頭からのサンプル位置(48kHz換算) */
  tokens: Token[];
  notes: string[];
}

export interface AsrAdapter {
  readonly name: string;
  available(): boolean;
  transcribe(req: AsrRequest): Promise<AsrResult>;
}
