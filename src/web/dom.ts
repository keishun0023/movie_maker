// 小さなDOM作成ヘルパー(フレームワークなし)。
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'multiple' || k === 'indeterminate') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Element, ...children: Child[]) {
  clear(el);
  append(el, children);
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const e = root.querySelector(sel);
  if (!e) throw new Error(`要素が見つかりません: ${sel}`);
  return e as HTMLElement;
}

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 4000) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.appendChild(box);
  }
  const t = h('div', { class: `toast ${kind}` }, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? Math.max(ms, 8000) : ms);
}

export function fmtSec(sec: number, digits = 2): string {
  if (!isFinite(sec)) return '-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
}

export function fmtBytes(n: number): string {
  if (n > 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n > 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/** ラベル付きの行 */
export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function numInput(value: number, opts: { min?: number; max?: number; step?: number; onChange: (v: number) => void; live?: boolean }): HTMLInputElement {
  const el = h('input', { type: 'number', value: String(Math.round(value * 1000) / 1000), min: opts.min, max: opts.max, step: opts.step ?? 1 });
  const fire = () => {
    const v = Number(el.value);
    if (!isFinite(v)) return;
    let c = v;
    if (opts.min !== undefined) c = Math.max(opts.min, c);
    if (opts.max !== undefined) c = Math.min(opts.max, c);
    opts.onChange(c);
  };
  el.addEventListener(opts.live ? 'input' : 'change', fire);
  return el;
}

export function slider(value: number, opts: { min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }): HTMLElement {
  const out = h('span', { class: 'slider-value' }, opts.format ? opts.format(value) : String(value));
  const el = h('input', { type: 'range', value: String(value), min: opts.min, max: opts.max, step: opts.step ?? 1 });
  el.addEventListener('input', () => {
    const v = Number(el.value);
    out.textContent = opts.format ? opts.format(v) : String(v);
    opts.onChange(v);
  });
  return h('span', { class: 'slider' }, el, out);
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void, attrs: Record<string, unknown> = {}): HTMLSelectElement {
  const el = h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function checkbox(checked: boolean, label: string, onChange: (v: boolean) => void, disabled = false): HTMLElement {
  const el = h('input', { type: 'checkbox', checked, disabled });
  el.addEventListener('change', () => onChange(el.checked));
  return h('label', { class: 'check' + (disabled ? ' disabled' : '') }, el, h('span', null, label));
}

export function colorInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const el = h('input', { type: 'color', value });
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

export function button(label: string, onClick: (ev: MouseEvent) => void, attrs: Record<string, unknown> = {}): HTMLButtonElement {
  const el = h('button', { type: 'button', ...attrs }, label);
  el.addEventListener('click', onClick);
  return el;
}
