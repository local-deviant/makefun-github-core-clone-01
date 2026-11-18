// HTTP plumbing for the forge: a tiny router over node:http, bearer-token
// auth, per-request ids, JSON helpers and the error shapes the suite checks.
// Determinism: request ids count up from 1 — no randomness, no wall clock.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type Handler = (ctx: Ctx) => Promise<void> | void;

export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
  token: string | null;
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req_${String(requestCounter).padStart(6, '0')}`;
}

export function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type'] ?? '';
  return type.includes('application/json');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { message, ...extra });
}

/** 401 shape: exactly the message the suite expects. The WWW-Authenticate
 * challenge is what makes a real git client retry with its credentials
 * (git never sends them pre-emptively). */
export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="makefun-github-core-clone", Bearer' });
}

export function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

/** Parse the request body as JSON. On syntax error -> 400 with a string message. */
export function parseJsonBody(ctx: Ctx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.rawBody.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(ctx.rawBody.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** The bearer token, or the password of a Basic credential (real git clients
 * authenticate with `user:token` over HTTP Basic; the suite's client sends a
 * Bearer token). Returns null when no credential is present. */
export function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const bearer = /^Bearer\s+(.+)$/.exec(header);
  if (bearer) return bearer[1] as string;
  const basic = /^Basic\s+(.+)$/.exec(header);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) return decoded || null;
      return decoded.slice(colon + 1) || decoded.slice(0, colon) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function bearerToken(req: IncomingMessage): string | null {
  return extractToken(req);
}

/** The suite's token check: token must be present and equal to the env token. */
export function tokenOk(forge: Forge, token: string | null): boolean {
  if (forge.token === '') return true; // fail-open: no token configured at all
  return token !== null && token === forge.token;
}

export function requireAuth(ctx: Ctx): boolean {
  if (!tokenOk(ctx.forge, ctx.token)) {
    unauthorized(ctx.res);
    return false;
  }
  return true;
}

/** RFC 8288 Link header with absolute, same-origin URLs (the suite follows
 * rel="next" and rejects a link that leaves the entry's origin). */
export function linkHeader(origin: string, basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${origin}${basePath}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${urlFor(1)}; rel="first"`, `${urlFor(lastPage)}; rel="last"`);
  if (page > 1) parts.push(`${urlFor(page - 1)}; rel="prev"`);
  return parts.join(', ');
}

export function requestOrigin(ctx: { req: IncomingMessage }): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

export function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

export function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; total: number } {
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), total: items.length };
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  #routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): void {
    this.#routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.on('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): void {
    this.on('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler): void {
    this.on('PUT', pattern, handler);
  }
  patch(pattern: string, handler: Handler): void {
    this.on('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: Handler): void {
    this.on('DELETE', pattern, handler);
  }

  /** Match a path; returns the handler plus captured `:param` segments. A
   * trailing `*name` segment captures the rest of the path (joined by `/`). */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segments = path.split('/').filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const wildcard = route.segments.length > 0 && (route.segments[route.segments.length - 1] as string).startsWith('*');
      if (!wildcard && route.segments.length !== segments.length) continue;
      if (wildcard && segments.length < route.segments.length - 1) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const patternSegment = route.segments[i] as string;
        if (patternSegment.startsWith('*')) {
          params[patternSegment.slice(1)] = segments.slice(i).map((s) => decodeURIComponent(s)).join('/');
          break;
        }
        const actual = segments[i] as string;
        if (patternSegment.startsWith(':')) {
          // A `:name` segment may carry a literal suffix, e.g. `:repo.git`.
          const paramMatch = /^:([A-Za-z0-9_]+)(.*)$/.exec(patternSegment) as RegExpExecArray;
          const name = paramMatch[1] as string;
          const suffix = paramMatch[2] as string;
          if (suffix && !actual.endsWith(suffix)) {
            ok = false;
            break;
          }
          params[name] = decodeURIComponent(suffix ? actual.slice(0, -suffix.length) : actual);
        } else if (patternSegment !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}
