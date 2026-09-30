// 編集状態、Undo/Redo、自動保存。
import type { AnalysisData, FontInfo, JobInfo, Project, StylePreset } from '../shared/types.js';
import { api, type SystemResp } from './api.js';

export type Selection = { kind: 'scene' | 'caption'; id: string } | null;
export type Step = 1 | 2 | 3 | 4;
export type RightTab = 'selected' | 'style' | 'audio';

export interface UiState {
  step: Step;
  rightTab: RightTab;
  leftTab: 'assets' | 'scenes';
  selection: Selection;
  /** 出力時刻(サンプル) */
  playhead: number;
  playing: boolean;
  timelineView: 'output' | 'source';
  selectedCandidate: string | null;
  checkedAssets: string[];
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface AppState {
  project: Project;
  analysis: AnalysisData | null;
  fonts: FontInfo[];
  presets: StylePreset[];
  system: SystemResp | null;
  jobs: JobInfo[];
  ui: UiState;
  saveState: 'saved' | 'saving' | 'dirty' | 'error';
}

type Listener = (reason: string) => void;

export interface CommitOptions {
  /** 同じキーの連続変更は1回のUndoにまとめる */
  coalesce?: string;
  /** Undo履歴に積まない */
  noHistory?: boolean;
  /** 再描画しないパネル */
  skip?: string;
}

export class Store {
  state!: AppState;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCoalesce: { key: string; at: number } | null = null;
  private listeners: Listener[] = [];
  private saveTimer: number | null = null;
  private saving: Promise<void> | null = null;
  skipPanel: string | null = null;
  /** 変更のたびに整合性をそろえる処理(例: 速さの変更で対応表を作り直す) */
  normalize: ((p: Project) => Project) | null = null;

  init(s: AppState) {
    this.state = s;
    this.undoStack = [];
    this.redoStack = [];
  }

  subscribe(fn: Listener) {
    this.listeners.push(fn);
  }

  emit(reason: string) {
    for (const l of this.listeners) l(reason);
  }

  get p(): Project {
    return this.state.project;
  }

  /** プロジェクトを変更する(履歴・自動保存つき) */
  commit(fn: (p: Project) => Project, opt: CommitOptions = {}) {
    const before = this.state.project;
    const changed = fn(before);
    const after = changed === before || !this.normalize ? changed : this.normalize(changed);
    if (after === before) return;
    if (!opt.noHistory) {
      const now = Date.now();
      const same = opt.coalesce && this.lastCoalesce && this.lastCoalesce.key === opt.coalesce && now - this.lastCoalesce.at < 1500;
      if (!same) {
        this.undoStack.push(JSON.stringify(before));
        if (this.undoStack.length > 150) this.undoStack.shift();
      }
      this.lastCoalesce = opt.coalesce ? { key: opt.coalesce, at: now } : null;
      this.redoStack = [];
    }
    this.state.project = after;
    this.markDirty();
    this.skipPanel = opt.skip ?? null;
    this.emit('project');
    this.skipPanel = null;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.state.project));
    this.state.project = JSON.parse(prev);
    this.lastCoalesce = null;
    this.markDirty();
    this.emit('project');
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.state.project));
    this.state.project = JSON.parse(next);
    this.lastCoalesce = null;
    this.markDirty();
    this.emit('project');
  }

  setUi(patch: Partial<UiState>, reason = 'ui') {
    this.state.ui = { ...this.state.ui, ...patch };
    this.emit(reason);
  }

  private markDirty() {
    this.state.saveState = 'dirty';
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 800);
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) await this.saving;
    if (this.state.saveState === 'saved') return;
    const snapshot = this.state.project;
    this.state.saveState = 'saving';
    this.emit('save');
    this.saving = (async () => {
      try {
        const r = await api.saveProject(snapshot);
        if (this.state.project === snapshot) {
          this.state.project = { ...snapshot, updatedAt: r.updatedAt };
          this.state.saveState = 'saved';
        } else this.state.saveState = 'dirty';
      } catch (e) {
        console.error(e);
        this.state.saveState = 'error';
      }
      this.emit('save');
    })();
    await this.saving;
    this.saving = null;
    if ((this.state.saveState as string) === 'dirty') this.markDirty();
  }
}

export const store = new Store();
