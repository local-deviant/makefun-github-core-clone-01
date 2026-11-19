// HTTP wiring: auth, request ids, routing. Every reply is JSON (except the git
// smart-HTTP bodies, which are the protocol's own bytes). Unknown routes are 404 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { routeGit } from './git.ts';
import { routeRest, jsonBody, jsonError, readJsonBody, type Ctx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(16, '0');
}

/** True when the request carries the trial token as Bearer or as a Basic password. */
function isAuthed(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim() === token;
  if (h.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const password = idx === -1 ? '' : decoded.slice(idx + 1);
      return password !== '' && password === token;
    } catch {
      return false;
    }
  }
  return false;
}

function send401(res: ServerResponse, requestId: string): void {
  const body = JSON.stringify({ message: 'Requires authentication' });
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': requestId,
    'www-authenticate': 'Basic realm="forge", Bearer realm="forge"',
  });
  res.end(body);
}

export interface AppOptions {
  token: string;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(store: Store, options: AppOptions): Server {
  const token = options.token;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const method = req.method ?? 'GET';
      let path = '/';
      try {
        path = new URL(req.url ?? '/', 'http://x').pathname;
      } catch {
        path = '/';
      }

      // Health probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        jsonBody(res, 200, { ok: true }, requestId);
        return;
      }

      // Everything else needs the token.
      if (!isAuthed(req, token)) {
        send401(res, requestId);
        return;
      }

      const ctx: Ctx = { store, token, req, res, requestId };

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const subpath = gitMatch[3] ?? '/';
        const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
        const handled = await routeGit(req, res, repo, subpath);
        if (handled) return;
        jsonError(ctx, 404, 'Not Found');
        return;
      }

      // GraphQL.
      if (method === 'POST' && path === '/api/graphql') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          jsonBody(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, requestId);
          return;
        }
        const result = executeGraphQL(store, body);
        jsonBody(res, 200, result, requestId);
        return;
      }

      // MCP.
      if (method === 'POST' && path === '/mcp') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-github-request-id': requestId });
            res.end(body);
            return;
          }
          const sessionId = req.headers['mcp-session-id'];
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-github-request-id': requestId,
          };
          if (typeof sessionId === 'string' && sessionId) headers['mcp-session-id'] = sessionId;
          const response = handleMcp(store, parsed);
          if (response === null) {
            res.writeHead(202, headers);
            res.end();
            return;
          }
          const body = JSON.stringify(response);
          res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) });
          res.end(body);
        });
        req.on('error', () => {
          if (!res.writableEnded) {
            const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-github-request-id': requestId });
            res.end(body);
          }
        });
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        try {
          const handled = await routeRest(ctx);
          if (handled) return;
        } catch (err) {
          if (!res.writableEnded) jsonError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
          return;
        }
        jsonError(ctx, 404, 'Not Found');
        return;
      }

      jsonError(ctx, 404, 'Not Found');
    })().catch(() => {
      if (!res.writableEnded) {
        try {
          jsonBody(res, 500, { message: 'Internal Server Error' }, requestId);
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    });
  });
}
