// MCP (/mcp): JSON-RPC 2.0 over Streamable HTTP, written from scratch.
// Speaks revision 2026-07-28 (server/discover with supportedVersions) and the
// 2025-11-25 handshake (initialize + notifications/initialized). The tools act on
// the same store as REST, so a repo or issue made here reads back over /api/v3.

import type { Store } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';
import { buildCommit } from './objects.ts';
import { FIXED_EPOCH } from './util.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['pull_number'],
    },
  },
];

/** The tools list, frozen so two tools/list calls answer byte for byte. */
const TOOLS_JSON = JSON.stringify(TOOLS);

/** Read an argument by any of its names (case-insensitive), or from full_name. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) lower.set(k.toLowerCase(), v);
  for (const n of names) {
    if (lower.has(n.toLowerCase())) return lower.get(n.toLowerCase());
  }
  return undefined;
}

/** Split owner/repo out of the arguments (full_name, or owner + repo). */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  const full = arg(args, 'full_name', 'fullName', 'repository') as string | undefined;
  if (typeof full === 'string' && full.includes('/')) {
    const [owner, repo] = full.split('/', 2);
    return { owner, repo };
  }
  const owner = (arg(args, 'owner', 'owner_login') as string | undefined) ?? VIEWER_LOGIN;
  const repo = (arg(args, 'repo', 'repository_name', 'name') as string | undefined) ?? '';
  return { owner, repo };
}

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool. Returns the result object for the JSON-RPC result field. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const key = name.toLowerCase();
  // Match by suffix so a server prefix (github__create_issue) still finds the tool.
  const tool = TOOLS.find((t) => key === t.name || key.endsWith(`__${t.name}`) || key.endsWith(t.name));
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  const base = tool.name;

  if (base === 'create_repo') {
    const repoName = arg(args, 'name') as string | undefined;
    if (!repoName) return errorResult('Missing required argument: name');
    if (store.getRepo(VIEWER_LOGIN, repoName)) return errorResult(`Repository ${repoName} already exists`);
    const repo = store.createRepo(repoName, (arg(args, 'description') as string | undefined) ?? '', arg(args, 'private') === true);
    return textResult(JSON.stringify({ id: repo.databaseId, node_id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch }));
  }

  if (base === 'get_repo') {
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
    return textResult(JSON.stringify({ id: repo.databaseId, node_id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch }));
  }

  if (base === 'list_repos') {
    const list = store.listRepos().map((r) => ({ id: r.databaseId, name: r.name, full_name: r.fullName, private: r.isPrivate, description: r.description }));
    return textResult(JSON.stringify(list));
  }

  if (base === 'create_issue') {
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
    const title = arg(args, 'title') as string | undefined;
    if (!title) return errorResult('Missing required argument: title');
    const issue = repo.newIssue(title, (arg(args, 'body') as string | undefined) ?? '', []);
    return textResult(JSON.stringify({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, url: `https://github.com/${repo.fullName}/issues/${issue.number}` }));
  }

  if (base === 'get_issue') {
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
    const number = arg(args, 'issue_number', 'number') as number | undefined;
    const issue = number !== undefined ? repo.issues.get(number) : undefined;
    if (!issue) return errorResult(`Issue ${number} not found`);
    return textResult(JSON.stringify({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
  }

  if (base === 'list_issues') {
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
    const state = ((arg(args, 'state') as string | undefined) ?? 'open').toLowerCase();
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    return textResult(JSON.stringify(list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }))));
  }

  if (base === 'create_pull_request') {
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
    const title = arg(args, 'title') as string | undefined;
    const head = arg(args, 'head') as string | undefined;
    const baseBranch = arg(args, 'base') as string | undefined;
    if (!title) return errorResult('Missing required argument: title');
    if (!head) return errorResult('Missing required argument: head');
    if (!baseBranch) return errorResult('Missing required argument: base');
    const headSha = repo.ref(`refs/heads/${head}`);
    const baseSha = repo.ref(`refs/heads/${baseBranch}`);
    if (!headSha || !baseSha) return errorResult('Head or base branch does not exist');
    const pull = repo.newPull(title, (arg(args, 'body') as string | undefined) ?? '', head, headSha, baseBranch, baseSha);
    return textResult(JSON.stringify({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } }));
  }

  if (base === 'merge_pull_request') {
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
    const number = arg(args, 'pull_number', 'pullNumber', 'number') as number | undefined;
    if (number === undefined) return errorResult('Missing required argument: pull_number');
    const pull = repo.pulls.get(number);
    if (!pull) return errorResult(`Pull request ${number} not found`);
    if (pull.state !== 'open') return errorResult('Pull request is not open');
    const tip = repo.ref(`refs/heads/${pull.baseRef}`);
    if (!tip) return errorResult('Base branch not found');
    const headInfo = repo.commitInfo(pull.headSha);
    if (!headInfo) return errorResult('Head commit not found');
    const authorLine = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@users.noreply.github.com> ${FIXED_EPOCH} +0000`;
    const mergeCommit = buildCommit(headInfo.tree, [tip], `${pull.title} (#${pull.number})\n\n${pull.body}`, authorLine, authorLine);
    const mergeSha = repo.putObject('commit', mergeCommit);
    repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = mergeSha;
    pull.updatedAt = '2025-01-01T00:00:00Z';
    return textResult(JSON.stringify({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }));
  }

  return errorResult(`Unknown tool: ${name}`);
}

/** Handle one JSON-RPC request object. Returns the response object, or null for a notification. */
export function handleMcp(store: Store, req: unknown): Record<string, unknown> | null {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const body = req as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in body ? body.id : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });
  const err = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (method === 'server/discover') {
    return ok({
      serverInfo: { name: 'forge', version: '1.0.0' },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
    });
  }

  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
    const version = supported.includes(asked) ? asked : '2025-11-25';
    return ok({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // A notification gets no response.
  }

  if (method === 'ping') {
    return ok({});
  }

  if (method === 'tools/list') {
    return ok({ tools: JSON.parse(TOOLS_JSON) as ToolDef[], nextCursor: null });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) return err(-32602, 'Missing required parameter: name');
    // Unknown tool: -32601. Missing required argument: isError in the result.
    const known = TOOLS.some((t) => {
      const k = name.toLowerCase();
      return k === t.name || k.endsWith(`__${t.name}`) || k.endsWith(t.name);
    });
    if (!known) return err(-32601, `Method not found: ${name}`);
    const result = callTool(store, name, args);
    return ok(result);
  }

  if (isNotification) return null;
  return err(-32601, `Method not found: ${method}`);
}

export { TOOLS_JSON };
