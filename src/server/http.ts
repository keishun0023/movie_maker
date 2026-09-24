// 最小限のHTTPユーティリティ(依存ライブラリなし)。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { HttpError } from './store.js';

export type Req = IncomingMessage & { params: Record<string, string>; query: URLSearchParams; pathname: string };
export type Handler = (req: Req, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\//g, '\\/').replace(/:([a-zA-Z]+)/g, (_, k: string) => {
          keys.push(k);
          return '([^\\/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  del(p: string, h: Handler) { this.add('DELETE', p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { handler: r.handler, params };
    }
    return null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

export async function readBody(req: IncomingMessage, limit = 300 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'データが大きすぎます');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = unknown>(req: IncomingMessage, limit?: number): Promise<T> {
  const b = await readBody(req, limit);
  try {
    return JSON.parse(b.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'JSONの形式が正しくありません');
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.srt': 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Range 対応のファイル配信(動画のシークに必要) */
export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { type?: string; download?: string; cache?: string } = {}) {
  let st: fs.Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'ファイルが見つかりません');
  }
  const type = opts.type ?? contentType(file);
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache ?? 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (opts.download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (isNaN(start)) {
        start = Math.max(0, st.size - end);
        end = st.size - 1;
      }
      if (start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}

/** ルート配下のファイルだけを配信する(パストラバーサル防止) */
export function safeJoin(root: string, rel: string): string | null {
  const p = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  return p.startsWith(root + path.sep) || p === root ? p : null;
}
