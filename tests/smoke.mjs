// Smoke test for the forge: starts the real entrypoint in dev mode, then exercises
// REST, GraphQL, MCP and a REAL git CLI. Run: node tests/smoke.mjs
// Exits 0 only when every check passes.

import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'dev-token';
let base = '';
let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function main() {
  const server = spawn('node', ['--experimental-strip-types', 'main.ts'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let port = 0;
  const portP = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not print a port')), 15000);
    server.stdout.on('data', (d) => {
      const m = /listening on port (\d+)/.exec(d.toString());
      if (m) {
        clearTimeout(timer);
        port = parseInt(m[1], 10);
        resolve(port);
      }
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  });
  await portP;
  base = `http://127.0.0.1:${port}`;
  console.log(`server on ${base}`);

  try {
    // ---- REST: root / meta / user ----
    let r = await req('/healthz', { headers: { Authorization: '' } });
    check('healthz 200 ok', r.status === 200 && r.json?.ok === true, `${r.status} ${r.text.slice(0, 80)}`);
    r = await req('/api/v3/');
    check('GET /api/v3 200 + scopes', r.status === 200 && (r.headers.get('x-oauth-scopes') ?? '').includes('repo'), `${r.status}`);
    r = await req('/api/v3/meta');
    check('GET /meta installed_version', r.status === 200 && typeof r.json?.installed_version === 'string' && r.json.installed_version.length > 0, `${r.status}`);
    r = await fetch(base + '/api/v3/meta');
    check('no token -> 401', r.status === 401, `${r.status}`);
    r = await req('/api/v3/user');
    check('GET /user login adaiversen', r.status === 200 && r.json?.login === 'adaiversen', `${r.status} ${r.text.slice(0, 100)}`);
    r = await req('/api/v3/no-such-route/x');
    check('unknown route 404 JSON', r.status === 404 && typeof r.json?.message === 'string', `${r.status}`);
    r = await fetch(base + '/api/v3/user/repos', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{bad json' });
    check('malformed JSON 400', r.status === 400, `${r.status}`);

    // ---- REST: repos ----
    r = await req('/api/v3/user/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'smoke-repo', description: 'smoke', private: true }) });
    check('POST /user/repos 201', r.status === 201 && r.json?.name === 'smoke-repo', `${r.status} ${r.text.slice(0, 120)}`);
    const repoId = r.json?.id;
    r = await req('/api/v3/repos/adaiversen/smoke-repo');
    check('GET repo 200', r.status === 200 && r.json?.full_name === 'adaiversen/smoke-repo', `${r.status}`);
    r = await req('/api/v3/repos/someone-else/smoke-repo');
    check('foreign owner 404', r.status === 404, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'patched' }) });
    check('PATCH repo description', r.status === 200 && r.json?.description === 'patched', `${r.status}`);
    // Pagination: create 35 repos, page through with per_page=10.
    for (let i = 0; i < 35; i++) {
      await req('/api/v3/user/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `page-repo-${i}` }) });
    }
    r = await req('/api/v3/user/repos?per_page=10&page=1');
    const link = r.headers.get('link') ?? '';
    check('pagination Link rel=next', Array.isArray(r.json) && r.json.length === 10 && link.includes('rel="next"'), `len=${Array.isArray(r.json) ? r.json.length : '?'} link=${link.slice(0, 80)}`);
    r = await req('/api/v3/user/repos?per_page=10&page=4');
    check('pagination page 4 has 6', Array.isArray(r.json) && r.json.length === 6, `len=${Array.isArray(r.json) ? r.json.length : '?'}`);
    void repoId;

    // ---- REST: contents ----
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    r = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'add hello', content: b64('hello world') }) });
    check('PUT contents create 201', r.status === 201 && r.json?.content?.sha, `${r.status} ${r.text.slice(0, 120)}`);
    const sha1 = r.json?.content?.sha;
    r = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt');
    check('GET contents file', r.status === 200 && r.json?.content === b64('hello world'), `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'update', content: b64('hello v2'), sha: sha1 }) });
    check('PUT contents update 200', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'stale', content: b64('x'), sha: sha1 }) });
    check('PUT contents stale sha 409', r.status === 409, `${r.status}`);
    // DELETE needs the current sha; fetch it first.
    const cur = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt');
    r = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'delete', sha: cur.json?.sha }) });
    check('DELETE contents 200 + commit sha', r.status === 200 && r.json?.commit?.sha, `${r.status} ${r.text.slice(0, 100)}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/contents/hello.txt');
    check('GET deleted contents 404', r.status === 404, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/branches');
    check('GET branches lists main', r.status === 200 && Array.isArray(r.json) && r.json.some((b) => b.name === 'main'), `${r.status} ${r.text.slice(0, 120)}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/commits');
    check('GET commits non-empty', r.status === 200 && Array.isArray(r.json) && r.json.length >= 2, `${r.status} len=${Array.isArray(r.json) ? r.json.length : '?'}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/git/refs');
    check('GET git refs', r.status === 200 && Array.isArray(r.json) && r.json.length >= 1, `${r.status}`);

    // ---- REST: labels / issues / comments ----
    r = await req('/api/v3/repos/adaiversen/smoke-repo/labels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bug' }) });
    check('POST label 201', r.status === 201 && r.json?.name === 'bug', `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'first issue', body: 'body 1', labels: ['bug'] }) });
    check('POST issue 201 open', r.status === 201 && r.json?.state === 'open' && r.json?.number === 1, `${r.status} ${r.text.slice(0, 120)}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'bad label', labels: ['nope'] }) });
    check('POST issue unknown label 422', r.status === 422, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'second issue' }) });
    check('POST issue number 2', r.status === 201 && r.json?.number === 2, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues/1/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'a comment' }) });
    check('POST comment 201', r.status === 201 && r.json?.body === 'a comment', `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues/1');
    check('GET issue 1 comments=1', r.status === 200 && r.json?.comments === 1, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues?state=open');
    check('GET issues open=2', r.status === 200 && Array.isArray(r.json) && r.json.length === 2, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) });
    check('PATCH issue closed', r.status === 200 && r.json?.state === 'closed', `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues?state=open');
    check('GET issues open=1 after close', r.status === 200 && Array.isArray(r.json) && r.json.length === 1, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo/issues?state=open&sort=created&direction=asc');
    check('GET issues asc', r.status === 200 && Array.isArray(r.json) && r.json[0]?.number === 2, `${r.status}`);

    // ---- REST: PRs ----
    // Push a feature branch via contents on a new branch is not supported; use git below.
    // Instead create the branch by pushing with git first (done in the git section), then PR here.
    // For now, test the PR endpoints against the git-created branch later.
    r = await req('/api/v3/repos/adaiversen/smoke-repo/pulls/99');
    check('GET unknown PR 404', r.status === 404, `${r.status}`);

    // ---- GraphQL ----
    const gql = async (query, variables = {}) => {
      const res = await fetch(base + '/api/graphql', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      return { status: res.status, json: await res.json() };
    };
    let g = await gql('query ViewerLogin { viewer { login } }');
    check('gql viewer login', g.status === 200 && g.json?.data?.viewer?.login === 'adaiversen', `${g.status} ${JSON.stringify(g.json).slice(0, 120)}`);
    g = await gql('query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }');
    const issueFields = (g.json?.data?.Issue?.fields ?? []).map((f) => f.name);
    check('gql __type Issue fields', ['id', 'number', 'title', 'state', 'body'].every((f) => issueFields.includes(f)), issueFields.join(','));
    g = await gql('query PRRepo { PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }');
    const prFields = (g.json?.data?.PullRequest?.fields ?? []).map((f) => f.name);
    const repoFields = (g.json?.data?.Repository?.fields ?? []).map((f) => f.name);
    check('gql __type PullRequest fields', ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prFields.includes(f)), prFields.join(','));
    check('gql __type Repository fields', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((f) => repoFields.includes(f)), repoFields.join(','));
    g = await gql('query ST { SearchType: __type(name: "SearchType") { enumValues { name } } }');
    const enums = (g.json?.data?.SearchType?.enumValues ?? []).map((e) => e.name);
    check('gql SearchType has ISSUE', enums.includes('ISSUE'), enums.join(','));
    g = await gql('query Bad { viewer { login noSuchFieldOnViewer } }');
    check('gql unknown field 200 + errors', g.status === 200 && Array.isArray(g.json?.errors) && g.json.errors.some((e) => e.message.includes('noSuchFieldOnViewer')), `${g.status} ${JSON.stringify(g.json).slice(0, 150)}`);
    g = await gql('query Repo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name } }', { owner: 'adaiversen', name: 'no-such-repo' });
    check('gql unknown repo null no errors', g.status === 200 && g.json?.data?.repository === null && !g.json?.errors, JSON.stringify(g.json).slice(0, 120));
    g = await gql('query Repo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name nameWithOwner owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }', { owner: 'adaiversen', name: 'smoke-repo' });
    check('gql repository fields', g.status === 200 && g.json?.data?.repository?.nameWithOwner === 'adaiversen/smoke-repo' && g.json?.data?.repository?.owner?.login === 'adaiversen', JSON.stringify(g.json).slice(0, 160));
    // createIssue via GraphQL
    const repoNodeId = g.json?.data?.repository?.id;
    g = await gql('mutation CI($input: CreateIssueInput!) { createIssue(input: $input) { issue { number title state } } }', { input: { repositoryId: repoNodeId, title: 'gql issue', body: 'via graphql' } });
    check('gql createIssue', g.status === 200 && g.json?.data?.createIssue?.issue?.number === 3, JSON.stringify(g.json).slice(0, 160));
    g = await gql('query OpenIssues($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(orderBy: {field: CREATED_AT, direction: DESC}, states: [OPEN]) { nodes { number } totalCount } } }', { owner: 'adaiversen', name: 'smoke-repo' });
    const nums = (g.json?.data?.repository?.issues?.nodes ?? []).map((n) => n.number);
    check('gql issues DESC open only', JSON.stringify(nums) === JSON.stringify([3, 2]), `nums=${JSON.stringify(nums)}`);
    // Batched documents.
    const batchRes = await fetch(base + '/api/graphql', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify([{ query: 'query ViewerLogin { viewer { login } }', variables: {} }, { query: 'query Issue_fields { Issue: __type(name: "Issue") { fields { name } } }', variables: {} }]) });
    const batch = await batchRes.json();
    check('gql batched two results in order', Array.isArray(batch) && batch.length === 2 && batch[0]?.data?.viewer?.login === 'adaiversen' && Array.isArray(batch[1]?.data?.Issue?.fields), `${batchRes.status}`);
    const noAuthGql = await fetch(base + '/api/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { viewer { login } }' }) });
    check('gql no token 401', noAuthGql.status === 401, `${noAuthGql.status}`);

    // ---- MCP ----
    const mcp = async (body, headers = {}) => {
      const res = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* empty */ }
      return { status: res.status, json, text };
    };
    let m = await mcp({ jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    check('mcp discover supportedVersions', m.status === 200 && Array.isArray(m.json?.result?.supportedVersions) && m.json.result.supportedVersions.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(m.json.result.supportedVersions[0]), JSON.stringify(m.json).slice(0, 160));
    m = await mcp({ jsonrpc: '2.0', id: 'initialize-1', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } });
    check('mcp legacy initialize', m.status === 200 && m.json?.result?.protocolVersion === '2025-11-25', JSON.stringify(m.json).slice(0, 160));
    m = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    check('mcp notification 202', m.status === 202, `${m.status}`);
    m = await mcp({ jsonrpc: '2.0', id: 'tl-1', method: 'tools/list', params: {} });
    const toolNames = (m.json?.result?.tools ?? []).map((t) => t.name);
    check('mcp tools/list 6+ tools', ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((t) => toolNames.includes(t)), toolNames.join(','));
    const list1 = JSON.stringify(m.json?.result?.tools);
    m = await mcp({ jsonrpc: '2.0', id: 'tl-2', method: 'tools/list', params: {} });
    check('mcp tools/list byte-identical', JSON.stringify(m.json?.result?.tools) === list1, '');
    // create repo + issue over MCP, read back over REST.
    m = await mcp({ jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
    check('mcp create_repo', m.status === 200 && !m.json?.result?.isError, JSON.stringify(m.json).slice(0, 160));
    m = await mcp({ jsonrpc: '2.0', id: 'c2', method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp issue', body: 'hi' } } });
    check('mcp create_issue', m.status === 200 && !m.json?.result?.isError, JSON.stringify(m.json).slice(0, 160));
    r = await req('/api/v3/repos/adaiversen/mcp-repo/issues/1');
    check('mcp issue reads back over REST', r.status === 200 && r.json?.title === 'mcp issue', `${r.status}`);
    m = await mcp({ jsonrpc: '2.0', id: 'c3', method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } });
    check('mcp list_issues', m.status === 200 && (m.json?.result?.content?.[0]?.text ?? '').includes('mcp issue'), JSON.stringify(m.json).slice(0, 160));
    m = await mcp({ jsonrpc: '2.0', id: 'c4', method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    check('mcp unknown tool -32601/-32602', m.json?.error?.code === -32601 || m.json?.error?.code === -32602, JSON.stringify(m.json).slice(0, 120));
    m = await mcp({ jsonrpc: '2.0', id: 'c5', method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } });
    check('mcp missing arg isError/-32602', m.json?.result?.isError === true || m.json?.error?.code === -32602, JSON.stringify(m.json).slice(0, 120));
    m = await mcp('this is not json');
    check('mcp non-JSON 400/-32700', m.status === 400 && m.json?.error?.code === -32700, `${m.status} ${m.text.slice(0, 120)}`);
    const noAuthMcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/list', params: {} }) });
    check('mcp no token 401', noAuthMcp.status === 401, `${noAuthMcp.status}`);
    // Two concurrent tools/call keep their ids.
    const [p1, p2] = await Promise.all([
      mcp({ jsonrpc: '2.0', id: 'conc-1', method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } }),
      mcp({ jsonrpc: '2.0', id: 'conc-2', method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } }),
    ]);
    check('mcp concurrent ids kept', p1.json?.id === 'conc-1' && p2.json?.id === 'conc-2' && (p1.json?.result?.content?.[0]?.text ?? '').includes('mcp-repo') && (p2.json?.result?.content?.[0]?.text ?? '').includes('mcp issue'), '');

    // ---- Real git CLI ----
    const work = mkdtempSync(join(tmpdir(), 'forge-smoke-'));
    const remote = (repo) => `http://adaiversen:${TOKEN}@127.0.0.1:${port}/adaiversen/${repo}.git`;
    const cfg = ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', '-c', 'protocol.version=2'];
    let gres = await git([...cfg, 'clone', remote('smoke-repo'), 'c1'], work);
    check('git clone (v2) ok', gres.code === 0, `code=${gres.code} ${gres.stderr.slice(0, 200)}`);
    writeFileSync(join(work, 'c1', 'a.txt'), 'alpha\n');
    gres = await git([...cfg, 'add', 'a.txt'], join(work, 'c1'));
    gres = await git([...cfg, 'commit', '-m', 'first'], join(work, 'c1'));
    check('git commit ok', gres.code === 0, gres.stderr.slice(0, 150));
    gres = await git([...cfg, 'push', 'origin', 'main'], join(work, 'c1'));
    check('git push main ok', gres.code === 0, `code=${gres.code} ${gres.stderr.slice(0, 300)}`);
    // Shallow clone depth 1.
    gres = await git([...cfg, 'clone', '--depth', '1', remote('smoke-repo'), 'c2'], work);
    check('git shallow clone depth 1', gres.code === 0, `code=${gres.code} ${gres.stderr.slice(0, 200)}`);
    // Push a new branch.
    gres = await git([...cfg, 'checkout', '-b', 'feature'], join(work, 'c1'));
    writeFileSync(join(work, 'c1', 'b.txt'), 'beta\n');
    await git([...cfg, 'add', 'b.txt'], join(work, 'c1'));
    await git([...cfg, 'commit', '-m', 'feature work'], join(work, 'c1'));
    gres = await git([...cfg, 'push', 'origin', 'feature'], join(work, 'c1'));
    check('git push new branch ok', gres.code === 0, `code=${gres.code} ${gres.stderr.slice(0, 300)}`);
    // PR via REST on the feature branch.
    r = await req('/api/v3/repos/adaiversen/smoke-repo/pulls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'add beta', head: 'feature', base: 'main' }) });
    check('POST pull 201', r.status === 201 && r.json?.state === 'open' && r.json?.head?.ref === 'feature', `${r.status} ${r.text.slice(0, 150)}`);
    const prNumber = r.json?.number;
    r = await req(`/api/v3/repos/adaiversen/smoke-repo/pulls/${prNumber}/files`);
    check('GET pull files has b.txt', r.status === 200 && Array.isArray(r.json) && r.json.some((f) => f.filename === 'b.txt'), `${r.status} ${r.text.slice(0, 150)}`);
    r = await req(`/api/v3/repos/adaiversen/smoke-repo/pulls/${prNumber}/merge`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    check('PUT merge 200 merged', r.status === 200 && r.json?.merged === true && r.json?.sha, `${r.status} ${r.text.slice(0, 150)}`);
    r = await req(`/api/v3/repos/adaiversen/smoke-repo/pulls/${prNumber}`);
    check('PR closed after merge', r.status === 200 && r.json?.state === 'closed' && r.json?.merged === true, `${r.status}`);
    // Non-fast-forward push refused.
    gres = await git([...cfg, 'clone', remote('smoke-repo'), 'c3'], work);
    check('git clone c3 ok', gres.code === 0, gres.stderr.slice(0, 150));
    // Divergent history: reset c3's main to the pre-merge commit and commit something else.
    const logRes = await git([...cfg, 'log', '--format=%H', 'main'], join(work, 'c3'));
    const commits = logRes.stdout.trim().split('\n').filter(Boolean);
    await git([...cfg, 'reset', '--hard', commits[1] ?? commits[0]], join(work, 'c3'));
    writeFileSync(join(work, 'c3', 'div.txt'), 'divergent\n');
    await git([...cfg, 'add', 'div.txt'], join(work, 'c3'));
    await git([...cfg, 'commit', '-m', 'divergent'], join(work, 'c3'));
    gres = await git([...cfg, 'push', 'origin', 'main'], join(work, 'c3'));
    check('git non-fast-forward refused', gres.code !== 0 && /non-fast-forward/i.test(gres.stderr), `code=${gres.code} ${gres.stderr.slice(0, 300)}`);
    // Push a tag.
    gres = await git([...cfg, 'tag', 'v1.0'], join(work, 'c1'));
    gres = await git([...cfg, 'push', 'origin', 'v1.0'], join(work, 'c1'));
    check('git push tag ok', gres.code === 0, `code=${gres.code} ${gres.stderr.slice(0, 200)}`);
    // Clone again and confirm the tag and merged file are there.
    gres = await git([...cfg, 'clone', remote('smoke-repo'), 'c4'], work);
    const hasB = await git([...cfg, 'show', 'main:b.txt'], join(work, 'c4'));
    check('clone after merge has b.txt', gres.code === 0 && hasB.stdout.includes('beta'), `code=${gres.code}`);
    rmSync(work, { recursive: true, force: true });

    // ---- DELETE repo ----
    r = await req('/api/v3/repos/adaiversen/smoke-repo', { method: 'DELETE' });
    check('DELETE repo 204', r.status === 204, `${r.status}`);
    r = await req('/api/v3/repos/adaiversen/smoke-repo');
    check('GET deleted repo 404', r.status === 404, `${r.status}`);
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\nSMOKE: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) console.log('failed checks:', failures.join(', '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke harness error:', err);
  process.exit(1);
});
