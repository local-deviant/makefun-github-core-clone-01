// REST v3 (/api/v3), written from scratch. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry a JSON body with a string message; unknown routes
// are 404 JSON; malformed JSON bodies are 400. Auth is Bearer (or Basic) with the
// trial token; anything else is 401 with WWW-Authenticate.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_TIME, VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { buildCommit } from './objects.ts';
import { FIXED_EPOCH } from './util.ts';

export interface Ctx {
  store: Store;
  token: string;
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
}

export function jsonBody(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(text);
}

export function jsonError(ctx: Ctx, status: number, message: string): void {
  jsonBody(ctx.res, status, { message, documentation_url: 'https://docs.github.com/rest' }, ctx.requestId);
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${login}`, 'utf8').toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.databaseId,
    node_id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { id: label.id, node_id: Buffer.from(`Label:${label.name}`, 'utf8').toString('base64'), url: '', name: label.name, color: label.color, default: false, description: label.description };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.fullName}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name.toLowerCase());
      return l ? labelJson(l) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = repoJson(ctx, repo);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.fullName}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.user),
    labels: [],
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, repo: headRepo, user: userJson(repo.owner) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, repo: headRepo, user: userJson(repo.owner) },
    merged: pull.merged,
    mergeable: pull.state === 'open',
    merge_commit_sha: pull.mergeSha || null,
    merged_at: pull.merged ? pull.updatedAt : null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://x').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Paginate a list; writes the Link header when there is a next page. Returns the page slice. */
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const q = parseQuery(ctx.req);
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const host = ctx.req.headers.host ?? 'localhost';
  const path = (ctx.req.url ?? '/').split('?')[0];
  const links: string[] = [];
  const linkFor = (p: number, rel: string): string => `<http://${host}${path}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  if (page < totalPages) links.push(linkFor(page + 1, 'next'), linkFor(totalPages, 'last'));
  if (page > 1) links.push(linkFor(1, 'first'), linkFor(page - 1, 'prev'));
  if (links.length > 0) ctx.res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Resolve /repos/{owner}/{repo} from the path; 404 when the owner is not the viewer. */
function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | undefined {
  if (owner.toLowerCase() !== VIEWER_LOGIN) return undefined;
  return ctx.store.getRepo(owner, name);
}

function repoPathParts(path: string): string[] {
  return path.split('/').filter((p) => p !== '');
}

export async function routeRest(ctx: Ctx): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  const parts = repoPathParts(path);

  // API root.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    jsonBody(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, ctx.requestId, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (method === 'GET' && path === '/api/v3/meta') {
    jsonBody(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '3.14.0',
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: ['127.0.0.1'],
      git: ['127.0.0.1'],
      pages: ['127.0.0.1'],
      importer: ['127.0.0.1'],
      actions: ['127.0.0.1'],
      dependabot: ['127.0.0.1'],
    }, ctx.requestId);
    return true;
  }

  if (method === 'GET' && path === '/api/v3/rate_limit') {
    jsonBody(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 } }, ctx.requestId);
    return true;
  }

  if (method === 'GET' && path === '/api/v3/user') {
    jsonBody(res, 200, { ...userJson(VIEWER_LOGIN), name: 'Ada Iversen', email: null, bio: null, public_repos: ctx.store.listRepos().length }, ctx.requestId);
    return true;
  }

  // GET /user/repos and POST /user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const repos = ctx.store.listRepos();
      jsonBody(res, 200, paginate(ctx, repos.map((r) => repoJson(ctx, r))), ctx.requestId);
      return true;
    }
    if (method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch {
        jsonError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        jsonError(ctx, 422, 'Validation Failed: name is invalid');
        return true;
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, name)) {
        jsonError(ctx, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const repo = ctx.store.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      jsonBody(res, 201, repoJson(ctx, repo), ctx.requestId);
      return true;
    }
    return false;
  }

  // /repos/{owner}/{repo}[...]
  if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'repos') {
    const owner = parts[3];
    const name = decodeURIComponent(parts[4]);
    const repo = resolveRepo(ctx, owner, name);
    const rest = parts.slice(5);

    if (rest.length === 0) {
      if (!repo) { jsonError(ctx, 404, 'Not Found'); return true; }
      if (method === 'GET') { jsonBody(res, 200, repoJson(ctx, repo), ctx.requestId); return true; }
      if (method === 'PATCH') {
        let body: Record<string, unknown>;
        try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== repo.name) {
          // Renames are not supported by the suite; keep the name.
        }
        jsonBody(res, 200, repoJson(ctx, repo), ctx.requestId);
        return true;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': ctx.requestId });
        res.end();
        return true;
      }
      return false;
    }

    if (!repo) { jsonError(ctx, 404, 'Not Found'); return true; }

    // Branches.
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = repo.branches().map((b) => ({
          name: b,
          commit: { sha: repo.ref(`refs/heads/${b}`) ?? '', url: `/api/v3/repos/${repo.fullName}/commits/${repo.ref(`refs/heads/${b}`) ?? ''}` },
          protected: false,
        }));
        jsonBody(res, 200, paginate(ctx, list), ctx.requestId);
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decodeURIComponent(rest[1]);
        const sha = repo.ref(`refs/heads/${branch}`);
        if (!sha) { jsonError(ctx, 404, 'Not Found'); return true; }
        jsonBody(res, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false }, ctx.requestId);
        return true;
      }
      return false;
    }

    // Commits.
    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        // ?sha=<ref> walks from that branch, tag or commit instead of the default branch.
        const q = parseQuery(req);
        const shaParam = q.get('sha');
        let tip = repo.ref(`refs/heads/${repo.defaultBranch}`);
        if (shaParam) {
          tip = repo.ref(`refs/heads/${shaParam}`) ?? repo.ref(`refs/tags/${shaParam}`) ?? (repo.getObject(shaParam)?.type === 'commit' ? shaParam : undefined);
        }
        const ids = tip ? repo.walkCommits(tip, 100) : [];
        const list = ids.map((id) => commitJson(ctx, repo, id)).filter(Boolean);
        jsonBody(res, 200, paginate(ctx, list), ctx.requestId);
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = decodeURIComponent(rest[1]);
        const found = commitJson(ctx, repo, sha);
        if (!found) { jsonError(ctx, 404, 'Not Found'); return true; }
        jsonBody(res, 200, found, ctx.requestId);
        return true;
      }
      return false;
    }

    // Git refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        let body: Record<string, unknown>;
        try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
        const refName = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!refName.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.getObject(sha)) {
          jsonError(ctx, 422, 'Unprocessable Entity'); return true;
        }
        if (repo.refs.has(refName)) { jsonError(ctx, 422, 'Reference already exists'); return true; }
        repo.setRef(refName, sha);
        jsonBody(res, 201, {
          ref: refName,
          node_id: Buffer.from(`Ref:${repo.fullName}:${refName}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${repo.fullName}/git/refs/${refName.replace(/^refs\//, '')}`,
          object: { sha, type: repo.getObject(sha)?.type ?? 'commit', url: '' },
        }, ctx.requestId);
        return true;
      }
      if (method === 'PATCH' && rest.length >= 3) {
        let body: Record<string, unknown>;
        try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
        const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        if (!repo.refs.has(refName)) { jsonError(ctx, 404, 'Not Found'); return true; }
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!/^[0-9a-f]{40}$/.test(sha) || !repo.getObject(sha)) { jsonError(ctx, 422, 'Unprocessable Entity'); return true; }
        repo.setRef(refName, sha);
        jsonBody(res, 200, {
          ref: refName,
          node_id: Buffer.from(`Ref:${repo.fullName}:${refName}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${repo.fullName}/git/refs/${refName.replace(/^refs\//, '')}`,
          object: { sha, type: repo.getObject(sha)?.type ?? 'commit', url: '' },
        }, ctx.requestId);
        return true;
      }
      if (method === 'DELETE' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        if (!repo.deleteRef(refName)) { jsonError(ctx, 404, 'Not Found'); return true; }
        res.writeHead(204, { 'X-GitHub-Request-Id': ctx.requestId });
        res.end();
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const list = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => ({
          ref, node_id: Buffer.from(`Ref:${repo.fullName}:${ref}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: repo.getObject(sha)?.type ?? 'commit', url: '' },
        }));
        jsonBody(res, 200, paginate(ctx, list), ctx.requestId);
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        const sha = repo.refs.get(refName);
        if (!sha) { jsonError(ctx, 404, 'Not Found'); return true; }
        jsonBody(res, 200, { ref: refName, node_id: '', url: '', object: { sha, type: repo.getObject(sha)?.type ?? 'commit', url: '' } }, ctx.requestId);
        return true;
      }
      return false;
    }

    // Git trees / blobs / commits (read-only helpers).
    if (rest[0] === 'git' && rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
      const sha = decodeURIComponent(rest[2]);
      const entries = repo.treeEntries(sha);
      if (!entries) { jsonError(ctx, 404, 'Not Found'); return true; }
      jsonBody(res, 200, {
        sha, url: '', tree: entries.map((e) => ({ path: e.name, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.id, size: e.mode === '40000' ? undefined : repo.getObject(e.id)?.content.length, url: '' })),
        truncated: false,
      }, ctx.requestId);
      return true;
    }
    if (rest[0] === 'git' && rest[1] === 'blobs' && rest.length === 3 && method === 'GET') {
      const sha = decodeURIComponent(rest[2]);
      const obj = repo.getObject(sha);
      if (!obj || obj.type !== 'blob') { jsonError(ctx, 404, 'Not Found'); return true; }
      jsonBody(res, 200, { sha, url: '', content: obj.content.toString('base64'), encoding: 'base64', size: obj.content.length }, ctx.requestId);
      return true;
    }

    // Contents.
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      return routeContents(ctx, repo, filePath, method);
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        jsonBody(res, 200, [...repo.labels.values()].map(labelJson), ctx.requestId);
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        let body: Record<string, unknown>;
        try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (!labelName) { jsonError(ctx, 422, 'Validation Failed: name is required'); return true; }
        const existing = repo.labels.get(labelName.toLowerCase());
        if (existing) { jsonBody(res, 201, labelJson(existing), ctx.requestId); return true; }
        const label = repo.newLabel(labelName);
        if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
        if (typeof body.description === 'string') label.description = body.description;
        jsonBody(res, 201, labelJson(label), ctx.requestId);
        return true;
      }
      return false;
    }

    // Issues.
    if (rest[0] === 'issues') {
      return routeIssues(ctx, repo, rest.slice(1), method);
    }

    // Pulls.
    if (rest[0] === 'pulls') {
      return routePulls(ctx, repo, rest.slice(1), method);
    }

    return false;
  }

  return false;
}

/** Parse a git ident line ("Name <email> 1735689600 +0000") into name, email and ISO date. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (!m) return { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, date: FIXED_TIME };
  const date = new Date(parseInt(m[3], 10) * 1000).toISOString();
  return { name: m[1] || VIEWER_LOGIN, email: m[2] || `${VIEWER_LOGIN}@users.noreply.github.com`, date };
}

function commitJson(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> | undefined {
  const info = repo.commitInfo(sha);
  if (!info) return undefined;
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  const authorUser = author.email === `${VIEWER_LOGIN}@users.noreply.github.com` ? userJson(VIEWER_LOGIN) : null;
  const committerUser = committer.email === `${VIEWER_LOGIN}@users.noreply.github.com` ? userJson(VIEWER_LOGIN) : null;
  return {
    sha,
    node_id: Buffer.from(`Commit:${repo.fullName}:${sha}`, 'utf8').toString('base64'),
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    commit: {
      message: info.message,
      author,
      committer,
      tree: { sha: info.tree, url: '' },
    },
    author: authorUser,
    committer: committerUser,
    parents: info.parents.map((p) => ({ sha: p, url: '' })),
  };
}

async function routeContents(ctx: Ctx, repo: Repo, filePath: string, method: string): Promise<boolean> {
  const { req, res } = ctx;
  const q = parseQuery(req);
  const branch = q.get('ref') ?? repo.defaultBranch;
  if (method === 'GET') {
    const tip = repo.ref(`refs/heads/${branch}`);
    if (!tip) { jsonError(ctx, 404, 'Not Found'); return true; }
    const info = repo.commitInfo(tip);
    if (!info) { jsonError(ctx, 404, 'Not Found'); return true; }
    if (filePath === '') {
      const entries = repo.listPath(info.tree, '') ?? [];
      jsonBody(res, 200, entries.map((e) => contentEntryJson(repo, e, '')), ctx.requestId);
      return true;
    }
    const blobId = repo.getPathBlob(info.tree, filePath);
    if (blobId !== undefined) {
      const obj = repo.getObject(blobId);
      jsonBody(res, 200, {
        type: 'file', encoding: 'base64', size: obj?.content.length ?? 0,
        name: filePath.split('/').pop(), path: filePath,
        content: obj?.content.toString('base64') ?? '',
        sha: blobId, url: '', html_url: '', git_url: '', download_url: null,
      }, ctx.requestId);
      return true;
    }
    const dir = repo.listPath(info.tree, filePath);
    if (dir) {
      jsonBody(res, 200, dir.map((e) => contentEntryJson(repo, e, filePath)), ctx.requestId);
      return true;
    }
    jsonError(ctx, 404, 'Not Found');
    return true;
  }
  if (method === 'PUT') {
    let body: Record<string, unknown>;
    try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
    const targetBranch = typeof body.branch === 'string' ? body.branch : branch;
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = repo.ref(`refs/heads/${targetBranch}`);
    const currentBlob = tip ? repo.getPathBlob(repo.commitInfo(tip)?.tree ?? '', filePath) : undefined;
    if (givenSha !== undefined && currentBlob !== undefined && givenSha !== currentBlob) {
      jsonError(ctx, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    if (givenSha !== undefined && currentBlob === undefined) {
      jsonError(ctx, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const isCreate = currentBlob === undefined;
    const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    const commitId = repo.commitFile(targetBranch, filePath, content, message);
    const blobId = repo.getPathBlob(repo.commitInfo(commitId)?.tree ?? '', filePath) ?? '';
    jsonBody(res, isCreate ? 201 : 200, {
      content: { type: 'file', encoding: 'base64', size: content.length, name: filePath.split('/').pop(), path: filePath, content: contentB64, sha: blobId, url: '' },
      commit: { sha: commitId, message, author: { name: VIEWER_LOGIN, date: FIXED_TIME }, committer: { name: VIEWER_LOGIN, date: FIXED_TIME } },
    }, ctx.requestId);
    return true;
  }
  if (method === 'DELETE') {
    let body: Record<string, unknown> = {};
    try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
    const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
    const targetBranch = typeof body.branch === 'string' ? body.branch : branch;
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = repo.ref(`refs/heads/${targetBranch}`);
    const currentBlob = tip ? repo.getPathBlob(repo.commitInfo(tip)?.tree ?? '', filePath) : undefined;
    if (currentBlob === undefined) { jsonError(ctx, 404, 'Not Found'); return true; }
    if (givenSha !== undefined && givenSha !== currentBlob) {
      jsonError(ctx, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const commitId = repo.deleteFile(targetBranch, filePath, message);
    if (!commitId) { jsonError(ctx, 404, 'Not Found'); return true; }
    jsonBody(res, 200, { commit: { sha: commitId, message } }, ctx.requestId);
    return true;
  }
  return false;
}

function contentEntryJson(repo: Repo, e: { mode: string; name: string; id: string }, parent: string): Record<string, unknown> {
  const path = parent ? `${parent}/${e.name}` : e.name;
  const isDir = e.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file', size: isDir ? 0 : (repo.getObject(e.id)?.content.length ?? 0),
    name: e.name, path, sha: e.id, url: '', html_url: '', git_url: '', download_url: null,
  };
}

async function routeIssues(ctx: Ctx, repo: Repo, rest: string[], method: string): Promise<boolean> {
  const { req, res } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const q = parseQuery(req);
      const state = (q.get('state') ?? 'open').toLowerCase();
      const sort = (q.get('sort') ?? 'created').toLowerCase();
      const direction = (q.get('direction') ?? 'desc').toLowerCase();
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => {
        const cmp = sort === 'created' ? a.number - b.number : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      jsonBody(res, 200, paginate(ctx, list.map((i) => issueJson(ctx, repo, i))), ctx.requestId);
      return true;
    }
    if (method === 'POST') {
      let body: Record<string, unknown>;
      try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) { jsonError(ctx, 422, 'Validation Failed: title is required'); return true; }
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) {
        if (!repo.labels.has(l.toLowerCase())) {
          jsonBody(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `Label "${l}" does not exist` }] }, ctx.requestId);
          return true;
        }
      }
      const issue = repo.newIssue(title, typeof body.body === 'string' ? body.body : '', labels);
      jsonBody(res, 201, issueJson(ctx, repo, issue), ctx.requestId);
      return true;
    }
    return false;
  }
  const number = parseInt(rest[0], 10);
  if (Number.isNaN(number)) return false;
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (!issue) { jsonError(ctx, 404, 'Not Found'); return true; }
    if (method === 'GET') { jsonBody(res, 200, issueJson(ctx, repo, issue), ctx.requestId); return true; }
    if (method === 'PATCH') {
      let body: Record<string, unknown>;
      try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const l of labels) {
          if (!repo.labels.has(l.toLowerCase())) {
            jsonBody(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `Label "${l}" does not exist` }] }, ctx.requestId);
            return true;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = FIXED_TIME;
      jsonBody(res, 200, issueJson(ctx, repo, issue), ctx.requestId);
      return true;
    }
    return false;
  }
  if (rest[1] === 'comments') {
    if (!issue) { jsonError(ctx, 404, 'Not Found'); return true; }
    if (method === 'GET') {
      jsonBody(res, 200, issue.comments.map((c) => ({
        id: c.id, node_id: Buffer.from(`Comment:${c.id}`, 'utf8').toString('base64'),
        body: c.body, user: userJson(c.user), created_at: c.createdAt, updated_at: c.createdAt,
      })), ctx.requestId);
      return true;
    }
    if (method === 'POST') {
      let body: Record<string, unknown>;
      try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (!commentBody) { jsonError(ctx, 422, 'Validation Failed: body is required'); return true; }
      const comment = repo.newComment(issue, commentBody);
      jsonBody(res, 201, {
        id: comment.id, node_id: Buffer.from(`Comment:${comment.id}`, 'utf8').toString('base64'),
        body: comment.body, user: userJson(comment.user), created_at: comment.createdAt, updated_at: comment.createdAt,
      }, ctx.requestId);
      return true;
    }
    return false;
  }
  return false;
}

async function routePulls(ctx: Ctx, repo: Repo, rest: string[], method: string): Promise<boolean> {
  const { req, res } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const q = parseQuery(req);
      const state = (q.get('state') ?? 'open').toLowerCase();
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      jsonBody(res, 200, paginate(ctx, list.map((p) => pullJson(ctx, repo, p))), ctx.requestId);
      return true;
    }
    if (method === 'POST') {
      let body: Record<string, unknown>;
      try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (!title || !head) { jsonError(ctx, 422, 'Validation Failed: title and head are required'); return true; }
      const headSha = repo.ref(`refs/heads/${head}`);
      const baseSha = repo.ref(`refs/heads/${base}`);
      if (!headSha || !baseSha) { jsonError(ctx, 422, 'Validation Failed: head or base branch does not exist'); return true; }
      const pull = repo.newPull(title, typeof body.body === 'string' ? body.body : '', head, headSha, base, baseSha);
      jsonBody(res, 201, pullJson(ctx, repo, pull), ctx.requestId);
      return true;
    }
    return false;
  }
  const number = parseInt(rest[0], 10);
  if (Number.isNaN(number)) return false;
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (!pull) { jsonError(ctx, 404, 'Not Found'); return true; }
    if (method === 'GET') { jsonBody(res, 200, pullJson(ctx, repo, pull), ctx.requestId); return true; }
    if (method === 'PATCH') {
      let body: Record<string, unknown>;
      try { body = (await readJsonBody(req)) as Record<string, unknown>; } catch { jsonError(ctx, 400, 'Problems parsing JSON'); return true; }
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      pull.updatedAt = FIXED_TIME;
      jsonBody(res, 200, pullJson(ctx, repo, pull), ctx.requestId);
      return true;
    }
    return false;
  }
  if (rest[1] === 'files' && method === 'GET') {
    if (!pull) { jsonError(ctx, 404, 'Not Found'); return true; }
    const files = diffFiles(repo, pull.baseSha, pull.headSha);
    jsonBody(res, 200, paginate(ctx, files), ctx.requestId);
    return true;
  }
  if (rest[1] === 'merge' && method === 'PUT') {
    if (!pull) { jsonError(ctx, 404, 'Not Found'); return true; }
    if (pull.state !== 'open') { jsonError(ctx, 405, 'Pull request is already closed'); return true; }
    const result = repo.mergePull(pull);
    if (!result.ok && result.reason === 'not-found') { jsonError(ctx, 404, 'Not Found'); return true; }
    if (!result.ok && result.reason === 'conflict') { jsonBody(res, 405, { message: 'Merge conflict' }, ctx.requestId); return true; }
    if (!result.ok) { jsonError(ctx, 405, 'Pull request is already closed'); return true; }
    jsonBody(res, 200, { sha: result.sha, merged: true, message: `Pull Request successfully merged` }, ctx.requestId);
    return true;
  }
  return false;
}

/** Files changed between two commits, as GitHub's pull files list. */
function diffFiles(repo: Repo, baseSha: string, headSha: string): Array<Record<string, unknown>> {
  return repo.diffFiles(baseSha, headSha).map((f) => ({
    sha: f.sha, filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions,
    blob_url: '', raw_url: '', contents_url: '',
  }));
}

/** True when the same paths changed from base→head and from base→tip. */
function hasOverlap(repo: Repo, baseSha: string, headSha: string, tipSha: string): boolean {
  const baseInfo = repo.commitInfo(baseSha);
  const headInfo = repo.commitInfo(headSha);
  const tipInfo = repo.commitInfo(tipSha);
  if (!baseInfo || !headInfo || !tipInfo) return false;
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  const tipFiles = new Map<string, string>();
  repo.collectFiles(baseInfo.tree, '', baseFiles);
  repo.collectFiles(headInfo.tree, '', headFiles);
  repo.collectFiles(tipInfo.tree, '', tipFiles);
  const changedHead = new Set<string>();
  for (const p of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    if (baseFiles.get(p) !== headFiles.get(p)) changedHead.add(p);
  }
  for (const p of new Set([...baseFiles.keys(), ...tipFiles.keys()])) {
    if (baseFiles.get(p) !== tipFiles.get(p) && changedHead.has(p)) return true;
  }
  return false;
}
