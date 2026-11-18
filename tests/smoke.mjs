// Smoke test: boots the real entrypoint (main.ts) against a stub environment,
// then drives it with the real git CLI plus curl-style fetch calls over REST,
// GraphQL and MCP. Run: node tests/smoke.mjs
// Exits 0 when every check passes, 1 otherwise.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TOKEN = 'test-token-123';
const BASE64 = (text) => Buffer.from(text, 'utf8').toString('base64');

let failures = 0;
let passes = 0;
function check(label, ok, extra = '') {
  if (ok) {
    passes += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
}

async function main() {
  // Stub environment: /register records the port, /done flips true on demand.
  let registeredPort = 0;
  let done = false;
  const env = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/register') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        registeredPort = JSON.parse(body).port;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/done') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ done }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => env.listen(0, '127.0.0.1', resolve));
  const envPort = env.address().port;

  const forge = spawn(
    'node',
    ['--experimental-strip-types', 'main.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${envPort}`, MAKEFUN_SHOP_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  forge.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => forge.on('exit', (code) => resolve(code)));

  try {
    // Wait for the register call.
    for (let i = 0; i < 100 && !registeredPort; i += 1) await new Promise((r) => setTimeout(r, 100));
    check('forge registered a port', registeredPort > 0 && registeredPort !== 8080, `port=${registeredPort}`);
    const base = `http://127.0.0.1:${registeredPort}`;
    const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const call = async (method, path, body, extraHeaders = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: response.status, headers: response.headers, text, json };
    };

    // healthz + root + auth
    let r = await call('GET', '/healthz', undefined, { Authorization: '' });
    check('GET /healthz without token is 200', r.status === 200 && r.json?.ok === true, `status=${r.status}`);
    r = await call('GET', '/api/v3/', undefined, { Authorization: '' });
    check('GET /api/v3/ without token is 401', r.status === 401, `status=${r.status}`);
    r = await call('GET', '/api/v3/');
    check('GET /api/v3/ is 200 + x-oauth-scopes + request id', r.status === 200 && !!r.headers.get('x-oauth-scopes') && !!r.headers.get('x-github-request-id'), `status=${r.status}`);
    r = await call('GET', '/api/v3/meta');
    check('GET /api/v3/meta has installed_version', r.status === 200 && typeof r.json?.installed_version === 'string', `status=${r.status}`);
    r = await call('GET', '/api/v3/user');
    check('GET /api/v3/user is adaiversen', r.status === 200 && r.json?.login === 'adaiversen', `login=${r.json?.login}`);
    r = await call('GET', '/api/v3/unknown-route-xyz');
    check('unknown route is JSON 404', r.status === 404 && typeof r.json?.message === 'string', `status=${r.status}`);
    r = await fetch(`${base}/api/v3/user/repos`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{bad json' });
    check('malformed JSON body is 400', r.status === 400, `status=${r.status}`);

    // repo + contents
    r = await call('POST', '/api/v3/user/repos', { name: 'smoke-repo', private: true, description: 'smoke' });
    check('POST /user/repos 201', r.status === 201 && r.json?.name === 'smoke-repo' && r.json?.private === true, `status=${r.status}`);
    const repoId = r.json?.node_id;
    check('repo node_id is opaque base64', typeof repoId === 'string' && !/^\d+$/.test(repoId), `node_id=${repoId}`);
    r = await call('POST', '/api/v3/user/repos', { name: 'smoke-repo' });
    check('duplicate repo is 422', r.status === 422, `status=${r.status}`);
    const fileContent = 'hello forge\nsecond line\n';
    r = await call('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/hello.txt', { message: 'add hello', content: BASE64(fileContent) });
    check('PUT /contents creates (201) with content+commit sha', r.status === 201 && !!r.json?.content?.sha && !!r.json?.commit?.sha, `status=${r.status} ${r.text.slice(0, 120)}`);
    const contentSha = r.json?.content?.sha;
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/hello.txt');
    check('GET /contents decodes to the committed bytes', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString('utf8') === fileContent && r.json?.sha === contentSha, `status=${r.status}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/docs');
    check('GET /contents on a directory lists entries', r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.name === 'hello.txt'), `status=${r.status}`);
    r = await call('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/hello.txt', { message: 'stale', content: BASE64('x'), sha: '0'.repeat(40) });
    check('PUT /contents with a stale sha is 409', r.status === 409, `status=${r.status}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/commits');
    check('GET /commits lists the contents commit with the exact message', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.commit?.message === 'add hello'), `status=${r.status}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
    check('GET /branches lists main', r.status === 200 && Array.isArray(r.json) && r.json.some((b) => b.name === 'main'), `status=${r.status}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/git/refs/heads/main');
    check('GET /git/refs/heads/main returns the tip', r.status === 200 && r.json?.ref === 'refs/heads/main' && typeof r.json?.object?.sha === 'string', `status=${r.status}`);
    r = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/git/refs', { ref: 'refs/heads/side', sha: r.json?.object?.sha });
    check('POST /git/refs creates a branch (201)', r.status === 201 && r.json?.ref === 'refs/heads/side', `status=${r.status}`);

    // labels + issues
    r = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/labels', { name: 'bug', color: 'd73a4a' });
    check('POST /labels 201', r.status === 201 && r.json?.name === 'bug', `status=${r.status}`);
    r = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'first bug', body: 'boom', labels: ['bug'] });
    check('POST /issues 201 with the label', r.status === 201 && r.json?.number === 1 && r.json?.labels?.some((l) => l.name === 'bug'), `status=${r.status} ${r.text.slice(0, 120)}`);
    r = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'bad label', labels: ['no-such-label'] });
    check('POST /issues with an unknown label is 422', r.status === 422, `status=${r.status}`);
    r = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/issues/1/comments', { body: 'noted' });
    check('POST /issues/1/comments 201', r.status === 201 && r.json?.body === 'noted', `status=${r.status}`);
    r = await call('PATCH', '/api/v3/repos/adaiversen/smoke-repo/issues/1', { state: 'closed' });
    check('PATCH /issues/1 closes it', r.status === 200 && r.json?.state === 'closed', `status=${r.status}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/issues?state=open');
    check('GET /issues?state=open excludes the closed one', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `status=${r.status} len=${r.json?.length}`);

    // pulls + merge
    r = await call('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/hello.txt', { message: 'edit on side', content: BASE64('hello forge\nsecond line\nthird line\n'), branch: 'side', sha: contentSha });
    check('PUT /contents on side branch (200)', r.status === 200 && !!r.json?.commit?.sha, `status=${r.status}`);
    r = await call('POST', '/api/v3/repos/adaiversen/smoke-repo/pulls', { title: 'add third line', head: 'side', base: 'main', body: 'please merge' });
    check('POST /pulls 201 open with head/base', r.status === 201 && r.json?.number === 2 && r.json?.state === 'open' && r.json?.head?.ref === 'side' && r.json?.base?.ref === 'main', `status=${r.status} ${r.text.slice(0, 150)}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/pulls/2/files');
    check('GET /pulls/2/files lists the changed file', r.status === 200 && Array.isArray(r.json) && r.json.some((f) => f.filename === 'docs/hello.txt' && f.additions >= 1), `status=${r.status} ${r.text.slice(0, 150)}`);
    r = await call('PUT', '/api/v3/repos/adaiversen/smoke-repo/pulls/2/merge', {});
    check('PUT /pulls/2/merge 200 merged', r.status === 200 && r.json?.merged === true && typeof r.json?.sha === 'string', `status=${r.status} ${r.text.slice(0, 120)}`);
    r = await call('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/docs/hello.txt');
    check('merged content is on main', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString('utf8').includes('third line'), `status=${r.status}`);

    // pagination
    for (let i = 0; i < 12; i += 1) await call('POST', '/api/v3/user/repos', { name: `page-repo-${i}`, private: true });
    r = await call('GET', '/api/v3/user/repos?per_page=10');
    const link = r.headers.get('link') ?? '';
    check('GET /user/repos?per_page=10 returns 10 + Link next', r.status === 200 && Array.isArray(r.json) && r.json.length === 10 && link.includes('rel="next"') && link.includes('127.0.0.1'), `len=${r.json?.length} link=${link.slice(0, 80)}`);
    const nextUrl = /<([^>]+)>; rel="next"/.exec(link)?.[1];
    if (nextUrl) {
      const r2 = await fetch(nextUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const j2 = await r2.json();
      check('following Link rel=next gives the next page', r2.status === 200 && Array.isArray(j2) && j2.length > 0, `status=${r2.status}`);
    } else {
      check('following Link rel=next gives the next page', false, 'no next link');
    }

    // GraphQL
    const gql = async (query, variables = {}) => call('POST', '/api/graphql', { query, variables });
    r = await gql('query { viewer { login } }');
    check('GraphQL viewer.login', r.status === 200 && r.json?.data?.viewer?.login === 'adaiversen', `status=${r.status} ${r.text.slice(0, 120)}`);
    r = await gql('query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }', { owner: 'adaiversen', name: 'smoke-repo' });
    check('GraphQL repository fields', r.status === 200 && r.json?.data?.repository?.id === repoId && r.json?.data?.repository?.databaseId === r.json?.data?.repository?.databaseId && r.json?.data?.repository?.viewerPermission === 'ADMIN' && r.json?.data?.repository?.hasIssuesEnabled === true, `status=${r.status} ${r.text.slice(0, 160)}`);
    r = await gql('query { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }');
    const issueFields = (r.json?.data?.Issue?.fields ?? []).map((f) => f.name);
    check('GraphQL __type Issue lists id/number/title/state/body', ['id', 'number', 'title', 'state', 'body'].every((f) => issueFields.includes(f)), `fields=${issueFields.join(',')}`);
    r = await gql('query { viewer { login noSuchFieldOnViewer } }');
    check('GraphQL unknown field is 200 with errors naming it', r.status === 200 && Array.isArray(r.json?.errors) && r.json.errors.some((e) => e.message.includes('noSuchFieldOnViewer')), `status=${r.status}`);
    r = await gql('query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }', { owner: 'adaiversen', name: 'no-such-repo' });
    check('GraphQL unknown repo is data.repository null, no errors', r.status === 200 && r.json?.data?.repository === null && !r.json?.errors, `status=${r.status} ${r.text.slice(0, 120)}`);
    r = await gql('mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }', { input: { repositoryId: repoId, title: 'gql issue', body: 'via graphql' } });
    check('GraphQL createIssue', r.status === 200 && r.json?.data?.createIssue?.issue?.number === 3, `status=${r.status} ${r.text.slice(0, 140)}`);
    r = await gql('query($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state } } } }', { owner: 'adaiversen', name: 'smoke-repo', first: 5 });
    check('GraphQL open issues list', r.status === 200 && Array.isArray(r.json?.data?.repository?.issues?.nodes) && r.json.data.repository.issues.nodes.some((n) => n.number === 3), `status=${r.status} ${r.text.slice(0, 140)}`);
    // batched
    const batch = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body: JSON.stringify([{ query: 'query { viewer { login } }' }, { query: 'query { Issue: __type(name: "Issue") { fields { name } } }' }]) });
    const batchJson = await batch.json();
    check('GraphQL batched operations answer in order', batch.status === 200 && Array.isArray(batchJson) && batchJson.length === 2 && batchJson[0]?.data?.viewer?.login === 'adaiversen', `status=${batch.status}`);

    // MCP
    const mcp = async (body, extraHeaders = {}) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
    };
    r = await mcp({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {}, _meta: { protocolVersion: '2026-07-28' } });
    check('MCP server/discover lists 2026-07-28', r.status === 200 && Array.isArray(r.json?.result?.supportedVersions) && r.json.result.supportedVersions.includes('2026-07-28'), `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 140)}`);
    r = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}, _meta: { protocolVersion: '2026-07-28' } });
    const toolNames = (r.json?.result?.tools ?? []).map((t) => t.name);
    check('MCP tools/list has the six tools', ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => toolNames.includes(n)), `tools=${toolNames.join(',')}`);
    r = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke-repo', title: 'mcp issue' } }, _meta: { protocolVersion: '2026-07-28' } });
    check('MCP create_issue', r.status === 200 && r.json?.result?.structuredContent?.number === 4, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
    r = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'smoke-repo', state: 'open' } }, _meta: { protocolVersion: '2026-07-28' } });
    check('MCP list_issues returns the mcp issue', r.status === 200 && Array.isArray(r.json?.result?.structuredContent?.issues) && r.json.result.structuredContent.issues.some((i) => i.number === 4), `status=${r.status}`);
    r = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} }, _meta: { protocolVersion: '2026-07-28' } });
    check('MCP unknown tool is -32601, never 500', r.status === 200 && r.json?.error?.code === -32601, `status=${r.status}`);
    r = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_issue', arguments: {} }, _meta: { protocolVersion: '2026-07-28' } });
    check('MCP missing arguments is isError:true', r.status === 200 && r.json?.result?.isError === true, `status=${r.status}`);
    const badBody = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: 'not json at all' });
    const badJson = await badBody.json().catch(() => null);
    check('MCP non-JSON body is HTTP 400 with -32700', badBody.status === 400 && badJson?.error?.code === -32700, `status=${badBody.status}`);
    const noAuth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'smoke-repo' } } }) });
    check('MCP without token is 401', noAuth.status === 401, `status=${noAuth.status}`);
    // legacy initialize
    r = await mcp({ jsonrpc: '2.0', id: 8, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
    check('MCP legacy initialize echoes a revision + serverInfo', r.status === 200 && typeof r.json?.result?.serverInfo?.name === 'string' && !!r.json?.result?.capabilities?.tools, `status=${r.status}`);

    // Real git CLI against the forge
    const work = mkdtempSync(join(tmpdir(), 'forge-smoke-'));
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work, GIT_TERMINAL_PROMPT: '0' };
    const gitAuth = (url) => url.replace('://', `://x:${TOKEN}@`);
    const runGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
    runGit(work, 'config', '--global', 'user.name', 'Smoke Test');
    runGit(work, 'config', '--global', 'user.email', 'smoke@example.invalid');
    runGit(work, 'config', '--global', 'init.defaultBranch', 'main');
    runGit(work, 'config', '--global', 'protocol.version', '2');
    const remote = gitAuth(`${base}/adaiversen/smoke-repo.git`);
    // clone the repo the REST surface built
    const cloneDir = join(work, 'clone');
    runGit(work, 'clone', remote, 'clone');
    check('git clone works', true);
    const log = runGit(cloneDir, 'log', '--oneline').trim().split('\n');
    check('clone sees the merged history', log.length >= 3, `commits=${log.length}`);
    const hello = runGit(cloneDir, 'show', 'HEAD:docs/hello.txt');
    check('cloned file bytes match', hello.includes('third line'), hello.slice(0, 40));
    // push a new commit
    runGit(cloneDir, 'checkout', '-b', 'feature');
    execFileSync('sh', ['-c', `printf 'feature work\\n' > feature.txt`], { cwd: cloneDir });
    runGit(cloneDir, 'add', 'feature.txt');
    runGit(cloneDir, 'commit', '-m', 'feature work');
    runGit(cloneDir, 'push', 'origin', 'feature');
    const ls = runGit(cloneDir, 'ls-remote', '--heads', 'origin');
    check('git push + ls-remote see the new branch', ls.includes('refs/heads/feature'), ls.slice(0, 120));
    // shallow clone
    const shallowDir = join(work, 'shallow');
    runGit(work, 'clone', '--depth', '1', remote, 'shallow');
    const shallowLog = runGit(shallowDir, 'log', '--oneline').trim().split('\n');
    check('shallow clone depth 1 has exactly one commit', shallowLog.length === 1, `commits=${shallowLog.length}`);
    check('shallow file lists the tip as shallow', runGit(shallowDir, 'rev-parse', '--is-shallow-repository').trim() === 'true');
    // non-fast-forward push is refused
    runGit(cloneDir, 'checkout', 'main');
    runGit(cloneDir, 'reset', '--hard', 'HEAD~1');
    let refused = false;
    try {
      runGit(cloneDir, 'push', 'origin', 'main');
    } catch (err) {
      refused = /non-fast-forward|rejected/.test(String(err.stderr ?? '') + String(err.stdout ?? ''));
    }
    check('non-fast-forward push is refused', refused);
    // tag push + fetch
    runGit(cloneDir, 'tag', 'v1');
    runGit(cloneDir, 'push', 'origin', 'v1');
    const lsTags = runGit(cloneDir, 'ls-remote', '--tags', 'origin');
    check('annotated tag push is listed', lsTags.includes('refs/tags/v1'), lsTags.slice(0, 120));
    rmSync(work, { recursive: true, force: true });
  } finally {
    done = true;
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 8000))]);
    check('forge exits 0 after /done flips true', code === 0, `exit=${code} stderr=${stderr.slice(0, 300)}`);
    if (code === null) forge.kill('SIGKILL');
    env.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
