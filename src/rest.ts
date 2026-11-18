// GitHub REST v3 surface: the root/meta/user/repo/branch/commit/ref/content/
// label/issue/pull endpoints the conformance checks drive. Every reply is
// JSON with a non-empty X-GitHub-Request-Id; unknown routes are JSON 404s;
// a malformed JSON body is a 400; a missing or wrong bearer token is a 401.

import { buildCommit, hashObject, isOid, parseCommit, type GitObject } from './git.ts';
import {
  FIXED_EPOCH_SEC,
  FIXED_ISO,
  scenarioUsers,
  type ScenarioUser,
} from './seed.ts';
import {
  Forge,
  globalId,
  issueJson,
  pullJson,
  commentJson,
  repoJson,
  userJson,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  linkHeader,
  nextRequestId,
  notFound,
  pageParams,
  paginate,
  parseJsonBody,
  requireAuth,
  requestOrigin,
  sendError,
  sendJson,
  type Ctx,
  type Router,
} from './http.ts';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: JsonObject, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

function bodyObject(ctx: Ctx): { ok: true; body: JsonObject } | { ok: false } {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return { ok: false };
  if (!isObject(parsed.value)) return { ok: false };
  return { ok: true, body: parsed.value };
}

function repoOr404(ctx: Ctx): Repo | null {
  const repo = ctx.forge.getRepo(ctx.params.owner as string, ctx.params.repo as string);
  if (!repo) {
    notFound(ctx.res);
    return null;
  }
  return repo;
}

/** A paginated JSON list with a Link header when more pages exist. */
function listResponse<T>(ctx: Ctx, items: readonly T[], toJson: (item: T) => unknown): void {
  const { page, perPage } = pageParams(ctx.query);
  const { pageItems, total } = paginate(items, page, perPage);
  const link = linkHeader(requestOrigin(ctx), ctx.path, ctx.query, page, perPage, total);
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  sendJson(ctx.res, 200, pageItems.map(toJson), headers);
}

function stripTrailingNewline(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

function identityParts(line: string): { name: string; email: string } {
  const match = /^(.*?) <(.*?)>/.exec(line);
  if (!match) return { name: line, email: '' };
  return { name: match[1] as string, email: match[2] as string };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const author = identityParts(view.author);
  const committer = identityParts(view.committer);
  return {
    sha,
    node_id: globalId('Commit', `${repo.fullName}:${sha}`),
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.fullName}/commits/${sha}/comments`,
    commit: {
      url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      author: { name: author.name, email: author.email, date: FIXED_ISO },
      committer: { name: committer.name, email: committer.email, date: FIXED_ISO },
      message: stripTrailingNewline(view.message),
      tree: { sha: view.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${view.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(forge.viewer),
    committer: userJson(forge.viewer),
    parents: view.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.fullName}/commits/${parent}`,
      html_url: `https://github.com/${repo.fullName}/commit/${parent}`,
    })),
  };
}

function branchJson(forge: Forge, repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` },
    protected: false,
    protection_url: `/api/v3/repos/${repo.fullName}/branches/${encodeURIComponent(name)}/protection`,
  };
}

function refObjectType(repo: Repo, sha: string): string {
  return repo.objects.get(sha)?.type ?? 'commit';
}

function refJson(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    ref,
    node_id: globalId('Ref', `${repo.fullName}:${ref}`),
    url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
    object: {
      sha,
      type: refObjectType(repo, sha),
      url: `/api/v3/repos/${repo.fullName}/git/${refObjectType(repo, sha)}s/${sha}`,
    },
  };
}

/** Resolve a `?ref=` value (branch name or commit oid) to a commit oid. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.tip() ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (isOid(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
  }
  return null;
}

function contentUrl(repo: Repo, path: string): string {
  return `/api/v3/repos/${repo.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function fileEntryJson(repo: Repo, path: string, blob: GitObject): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const content = blob.data.toString('base64');
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content,
    sha: hashObject('blob', blob.data),
    url: contentUrl(repo, path),
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${hashObject('blob', blob.data)}`,
    html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
    _links: {
      git: `/api/v3/repos/${repo.fullName}/git/blobs/${hashObject('blob', blob.data)}`,
      self: contentUrl(repo, path),
      html: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

function dirEntryJson(repo: Repo, path: string, entry: { mode: string; oid: string; name: string }): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: contentUrl(repo, path),
    git_url: `/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `https://github.com/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}`,
    _links: {
      git: `/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      self: contentUrl(repo, path),
      html: `https://github.com/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    },
  };
}

function isValidBase64(value: string): boolean {
  const cleaned = value.replace(/\s/g, '');
  if (cleaned.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(cleaned);
}

function allUsers(): ScenarioUser[] {
  return scenarioUsers();
}

function userByLogin(login: string): ScenarioUser | undefined {
  return allUsers().find((user) => user.login === login);
}

// -------------------------------------------------------------------------------------------
// root / meta / users
// -------------------------------------------------------------------------------------------

function apiRoot(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function apiMeta(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  sendJson(ctx.res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, ssh_key_fingerprints: {}, hooks: [], git: [], pages: [], importer: [], actions: [] });
}

function getViewer(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  sendJson(ctx.res, 200, userJson(ctx.forge.viewer));
}

function getUser(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const user = userByLogin(ctx.params.login as string);
  if (!user) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, userJson(user));
}

function listViewerRepos(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  listResponse(ctx, ctx.forge.listReposByOwner(ctx.forge.viewer.login), (repo) => repoJson(ctx.forge, repo));
}

function listUserRepos(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const user = userByLogin(ctx.params.login as string);
  if (!user) {
    notFound(ctx.res);
    return;
  }
  listResponse(ctx, ctx.forge.listReposByOwner(user.login), (repo) => repoJson(ctx.forge, repo));
}

function createRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const name = stringField(parsed.body, 'name');
  if (!name) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Repository', code: 'missing_field', field: 'name', message: 'name is required' }],
    });
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name contains invalid characters' }],
    });
    return;
  }
  const description = stringField(parsed.body, 'description') ?? '';
  const isPrivate = typeof parsed.body.private === 'boolean' ? (parsed.body.private as boolean) : false;
  const defaultBranch = stringField(parsed.body, 'default_branch') ?? 'main';
  const repo = ctx.forge.createRepo(ctx.forge.viewer.login, name, { description, isPrivate, defaultBranch });
  if (!repo) {
    sendError(ctx.res, 422, 'Repository creation failed.', {
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return;
  }
  sendJson(ctx.res, 201, repoJson(ctx.forge, repo));
}

// -------------------------------------------------------------------------------------------
// repos
// -------------------------------------------------------------------------------------------

function getRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  sendJson(ctx.res, 200, repoJson(ctx.forge, repo));
}

function patchRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const newName = stringField(parsed.body, 'name');
  if (newName && newName !== repo.name) {
    if (!/^[A-Za-z0-9._-]+$/.test(newName) || ctx.forge.getRepo(repo.owner, newName)) {
      sendError(ctx.res, 422, 'Validation Failed', {
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
      return;
    }
    ctx.forge.deleteRepo(repo.owner, repo.name);
    repo.name = newName;
    ctx.forge.repos.set(ctx.forge.key(repo.owner, repo.name), repo);
  }
  const description = stringField(parsed.body, 'description');
  if (description !== null) repo.description = description;
  if (typeof parsed.body.private === 'boolean') repo.isPrivate = parsed.body.private as boolean;
  const defaultBranch = stringField(parsed.body, 'default_branch');
  if (defaultBranch) repo.defaultBranch = defaultBranch;
  sendJson(ctx.res, 200, repoJson(ctx.forge, repo));
}

function deleteRepo(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  ctx.forge.deleteRepo(repo.owner, repo.name);
  ctx.res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  ctx.res.end();
}

function listBranches(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({ name: ref.slice('refs/heads/'.length), sha: repo.refs.get(ref) as string }));
  listResponse(ctx, branches, (branch) => branchJson(ctx.forge, repo, branch.name, branch.sha));
}

function getBranch(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const sha = repo.refs.get(`refs/heads/${ctx.params.branch as string}`);
  if (!sha) {
    notFound(ctx.res, 'Branch not found');
    return;
  }
  sendJson(ctx.res, 200, branchJson(ctx.forge, repo, ctx.params.branch as string, sha));
}

function listCommits(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const tip = resolveRef(repo, ctx.query.get('sha'));
  if (!tip) {
    notFound(ctx.res, 'No commits found');
    return;
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    ordered.push(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  listResponse(ctx, ordered, (sha) => commitJson(ctx.forge, repo, sha));
}

function getCommit(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const body = commitJson(ctx.forge, repo, ctx.params.sha as string);
  if (!body) {
    notFound(ctx.res, 'No commit found for SHA');
    return;
  }
  sendJson(ctx.res, 200, body);
}

// -------------------------------------------------------------------------------------------
// git refs
// -------------------------------------------------------------------------------------------

function listRefs(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const refs = [...repo.refs.keys()].sort();
  listResponse(ctx, refs, (ref) => refJson(repo, ref, repo.refs.get(ref) as string));
}

function getRef(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const ref = `refs/${ctx.params.rest as string}`;
  const sha = repo.refs.get(ref);
  if (!sha) {
    notFound(ctx.res, 'Reference does not exist');
    return;
  }
  sendJson(ctx.res, 200, refJson(repo, ref, sha));
}

function createRef(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const ref = stringField(parsed.body, 'ref');
  const sha = stringField(parsed.body, 'sha');
  if (!ref || !ref.startsWith('refs/') || !sha || !isOid(sha) || !repo.objects.has(sha)) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Invalid request.' }],
    });
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Reference', code: 'custom', field: 'ref', message: 'Reference already exists' }],
    });
    return;
  }
  repo.refs.set(ref, sha);
  repo.fetchCache.clear();
  sendJson(ctx.res, 201, refJson(repo, ref, sha));
}

function patchRef(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const ref = `refs/${ctx.params.rest as string}`;
  const current = repo.refs.get(ref);
  if (!current) {
    notFound(ctx.res, 'Reference does not exist');
    return;
  }
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const sha = stringField(parsed.body, 'sha');
  const force = parsed.body.force === true;
  if (!sha || !isOid(sha) || !repo.objects.has(sha)) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Invalid request.' }],
    });
    return;
  }
  if (!force && ref.startsWith('refs/heads/')) {
    // Fast-forward only: the new commit must descend from the current tip.
    const seen = new Set<string>();
    const queue = [sha];
    let fastForward = false;
    while (queue.length) {
      const oid = queue.shift() as string;
      if (oid === current) {
        fastForward = true;
        break;
      }
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    if (!fastForward) {
      sendError(ctx.res, 422, 'Validation Failed', {
        errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Update is not a fast forward' }],
      });
      return;
    }
  }
  repo.refs.set(ref, sha);
  repo.fetchCache.clear();
  sendJson(ctx.res, 200, refJson(repo, ref, sha));
}

function deleteRef(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const ref = `refs/${ctx.params.rest as string}`;
  if (!repo.refs.has(ref)) {
    notFound(ctx.res, 'Reference does not exist');
    return;
  }
  repo.refs.delete(ref);
  repo.fetchCache.clear();
  ctx.res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  ctx.res.end();
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function getContents(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const path = (ctx.params.rest as string) ?? '';
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (!tip) {
    notFound(ctx.res, 'This repository is empty.');
    return;
  }
  const flat = ctx.forge.flattenCommit(repo, tip);
  if (path === '') {
    const entries = [...flat.entries()]
      .filter(([p]) => !p.includes('/'))
      .map(([p, entry]) => dirEntryJson(repo, p, { ...entry, name: p }));
    sendJson(ctx.res, 200, entries);
    return;
  }
  const file = flat.get(path);
  if (file) {
    const blob = repo.objects.get(file.oid);
    if (!blob) {
      notFound(ctx.res);
      return;
    }
    sendJson(ctx.res, 200, fileEntryJson(repo, path, blob));
    return;
  }
  // Directory?
  const prefix = `${path}/`;
  const children = new Map<string, { mode: string; oid: string; name: string }>();
  for (const [p, entry] of flat.entries()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0] as string;
    if (rest.includes('/')) {
      if (!children.has(first)) children.set(first, { mode: '40000', oid: '', name: first });
    } else {
      children.set(first, { ...entry, name: first });
    }
  }
  if (children.size === 0) {
    notFound(ctx.res);
    return;
  }
  const entries = [...children.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => dirEntryJson(repo, `${path}/${entry.name}`, entry));
  sendJson(ctx.res, 200, entries);
}

function commitFromContents(
  forge: Forge,
  repo: Repo,
  opts: { branch: string; tree: string; parents: string[]; message: string },
): string {
  const identity = `${forge.viewer.name} <${forge.viewer.email}>`;
  const data = buildCommit({
    tree: opts.tree,
    parents: opts.parents,
    message: opts.message,
    author: identity,
    committer: identity,
    timestamp: FIXED_EPOCH_SEC,
  });
  const oid = forge.putObject(repo, { type: 'commit', data });
  repo.refs.set(`refs/heads/${opts.branch}`, oid);
  repo.fetchCache.clear();
  return oid;
}

function putContents(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const path = (ctx.params.rest as string) ?? '';
  if (path === '' || path.endsWith('/')) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Content', code: 'custom', field: 'path', message: 'Invalid request.' }],
    });
    return;
  }
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const message = stringField(parsed.body, 'message');
  const content = stringField(parsed.body, 'content');
  if (!message || content === null || !isValidBase64(content)) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Content', code: 'custom', field: 'content', message: 'content is required' }],
    });
    return;
  }
  const branch = stringField(parsed.body, 'branch') ?? repo.defaultBranch;
  const givenSha = stringField(parsed.body, 'sha');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const flat = tip ? ctx.forge.flattenCommit(repo, tip) : new Map<string, { mode: string; oid: string }>();
  const existing = flat.get(path);
  if (existing && existing.mode === '40000') {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Content', code: 'custom', field: 'path', message: 'Is a directory' }],
    });
    return;
  }
  if (existing) {
    if (!givenSha || givenSha !== existing.oid) {
      sendError(ctx.res, 409, 'Conflict', { message: 'sha does not match the current blob' });
      return;
    }
  } else if (givenSha) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Content', code: 'custom', field: 'sha', message: 'Invalid request.' }],
    });
    return;
  }
  const bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  const blobOid = ctx.forge.putObject(repo, { type: 'blob', data: bytes });
  const nextFlat = new Map(flat);
  nextFlat.set(path, { mode: '100644', oid: blobOid });
  const treeOid = ctx.forge.buildTreeFromFlat(repo, nextFlat);
  const commitOid = commitFromContents(ctx.forge, repo, {
    branch,
    tree: treeOid,
    parents: tip ? [tip] : [],
    message,
  });
  sendJson(ctx.res, existing ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: bytes.length,
      url: contentUrl(repo, path),
      git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
      html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
      download_url: null,
      type: 'file',
      encoding: 'base64',
      _links: { git: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`, self: contentUrl(repo, path), html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const path = (ctx.params.rest as string) ?? '';
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const message = stringField(parsed.body, 'message');
  const givenSha = stringField(parsed.body, 'sha');
  if (!message || !givenSha) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Content', code: 'custom', field: 'sha', message: 'sha is required' }],
    });
    return;
  }
  const branch = stringField(parsed.body, 'branch') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    notFound(ctx.res);
    return;
  }
  const flat = ctx.forge.flattenCommit(repo, tip);
  const existing = flat.get(path);
  if (!existing) {
    notFound(ctx.res);
    return;
  }
  if (givenSha !== existing.oid) {
    sendError(ctx.res, 409, 'Conflict', { message: 'sha does not match the current blob' });
    return;
  }
  const nextFlat = new Map(flat);
  nextFlat.delete(path);
  const treeOid = ctx.forge.buildTreeFromFlat(repo, nextFlat);
  const commitOid = commitFromContents(ctx.forge, repo, { branch, tree: treeOid, parents: [tip], message });
  sendJson(ctx.res, 200, { commit: { sha: commitOid, message } });
}

// -------------------------------------------------------------------------------------------
// labels
// -------------------------------------------------------------------------------------------

function listLabels(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  listResponse(ctx, labels, (label) => ({
    id: 20000 + label.name.length * 7,
    node_id: globalId('Label', `${repo.fullName}:${label.name}`),
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  }));
}

function createLabel(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const name = stringField(parsed.body, 'name');
  if (!name) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Label', code: 'missing_field', field: 'name', message: 'name is required' }],
    });
    return;
  }
  if (repo.labels.has(name)) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Label', code: 'custom', field: 'name', message: 'Label already exists' }],
    });
    return;
  }
  const color = (stringField(parsed.body, 'color') ?? 'ededed').replace(/^#/, '');
  const description = stringField(parsed.body, 'description') ?? '';
  repo.labels.set(name, { name, color, description });
  sendJson(ctx.res, 201, {
    id: 20000 + name.length * 7,
    node_id: globalId('Label', `${repo.fullName}:${name}`),
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default: false,
    description,
  });
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function listIssues(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  listResponse(ctx, issues, (issue) => issueJson(ctx.forge, repo, issue));
}

function createIssue(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const title = stringField(parsed.body, 'title');
  if (!title) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'Issue', code: 'missing_field', field: 'title', message: 'title is required' }],
    });
    return;
  }
  const labels = Array.isArray(parsed.body.labels) ? (parsed.body.labels as unknown[]) : [];
  for (const label of labels) {
    if (typeof label !== 'string' || !repo.labels.has(label)) {
      sendError(ctx.res, 422, 'Validation Failed', {
        errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `Label does not exist: ${String(label)}` }],
      });
      return;
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    title,
    body: stringField(parsed.body, 'body') ?? '',
    state: 'open',
    labels: labels as string[],
    seq: number,
    comments: [],
  };
  repo.issues.set(number, issue);
  sendJson(ctx.res, 201, issueJson(ctx.forge, repo, issue));
}

function getIssue(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const issue = repo.issues.get(Number(ctx.params.number));
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, issueJson(ctx.forge, repo, issue));
}

function patchIssue(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const issue = repo.issues.get(Number(ctx.params.number));
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const state = stringField(parsed.body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(parsed.body, 'title');
  if (title !== null) issue.title = title;
  const body = stringField(parsed.body, 'body');
  if (body !== null) issue.body = body;
  if (Array.isArray(parsed.body.labels)) {
    const labels = parsed.body.labels as unknown[];
    for (const label of labels) {
      if (typeof label !== 'string' || !repo.labels.has(label)) {
        sendError(ctx.res, 422, 'Validation Failed', {
          errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `Label does not exist: ${String(label)}` }],
        });
        return;
      }
    }
    issue.labels = labels as string[];
  }
  sendJson(ctx.res, 200, issueJson(ctx.forge, repo, issue));
}

function listIssueComments(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const issue = repo.issues.get(Number(ctx.params.number));
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  listResponse(ctx, issue.comments, (comment) => commentJson(ctx.forge, repo, issue.number, comment));
}

function createIssueComment(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const issue = repo.issues.get(Number(ctx.params.number));
  if (!issue) {
    notFound(ctx.res);
    return;
  }
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const body = stringField(parsed.body, 'body');
  if (!body) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body', message: 'body is required' }],
    });
    return;
  }
  const comment: Comment = { id: repo.nextCommentId, body, seq: repo.nextCommentId };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  sendJson(ctx.res, 201, commentJson(ctx.forge, repo, issue.number, comment));
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function listPulls(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  listResponse(ctx, pulls, (pull) => pullJson(ctx.forge, repo, pull));
}

function createPull(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const parsed = bodyObject(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const title = stringField(parsed.body, 'title');
  const head = stringField(parsed.body, 'head');
  const base = stringField(parsed.body, 'base');
  if (!title || !head || !base) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title', message: 'title, head and base are required' }],
    });
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) {
    sendError(ctx.res, 422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'Head or base branch does not exist' }],
    });
    return;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      sendError(ctx.res, 422, 'Validation Failed', {
        errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'A pull request already exists for this branch' }],
      });
      return;
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title,
    body: stringField(parsed.body, 'body') ?? '',
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
  sendJson(ctx.res, 201, pullJson(ctx.forge, repo, pull));
}

function getPull(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const pull = repo.pulls.get(Number(ctx.params.number));
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  sendJson(ctx.res, 200, pullJson(ctx.forge, repo, pull));
}

function listPullFiles(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const pull = repo.pulls.get(Number(ctx.params.number));
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  const baseOid = ctx.forge.mergeBase(repo, pull.headSha, pull.baseSha);
  const baseFlat = baseOid ? ctx.forge.flattenCommit(repo, baseOid) : new Map<string, { mode: string; oid: string }>();
  const headFlat = ctx.forge.flattenCommit(repo, pull.headSha);
  const diff = ctx.forge.diffFlat(repo, baseFlat, headFlat);
  sendJson(
    ctx.res,
    200,
    diff.map((entry) => ({
      sha: entry.newOid ?? entry.oldOid ?? '',
      filename: entry.path,
      status: entry.status,
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.additions + entry.deletions,
      blob_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.newOid ?? entry.oldOid ?? ''}`,
      raw_url: `https://raw.githubusercontent.com/${repo.fullName}/${pull.head}/${entry.path}`,
      contents_url: contentUrl(repo, entry.path),
      patch: '',
    })),
  );
}

function listPullCommits(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const pull = repo.pulls.get(Number(ctx.params.number));
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  const baseAncestors = ctx.forge.ancestors(repo, pull.baseSha);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = [pull.headSha];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid) || baseAncestors.has(oid)) continue;
    seen.add(oid);
    ordered.push(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  listResponse(ctx, ordered, (sha) => commitJson(ctx.forge, repo, sha));
}

function mergePull(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = repoOr404(ctx);
  if (!repo) return;
  const pull = repo.pulls.get(Number(ctx.params.number));
  if (!pull) {
    notFound(ctx.res);
    return;
  }
  if (pull.merged && pull.mergeCommitSha) {
    sendJson(ctx.res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (pull.state !== 'open') {
    sendError(ctx.res, 405, 'Pull Request is not mergeable');
    return;
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseTip) {
    sendError(ctx.res, 409, 'Base branch not found');
    return;
  }
  const merged = ctx.forge.threeWayMerge(repo, pull.headSha, baseTip);
  if ('conflict' in merged) {
    sendError(ctx.res, 405, 'Merge conflict');
    return;
  }
  const treeOid = ctx.forge.buildTreeFromFlat(repo, merged.flat);
  const identity = `${ctx.forge.viewer.name} <${ctx.forge.viewer.email}>`;
  const data = buildCommit({
    tree: treeOid,
    parents: [baseTip, pull.headSha],
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`,
    author: identity,
    committer: identity,
    timestamp: FIXED_EPOCH_SEC,
  });
  const mergeSha = ctx.forge.putObject(repo, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  repo.fetchCache.clear();
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = FIXED_ISO;
  pull.state = 'closed';
  sendJson(ctx.res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

// -------------------------------------------------------------------------------------------
// registration
// -------------------------------------------------------------------------------------------

export function registerRestRoutes(router: Router, _forge: Forge): void {
  router.get('/api/v3', apiRoot);
  router.get('/api/v3/meta', apiMeta);
  router.get('/api/v3/user', getViewer);
  router.get('/api/v3/users/:login', getUser);
  router.get('/api/v3/user/repos', listViewerRepos);
  router.get('/api/v3/users/:login/repos', listUserRepos);
  router.post('/api/v3/user/repos', createRepo);

  router.get('/api/v3/repos/:owner/:repo', getRepo);
  router.patch('/api/v3/repos/:owner/:repo', patchRepo);
  router.delete('/api/v3/repos/:owner/:repo', deleteRepo);
  router.get('/api/v3/repos/:owner/:repo/branches', listBranches);
  router.get('/api/v3/repos/:owner/:repo/branches/:branch', getBranch);
  router.get('/api/v3/repos/:owner/:repo/commits', listCommits);
  router.get('/api/v3/repos/:owner/:repo/commits/:sha', getCommit);
  router.get('/api/v3/repos/:owner/:repo/git/refs', listRefs);
  router.get('/api/v3/repos/:owner/:repo/git/refs/*rest', getRef);
  router.post('/api/v3/repos/:owner/:repo/git/refs', createRef);
  router.patch('/api/v3/repos/:owner/:repo/git/refs/*rest', patchRef);
  router.delete('/api/v3/repos/:owner/:repo/git/refs/*rest', deleteRef);
  router.get('/api/v3/repos/:owner/:repo/contents', getContents);
  router.get('/api/v3/repos/:owner/:repo/contents/*rest', getContents);
  router.put('/api/v3/repos/:owner/:repo/contents/*rest', putContents);
  router.delete('/api/v3/repos/:owner/:repo/contents/*rest', deleteContents);
  router.get('/api/v3/repos/:owner/:repo/labels', listLabels);
  router.post('/api/v3/repos/:owner/:repo/labels', createLabel);
  router.get('/api/v3/repos/:owner/:repo/issues', listIssues);
  router.post('/api/v3/repos/:owner/:repo/issues', createIssue);
  router.get('/api/v3/repos/:owner/:repo/issues/:number', getIssue);
  router.patch('/api/v3/repos/:owner/:repo/issues/:number', patchIssue);
  router.get('/api/v3/repos/:owner/:repo/issues/:number/comments', listIssueComments);
  router.post('/api/v3/repos/:owner/:repo/issues/:number/comments', createIssueComment);
  router.get('/api/v3/repos/:owner/:repo/pulls', listPulls);
  router.post('/api/v3/repos/:owner/:repo/pulls', createPull);
  router.get('/api/v3/repos/:owner/:repo/pulls/:number', getPull);
  router.get('/api/v3/repos/:owner/:repo/pulls/:number/files', listPullFiles);
  router.get('/api/v3/repos/:owner/:repo/pulls/:number/commits', listPullCommits);
  router.put('/api/v3/repos/:owner/:repo/pulls/:number/merge', mergePull);
}
