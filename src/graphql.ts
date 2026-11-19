// GraphQL v4 (/api/graphql), written from scratch: a small recursive-descent parser
// and executor for exactly the documents gh and github-mcp-server send, plus
// introspection (__type / __schema), batched documents, unknown-field errors (HTTP 200)
// and null-without-errors for unknown repositories.

import type { Repo, Store } from './store.ts';
import { FIXED_TIME, VIEWER_LOGIN } from './store.ts';
import { opaqueId } from './util.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection: FieldNode[];
}

interface Operation {
  op: 'query' | 'mutation' | 'subscription';
  name?: string;
  selection: FieldNode[];
}

class Lexer {
  private pos = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
  }
  private skipWs(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos++;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      break;
    }
  }
  peek(): string {
    const saved = this.pos;
    const tok = this.next();
    this.pos = saved;
    return tok;
  }
  next(): string {
    this.skipWs();
    const c = this.src[this.pos] ?? '';
    if (c === '') return '';
    if ('{}():![]=@$&|'.includes(c) || c === '.') {
      if (c === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        return '...';
      }
      this.pos++;
      return c;
    }
    if (c === '"') {
      // Block string or plain string.
      if (this.src.slice(this.pos, this.pos + 3) === '"""') {
        const end = this.src.indexOf('"""', this.pos + 3);
        const val = end === -1 ? this.src.slice(this.pos + 3) : this.src.slice(this.pos + 3, end);
        this.pos = end === -1 ? this.src.length : end + 3;
        return JSON.stringify(val);
      }
      let out = '';
      this.pos++;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos++];
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = this.src[this.pos++];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        } else out += ch;
      }
      return JSON.stringify(out);
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (m) {
      this.pos += m[0].length;
      return m[0];
    }
    this.pos++;
    return c;
  }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }
}

function parseValue(lx: Lexer): ValueNode {
  const tok = lx.next();
  if (tok === '$') return { kind: 'var', name: lx.next() };
  if (tok === '[') {
    const items: ValueNode[] = [];
    while (lx.peek() !== ']') items.push(parseValue(lx));
    lx.expect(']');
    return { kind: 'list', items };
  }
  if (tok === '{') {
    const fields: Record<string, ValueNode> = {};
    while (lx.peek() !== '}') {
      const name = lx.next();
      lx.expect(':');
      fields[name] = parseValue(lx);
    }
    lx.expect('}');
    return { kind: 'object', fields };
  }
  if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
  if (tok === 'true') return { kind: 'bool', value: true };
  if (tok === 'false') return { kind: 'bool', value: false };
  if (tok === 'null') return { kind: 'null' };
  if (/^-?\d+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
  if (/^-?\d+\.\d/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
  return { kind: 'enum', value: tok };
}

function parseSelection(lx: Lexer, fragments: Map<string, FieldNode[]>): FieldNode[] {
  const fields: FieldNode[] = [];
  lx.expect('{');
  while (lx.peek() !== '}') {
    if (lx.peek() === '...') {
      lx.next();
      const next = lx.peek();
      if (next === 'on') {
        lx.next();
        lx.next(); // type name
        fields.push(...parseSelection(lx, fragments));
      } else {
        const name = lx.next();
        const frag = fragments.get(name);
        if (frag) fields.push(...frag);
        // Directives after a spread are skipped.
        if (lx.peek() === '@') {
          lx.next();
          lx.next();
          if (lx.peek() === '(') {
            let depth = 0;
            do {
              const t = lx.next();
              if (t === '(') depth++;
              if (t === ')') depth--;
            } while (depth > 0);
          }
        }
      }
      continue;
    }
    const first = lx.next();
    let alias: string | undefined;
    let name = first;
    if (lx.peek() === ':') {
      lx.next();
      alias = first;
      name = lx.next();
    }
    const args: Record<string, ValueNode> = {};
    if (lx.peek() === '(') {
      lx.next();
      while (lx.peek() !== ')') {
        const argName = lx.next();
        lx.expect(':');
        args[argName] = parseValue(lx);
      }
      lx.expect(')');
    }
    // Directives on a field are skipped.
    while (lx.peek() === '@') {
      lx.next();
      lx.next();
      if (lx.peek() === '(') {
        let depth = 0;
        do {
          const t = lx.next();
          if (t === '(') depth++;
          if (t === ')') depth--;
        } while (depth > 0);
      }
    }
    const selection = lx.peek() === '{' ? parseSelection(lx, fragments) : [];
    fields.push({ alias, name, args, selection });
  }
  lx.expect('}');
  return fields;
}

function parseDocument(src: string): Operation[] {
  const lx = new Lexer(src);
  const fragments = new Map<string, FieldNode[]>();
  const operations: Operation[] = [];
  // First pass: collect fragment definitions.
  const raw = src;
  void raw;
  while (lx.peek() !== '') {
    const tok = lx.next();
    if (tok === 'fragment') {
      const name = lx.next();
      lx.next(); // 'on'
      lx.next(); // type
      fragments.set(name, parseSelection(lx, fragments));
      continue;
    }
    let op: Operation['op'] = 'query';
    let name: string | undefined;
    if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
      op = tok as Operation['op'];
      const next = lx.peek();
      if (next !== '{' && next !== '(') name = lx.next();
    } else if (tok === '{') {
      // Anonymous query: the '{' was consumed as the operation start; re-parse as selection.
      // We consumed '{', so parse fields until '}'.
      const fields: FieldNode[] = [];
      while (lx.peek() !== '}') {
        // Reuse parseSelection by faking: parse fields manually via a sub-parse.
        const sub = parseSelectionShim(lx, fragments);
        fields.push(...sub);
      }
      lx.expect('}');
      operations.push({ op: 'query', name, selection: fields });
      continue;
    } else {
      // A stray token (e.g. a variable definition list start): skip it.
      continue;
    }
    // Variable definitions.
    if (lx.peek() === '(') {
      let depth = 0;
      do {
        const t = lx.next();
        if (t === '(') depth++;
        if (t === ')') depth--;
      } while (depth > 0);
    }
    // Directives on the operation.
    while (lx.peek() === '@') {
      lx.next();
      lx.next();
      if (lx.peek() === '(') {
        let depth = 0;
        do {
          const t = lx.next();
          if (t === '(') depth++;
          if (t === ')') depth--;
        } while (depth > 0);
      }
    }
    const selection = parseSelection(lx, fragments);
    operations.push({ op, name, selection });
  }
  return operations;
}

/** Parse fields inside an already-opened '{' (used for anonymous queries). */
function parseSelectionShim(lx: Lexer, fragments: Map<string, FieldNode[]>): FieldNode[] {
  // Parse a single field; the caller loops until '}'.
  const fields: FieldNode[] = [];
  if (lx.peek() === '...') {
    lx.next();
    const next = lx.peek();
    if (next === 'on') {
      lx.next();
      lx.next();
      fields.push(...parseSelection(lx, fragments));
    } else {
      const name = lx.next();
      const frag = fragments.get(name);
      if (frag) fields.push(...frag);
    }
    return fields;
  }
  const first = lx.next();
  let alias: string | undefined;
  let name = first;
  if (lx.peek() === ':') {
    lx.next();
    alias = first;
    name = lx.next();
  }
  const args: Record<string, ValueNode> = {};
  if (lx.peek() === '(') {
    lx.next();
    while (lx.peek() !== ')') {
      const argName = lx.next();
      lx.expect(':');
      args[argName] = parseValue(lx);
    }
    lx.expect(')');
  }
  while (lx.peek() === '@') {
    lx.next();
    lx.next();
    if (lx.peek() === '(') {
      let depth = 0;
      do {
        const t = lx.next();
        if (t === '(') depth++;
        if (t === ')') depth--;
      } while (depth > 0);
    }
  }
  const selection = lx.peek() === '{' ? parseSelection(lx, fragments) : [];
  fields.push({ alias, name, args, selection });
  return fields;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'var': return variables[node.name];
    case 'list': return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema (the fields the suite introspects and queries)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'url', 'avatarUrl'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldError(ctx: ExecCtx, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function pickFields(obj: Record<string, unknown> | null, selection: FieldNode[], typeName: string, ctx: ExecCtx): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const f of selection) {
    const key = f.alias ?? f.name;
    if (f.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!(f.name in obj)) {
      fieldError(ctx, typeName, f.name);
      out[key] = null;
      continue;
    }
    const value = obj[f.name];
    if (Array.isArray(value)) {
      out[key] = value.map((v) => (v !== null && typeof v === 'object' ? pickFields(v as Record<string, unknown>, f.selection, guessType(v), ctx) : v));
    } else if (value !== null && typeof value === 'object') {
      out[key] = pickFields(value as Record<string, unknown>, f.selection, guessType(value), ctx);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function guessType(v: Record<string, unknown>): string {
  if ('__type' in v) return v.__type as string;
  return 'Object';
}

function viewerObject(): Record<string, unknown> {
  return {
    __type: 'User',
    id: opaqueId('User', VIEWER_LOGIN),
    login: VIEWER_LOGIN,
    name: 'Ada Iversen',
    url: `https://github.com/${VIEWER_LOGIN}`,
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  };
}

function issueObject(repo: Repo, issue: import('./store.ts').Issue): Record<string, unknown> {
  return {
    __type: 'Issue',
    id: opaqueId('Issue', `${repo.fullName}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: viewerObject(),
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    comments: { totalCount: issue.comments.length },
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

function pullObject(repo: Repo, pull: import('./store.ts').Pull): Record<string, unknown> {
  return {
    __type: 'PullRequest',
    id: opaqueId('PullRequest', `${repo.fullName}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN',
    merged: pull.merged,
    url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: viewerObject(),
    files: pullFilesObject(repo, pull),
  };
}

function pullFilesObject(repo: Repo, pull: import('./store.ts').Pull): Record<string, unknown> {
  const files = repo.diffFiles(pull.baseSha, pull.headSha);
  return {
    __type: 'PullRequestChangedFileConnection',
    nodes: files.map((f) => ({ __type: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
    totalCount: files.length,
  };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    __type: 'Repository',
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: viewerObject(),
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.createdAt,
  };
}

function decodeRepoId(id: string): { owner: string; name: string } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^Repository:(.+)\/(.+)$/.exec(text);
    if (!m) return undefined;
    return { owner: m[1], name: m[2] };
  } catch {
    return undefined;
  }
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecCtx = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const f of op.selection) {
    const key = f.alias ?? f.name;
    if (f.name === '__type') {
      const nameArg = resolveValue(f.args.name, variables) as string;
      data[key] = introspectType(nameArg, f.selection, ctx);
      continue;
    }
    if (f.name === '__schema') {
      data[key] = introspectSchema(f.selection, ctx);
      continue;
    }
    if (op.op === 'mutation') {
      data[key] = executeMutation(store, f, ctx);
      continue;
    }
    if (f.name === 'viewer') {
      data[key] = pickFields(viewerObject(), f.selection, 'User', ctx);
      continue;
    }
    if (f.name === 'repository') {
      const owner = resolveValue(f.args.owner, variables) as string;
      const name = resolveValue(f.args.name, variables) as string;
      const repo = owner?.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
      if (!repo) {
        data[key] = null;
        continue;
      }
      data[key] = executeRepository(repo, f.selection, ctx);
      continue;
    }
    if (f.name === 'node') {
      const id = resolveValue(f.args.id, variables) as string;
      const decoded = decodeRepoId(id);
      const repo = decoded ? store.getRepo(decoded.owner, decoded.name) : undefined;
      data[key] = repo ? executeRepository(repo, f.selection, ctx) : null;
      continue;
    }
    fieldError(ctx, 'Query', f.name);
    data[key] = null;
  }
  const result: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function executeRepository(repo: Repo, selection: FieldNode[], ctx: ExecCtx): Record<string, unknown> {
  const base = repoObject(repo);
  const out: Record<string, unknown> = {};
  for (const f of selection) {
    const key = f.alias ?? f.name;
    if (f.name === '__typename') { out[key] = 'Repository'; continue; }
    if (f.name === 'issue') {
      const number = resolveValue(f.args.number, ctx.variables) as number;
      const issue = repo.issues.get(number);
      out[key] = issue ? pickFields(issueObject(repo, issue), f.selection, 'Issue', ctx) : null;
      continue;
    }
    if (f.name === 'issues') {
      out[key] = issueConnection(repo, f, ctx);
      continue;
    }
    if (f.name === 'pullRequest') {
      const number = resolveValue(f.args.number, ctx.variables) as number;
      const pull = repo.pulls.get(number);
      out[key] = pull ? pickFields(pullObject(repo, pull), f.selection, 'PullRequest', ctx) : null;
      continue;
    }
    if (f.name === 'pullRequests') {
      out[key] = pullConnection(repo, f, ctx);
      continue;
    }
    if (f.name in base) {
      const value = base[f.name];
      if (value !== null && typeof value === 'object') out[key] = pickFields(value as Record<string, unknown>, f.selection, guessType(value as Record<string, unknown>), ctx);
      else out[key] = value;
      continue;
    }
    fieldError(ctx, 'Repository', f.name);
    out[key] = null;
  }
  return out;
}

/** A connection cursor: base64 of "cursor:<number>". */
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function decodeCursor(cursor: unknown): number | undefined {
  if (typeof cursor !== 'string') return undefined;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : undefined;
  } catch {
    return undefined;
  }
}

function issueConnection(repo: Repo, f: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const args = f.args;
  if (args.states) {
    const states = (resolveValue(args.states, ctx.variables) as string[]) ?? [];
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy ? (resolveValue(args.orderBy, ctx.variables) as { field?: string; direction?: string }) : undefined;
  const direction = (orderBy?.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const first = args.first ? (resolveValue(args.first, ctx.variables) as number) : undefined;
  const after = args.after ? decodeCursor(resolveValue(args.after, ctx.variables)) : undefined;
  let start = 0;
  if (after !== undefined) {
    const idx = list.findIndex((i) => i.number === after);
    start = idx === -1 ? 0 : idx + 1;
  }
  const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
  const hasNextPage = start + page.length < list.length;
  const nodes = page.map((i) => issueObject(repo, i));
  return connectionObject(nodes, list.length, f.selection, ctx, 'Issue', hasNextPage, page);
}

function pullConnection(repo: Repo, f: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  const args = f.args;
  if (args.states) {
    const states = (resolveValue(args.states, ctx.variables) as string[]) ?? [];
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => wanted.has(p.state));
  }
  const orderBy = args.orderBy ? (resolveValue(args.orderBy, ctx.variables) as { field?: string; direction?: string }) : undefined;
  const direction = (orderBy?.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const first = args.first ? (resolveValue(args.first, ctx.variables) as number) : undefined;
  const after = args.after ? decodeCursor(resolveValue(args.after, ctx.variables)) : undefined;
  let start = 0;
  if (after !== undefined) {
    const idx = list.findIndex((p) => p.number === after);
    start = idx === -1 ? 0 : idx + 1;
  }
  const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
  const hasNextPage = start + page.length < list.length;
  const nodes = page.map((p) => pullObject(repo, p));
  return connectionObject(nodes, list.length, f.selection, ctx, 'PullRequest', hasNextPage, page);
}

function connectionObject(nodes: Array<Record<string, unknown>>, total: number, selection: FieldNode[], ctx: ExecCtx, nodeType: string, hasNextPage = false, page: Array<{ number: number }> = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  for (const f of selection) {
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') {
      out[key] = nodes.map((n) => pickFields(n, f.selection, nodeType, ctx));
    } else if (f.name === 'edges') {
      out[key] = nodes.map((n) => pickFields({ node: n, cursor: encodeCursor(n.number as number) }, f.selection, 'Edge', ctx));
    } else if (f.name === 'totalCount') {
      out[key] = total;
    } else if (f.name === 'pageInfo') {
      out[key] = pickFields({ __type: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor }, f.selection, 'PageInfo', ctx);
    } else {
      fieldError(ctx, nodeType === 'Issue' ? 'IssueConnection' : 'PullRequestConnection', f.name);
      out[key] = null;
    }
  }
  return out;
}

function introspectType(name: string, selection: FieldNode[], ctx: ExecCtx): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  const obj: Record<string, unknown> = { __type: '__Type', name, kind: enums !== undefined ? 'ENUM' : 'OBJECT', description: null };
  if (fields !== undefined) obj.fields = fields.map((n) => ({ name: n, description: null, args: [], type: { name: 'String', kind: 'SCALAR' } }));
  if (enums !== undefined) obj.enumValues = enums.map((n) => ({ name: n, description: null }));
  return pickFields(obj, selection, '__Type', ctx);
}

function introspectSchema(selection: FieldNode[], ctx: ExecCtx): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    __type: '__Schema',
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: Object.keys(TYPE_FIELDS).map((n) => ({ name: n, kind: 'OBJECT' })),
  };
  return pickFields(obj, selection, '__Schema', ctx);
}

/** Decode an opaque node id ("Kind:owner/name:number") into its parts. */
function decodeNodeId(id: string): { kind: string; owner: string; name: string; number: number } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^(Issue|PullRequest|IssueComment):(.+)\/(.+):(\d+)$/.exec(text);
    if (!m) return undefined;
    return { kind: m[1], owner: m[2], name: m[3], number: parseInt(m[4], 10) };
  } catch {
    return undefined;
  }
}

function executeMutation(store: Store, f: FieldNode, ctx: ExecCtx): Record<string, unknown> | null {
  if (f.name === 'createIssue') {
    const input = resolveValue(f.args.input, ctx.variables) as { repositoryId?: string; title?: string; body?: string };
    const decoded = input?.repositoryId ? decodeRepoId(input.repositoryId) : undefined;
    const repo = decoded ? store.getRepo(decoded.owner, decoded.name) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const issue = repo.newIssue(input.title ?? '', input.body ?? '', []);
    const out: Record<string, unknown> = {};
    for (const sub of f.selection) {
      const key = sub.alias ?? sub.name;
      if (sub.name === 'issue') out[key] = pickFields(issueObject(repo, issue), sub.selection, 'Issue', ctx);
      else if (sub.name === 'clientMutationId') out[key] = null;
      else { fieldError(ctx, 'CreateIssuePayload', sub.name); out[key] = null; }
    }
    return out;
  }
  if (f.name === 'createPullRequest') {
    const input = resolveValue(f.args.input, ctx.variables) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
    const decoded = input?.repositoryId ? decodeRepoId(input.repositoryId) : undefined;
    const repo = decoded ? store.getRepo(decoded.owner, decoded.name) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const headSha = repo.ref(`refs/heads/${input.headRefName ?? ''}`);
    const baseSha = repo.ref(`refs/heads/${input.baseRefName ?? repo.defaultBranch}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    const pull = repo.newPull(input.title ?? '', input.body ?? '', input.headRefName ?? '', headSha, input.baseRefName ?? repo.defaultBranch, baseSha);
    const out: Record<string, unknown> = {};
    for (const sub of f.selection) {
      const key = sub.alias ?? sub.name;
      if (sub.name === 'pullRequest') out[key] = pickFields(pullObject(repo, pull), sub.selection, 'PullRequest', ctx);
      else if (sub.name === 'clientMutationId') out[key] = null;
      else { fieldError(ctx, 'CreatePullRequestPayload', sub.name); out[key] = null; }
    }
    return out;
  }
  if (f.name === 'closeIssue') {
    const input = resolveValue(f.args.input, ctx.variables) as { issueId?: string };
    const decoded = input?.issueId ? decodeNodeId(input.issueId) : undefined;
    const repo = decoded?.kind === 'Issue' ? store.getRepo(decoded.owner, decoded.name) : undefined;
    const issue = repo?.issues.get(decoded?.number ?? -1);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedAt = FIXED_TIME;
    const out: Record<string, unknown> = {};
    for (const sub of f.selection) {
      const key = sub.alias ?? sub.name;
      if (sub.name === 'issue') out[key] = pickFields(issueObject(repo, issue), sub.selection, 'Issue', ctx);
      else if (sub.name === 'clientMutationId') out[key] = null;
      else { fieldError(ctx, 'CloseIssuePayload', sub.name); out[key] = null; }
    }
    return out;
  }
  if (f.name === 'mergePullRequest') {
    const input = resolveValue(f.args.input, ctx.variables) as { pullRequestId?: string; mergeMethod?: string };
    const decoded = input?.pullRequestId ? decodeNodeId(input.pullRequestId) : undefined;
    const repo = decoded?.kind === 'PullRequest' ? store.getRepo(decoded.owner, decoded.name) : undefined;
    const pull = repo?.pulls.get(decoded?.number ?? -1);
    if (!repo || !pull) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
      return null;
    }
    const result = repo.mergePull(pull);
    if (!result.ok) {
      ctx.errors.push({ message: result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is already closed' });
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const sub of f.selection) {
      const key = sub.alias ?? sub.name;
      if (sub.name === 'pullRequest') out[key] = pickFields(pullObject(repo, pull), sub.selection, 'PullRequest', ctx);
      else if (sub.name === 'clientMutationId') out[key] = null;
      else { fieldError(ctx, 'MergePullRequestPayload', sub.name); out[key] = null; }
    }
    return out;
  }
  if (f.name === 'addComment') {
    const input = resolveValue(f.args.input, ctx.variables) as { subjectId?: string; body?: string };
    const decoded = input?.subjectId ? decodeNodeId(input.subjectId) : undefined;
    const repo = decoded?.kind === 'Issue' ? store.getRepo(decoded.owner, decoded.name) : undefined;
    const issue = repo?.issues.get(decoded?.number ?? -1);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    const comment = repo.newComment(issue, input.body ?? '');
    const out: Record<string, unknown> = {};
    for (const sub of f.selection) {
      const key = sub.alias ?? sub.name;
      if (sub.name === 'commentEdge') {
        const node = { id: opaqueId('IssueComment', `${repo.fullName}:${issue.number}:${comment.id}`), body: comment.body };
        out[key] = pickFields({ node }, sub.selection, 'IssueCommentEdge', ctx);
      } else if (sub.name === 'clientMutationId') out[key] = null;
      else { fieldError(ctx, 'AddCommentPayload', sub.name); out[key] = null; }
    }
    return out;
  }
  fieldError(ctx, 'Mutation', f.name);
  return null;
}

/** Execute one GraphQL request body (single document or a batch). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  const docs = Array.isArray(body) ? body : [body];
  const results = docs.map((doc) => {
    const query = (doc as { query?: unknown })?.query;
    const variables = ((doc as { variables?: unknown })?.variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    let operations: Operation[];
    try {
      operations = parseDocument(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    if (operations.length === 0) return { data: {}, errors: [{ message: 'Must provide an operation.' }] };
    const op = operations[0];
    return executeOperation(store, op, variables);
  });
  return Array.isArray(body) ? results : results[0];
}
