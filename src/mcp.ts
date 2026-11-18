// Model Context Protocol over the same store: streamable HTTP (JSON-RPC 2.0)
// at POST /mcp. Modern revision 2026-07-28 via `server/discover`, legacy
// handshake revisions via `initialize` + `notifications/initialized`.
// Six tools (github-mcp-server's names), each acting on the REST store so
// ids are identical across surfaces.

import { buildCommit } from './git.ts';
import { FIXED_EPOCH_SEC, FIXED_ISO } from './seed.ts';
import {
  Forge,
  issueJson,
  pullJson,
  repoJson,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  nextRequestId,
  parseJsonBody,
  requireAuth,
  sendJson,
  type Ctx,
  type Router,
} from './http.ts';

const SERVER_NAME = 'makefun-github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: JsonObject, names: readonly string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function numberArg(args: JsonObject, names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function toolResult(data: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOrError(forge: Forge, args: JsonObject): { repo: Repo } | { error: string } {
  const owner = stringArg(args, ['owner', 'owner_login', 'org', 'login']);
  const repoName = stringArg(args, ['repo', 'repository', 'repository_name', 'repo_name']);
  if (!owner || !repoName) return { error: 'owner and repo are required' };
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return { error: `repository ${owner}/${repoName} not found` };
  return { repo };
}

function callTool(forge: Forge, name: string, args: JsonObject): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: true } {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, ['name', 'repo', 'repository']);
      if (!repoName) return toolError('create_repo: name is required');
      const description = stringArg(args, ['description', 'about', 'summary']) ?? '';
      const isPrivate = args.private === true || args.is_private === true;
      const repo = forge.createRepo(forge.viewer.login, repoName, { description, isPrivate });
      if (!repo) return toolError(`create_repo: repository ${repoName} already exists`);
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const found = repoOrError(forge, args);
      if ('error' in found) return toolError(`get_repo: ${found.error}`);
      return toolResult(repoJson(forge, found.repo));
    }
    case 'create_issue': {
      const found = repoOrError(forge, args);
      if ('error' in found) return toolError(`create_issue: ${found.error}`);
      const repo = found.repo;
      const title = stringArg(args, ['title', 'issue_title', 'subject']);
      if (!title) return toolError('create_issue: title is required');
      const body = stringArg(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = { number, title, body, state: 'open', labels: [], seq: number, comments: [] };
      repo.issues.set(number, issue);
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const found = repoOrError(forge, args);
      if ('error' in found) return toolError(`list_issues: ${found.error}`);
      const repo = found.repo;
      const state = stringArg(args, ['state', 'status']) ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      return toolResult({ issues: issues.map((issue) => issueJson(forge, repo, issue)) });
    }
    case 'create_pull_request': {
      const found = repoOrError(forge, args);
      if ('error' in found) return toolError(`create_pull_request: ${found.error}`);
      const repo = found.repo;
      const title = stringArg(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
      const head = stringArg(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'branch']);
      const base = stringArg(args, ['base', 'base_ref', 'base_branch', 'target_branch']);
      if (!title || !head || !base) return toolError('create_pull_request: title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('create_pull_request: head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return toolError('create_pull_request: a pull request already exists for this branch');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const body = stringArg(args, ['body', 'description', 'content', 'text']) ?? '';
      const pull: Pull = {
        number,
        title,
        body,
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        seq: number,
        comments: [],
      };
      repo.pulls.set(number, pull);
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const found = repoOrError(forge, args);
      if ('error' in found) return toolError(`merge_pull_request: ${found.error}`);
      const repo = found.repo;
      const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']);
      if (number === null) return toolError('merge_pull_request: pull_number is required');
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`merge_pull_request: pull request #${number} not found`);
      if (pull.merged && pull.mergeCommitSha) {
        return toolResult({ merged: true, sha: pull.mergeCommitSha, number: pull.number, state: 'closed', message: 'Pull Request successfully merged' });
      }
      if (pull.state !== 'open') return toolError('merge_pull_request: pull request is not open');
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (!baseTip) return toolError('merge_pull_request: base branch not found');
      const merged = forge.threeWayMerge(repo, pull.headSha, baseTip);
      if ('conflict' in merged) return toolError('merge_pull_request: merge conflict');
      const treeOid = forge.buildTreeFromFlat(repo, merged.flat);
      const identity = `${forge.viewer.name} <${forge.viewer.email}>`;
      const data = buildCommit({
        tree: treeOid,
        parents: [baseTip, pull.headSha],
        message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`,
        author: identity,
        committer: identity,
        timestamp: FIXED_EPOCH_SEC,
      });
      const mergeSha = forge.putObject(repo, { type: 'commit', data });
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      repo.fetchCache.clear();
      pull.merged = true;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = FIXED_ISO;
      pull.state = 'closed';
      return toolResult({ merged: true, sha: mergeSha, number: pull.number, state: 'closed', message: 'Pull Request successfully merged' });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function discoverResult(): Record<string, unknown> {
  return {
    protocolVersion: SUPPORTED_VERSIONS[0],
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: { tools: {} },
    supportedVersions: [...SUPPORTED_VERSIONS],
  };
}

function mcpHandler(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  if (ctx.method !== 'POST') {
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendJson(ctx.res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = parsed.value;
  if (!isObject(request)) {
    sendJson(ctx.res, 200, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = request.id ?? null;
  const method = request.method;
  // A notification (no id) is answered 202 with an empty body.
  if (id === null && typeof method === 'string' && method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    ctx.res.end();
    return;
  }
  if (typeof method !== 'string') {
    sendJson(ctx.res, 200, rpcError(id, -32600, 'Invalid Request'));
    return;
  }
  const params = isObject(request.params) ? request.params : {};

  if (method === 'server/discover') {
    sendJson(ctx.res, 200, rpcResult(id, discoverResult()));
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : null;
    const version = requested && (SUPPORTED_VERSIONS.includes(requested) || LEGACY_VERSIONS.includes(requested)) ? requested : '2025-11-25';
    sendJson(
      ctx.res,
      200,
      rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      { 'mcp-session-id': 'mcp-session-1' },
    );
    return;
  }
  if (method === 'ping') {
    sendJson(ctx.res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(ctx.res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string') {
      sendJson(ctx.res, 200, rpcError(id, -32602, 'Invalid params: tools/call requires a tool name'));
      return;
    }
    if (!TOOL_NAMES.has(name)) {
      sendJson(ctx.res, 200, rpcError(id, -32601, `Method not found: ${name}`));
      return;
    }
    const args = isObject(params.arguments) ? params.arguments : {};
    const result = callTool(ctx.forge, name, args);
    sendJson(ctx.res, 200, rpcResult(id, result));
    return;
  }
  sendJson(ctx.res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}

export function registerMcpRoutes(router: Router, _forge: Forge): void {
  router.post('/mcp', mcpHandler);
  router.get('/mcp', mcpHandler);
}
