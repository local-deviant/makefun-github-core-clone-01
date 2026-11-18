// The forge server: one in-memory Forge behind a node:http server, with the
// REST, GraphQL, MCP and smart-HTTP git surfaces mounted. Every reply is
// JSON (or a git content type) with a non-empty X-GitHub-Request-Id; unknown
// routes are JSON 404s; a malformed JSON body is a 400; a missing or wrong
// bearer token is a 401. The server never reads the clock or the network.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { extractToken, readBody, Router, sendError, sendJson, type Ctx } from './http.ts';
import { registerRestRoutes } from './rest.ts';
import { registerGraphqlRoutes } from './graphql.ts';
import { registerMcpRoutes } from './mcp.ts';
import { registerGitRoutes } from './githttp.ts';

export interface ForgeServer {
  port: number;
  close: () => Promise<void>;
}

function buildRouter(forge: Forge): Router {
  const router = new Router();
  router.get('/healthz', (ctx) => {
    sendJson(ctx.res, 200, { ok: true });
  });
  registerRestRoutes(router, forge);
  registerGraphqlRoutes(router, forge);
  registerMcpRoutes(router, forge);
  registerGitRoutes(router, forge);
  return router;
}

export async function startForge(token: string, port = 0): Promise<ForgeServer> {
  const forge = new Forge(token);
  const router = buildRouter(forge);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const ctx: Ctx = {
        forge,
        req,
        res,
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        params: {},
        body: null,
        rawBody: body,
        token: null,
      };
      ctx.token = extractToken(req);
      const found = router.match(ctx.method, ctx.path);
      if (!found) {
        sendError(res, 404, 'Not Found');
        return;
      }
      ctx.params = found.params;
      await found.handler(ctx);
    } catch (err) {
      // A handler must never take the server down (the suite probes the server
      // after 404s, refusals and malformed requests).
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
