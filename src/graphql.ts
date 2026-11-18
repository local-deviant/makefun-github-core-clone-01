// GraphQL over the same store: a small recursive-descent executor for exactly
// the documents gh and github-mcp-server send (viewer/repository/node/__type,
// issue and pull-request reads, the five mutations, cursor pagination).
// Unknown fields are reported as `Cannot query field "X" on type "Y".` with
// HTTP 200; an unknown repository reads as data.repository = null, no errors.

import { buildCommit } from './git.ts';
import { FIXED_EPOCH_SEC, FIXED_ISO } from './seed.ts';
import {
  Forge,
  globalId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  parseJsonBody,
  requireAuth,
  sendError,
  sendJson,
  type Ctx,
  type Router,
} from './http.ts';

// -------------------------------------------------------------------------------------------
// tokenizer + parser (my own; the documents are small and fixed in shape)
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        num += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'int', value: Number.parseInt(num, 10) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        name += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface SelectionNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[];
  fragmentType?: string;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, ValueNode | null>;
  selection: SelectionNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }
  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }
  #next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }
  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }
  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.#peek().kind !== 'eof') {
      operations.push(this.#parseOperation());
    }
    return operations;
  }

  #parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.#peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.#expectName() as 'query' | 'mutation';
    }
    let name: string | undefined;
    const maybeName = this.#peek();
    if (maybeName.kind === 'name') name = this.#expectName();
    const variables: Record<string, ValueNode | null> = {};
    if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '(') {
      this.#next();
      while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === ')')) {
        this.#expectPunct('$');
        const varName = this.#expectName();
        this.#expectPunct(':');
        // Type name (possibly [T]!, T!, T) — consumed, not interpreted.
        this.#parseType();
        let defaultValue: ValueNode | null = null;
        if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '=') {
          this.#next();
          defaultValue = this.#parseValue();
        }
        variables[varName] = defaultValue;
      }
      this.#expectPunct(')');
    }
    const selection = this.#parseSelectionSet();
    return { kind, name, variables, selection };
  }

  #parseType(): void {
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.#next();
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '!') this.#next();
  }

  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '}')) {
      selections.push(this.#parseSelection());
    }
    this.#expectPunct('}');
    return selections;
  }

  #parseSelection(): SelectionNode {
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.#next();
      let fragmentType: string | undefined;
      const next = this.#peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.#next();
        fragmentType = this.#expectName();
      } else if (next.kind === 'name') {
        // A named fragment spread: not used by the documents we serve.
        throw new Error(`named fragment spreads are not supported: ${next.value}`);
      }
      const selection = this.#parseSelectionSet();
      return { name: '', args: {}, selection, fragmentType };
    }
    const first = this.#expectName();
    let alias: string | undefined;
    let name = first;
    const colon = this.#peek();
    if (colon.kind === 'punct' && colon.value === ':') {
      this.#next();
      alias = first;
      name = this.#expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '(') {
      this.#next();
      while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === ')')) {
        const argName = this.#expectName();
        this.#expectPunct(':');
        args[argName] = this.#parseValue();
      }
      this.#expectPunct(')');
    }
    let selection: SelectionNode[] = [];
    if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '{') {
      selection = this.#parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  #parseValue(): ValueNode {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.#expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === ']')) {
        items.push(this.#parseValue());
      }
      this.#expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '}')) {
        const key = this.#expectName();
        this.#expectPunct(':');
        fields[key] = this.#parseValue();
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// -------------------------------------------------------------------------------------------
// schema tables (the introspection answers)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'CODE'];

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

class GqlError extends Error {}

type Plain = Record<string, unknown>;

interface GqlObject {
  __typename: string;
  source: unknown;
}

interface Executor {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(node: SelectionNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.args)) out[key] = evalValue(value, variables);
  return out;
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  node: GqlObject;
}

function paginateConnection<T extends { number: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
  order: 'asc' | 'desc',
  toNode: (item: T) => GqlObject,
): GqlObject {
  const sorted = [...items].sort((a, b) => (order === 'asc' ? a.number - b.number : b.number - a.number));
  const after = cursorNumber(args.after);
  let start = 0;
  if (after !== null) {
    const index = sorted.findIndex((item) => item.number === after);
    start = index < 0 ? sorted.length : index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : 30;
  const page = sorted.slice(start, start + first);
  const nodes = page.map(toNode);
  const endCursor = page.length ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return {
    __typename: 'Connection',
    source: {
      nodes,
      edges: nodes.map((node, i) => ({ __typename: 'Edge', source: { node, cursor: cursorFor(page[i]?.number ?? 0) } })),
      pageInfo: {
        __typename: 'PageInfo',
        source: {
          hasNextPage: start + page.length < sorted.length,
          hasPreviousPage: start > 0,
          startCursor: page.length ? cursorFor(page[0]?.number ?? 0) : null,
          endCursor,
        },
      },
      totalCount: sorted.length,
    },
  };
}

function issueObject(forge: Forge, repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', source: { repo, issue, forge } };
}

function pullObject(forge: Forge, repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', source: { repo, pull, forge } };
}

function repoObject(forge: Forge, repo: Repo): GqlObject {
  return { __typename: 'Repository', source: { repo, forge } };
}

function resolveNode(exec: Executor, id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.key.split('/');
    const repo = owner && name ? exec.forge.getRepo(owner, name) : undefined;
    return repo ? repoObject(exec.forge, repo) : null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const hash = decoded.key.lastIndexOf('#');
    if (hash < 0) return null;
    const repoKey = decoded.key.slice(0, hash);
    const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
    const [owner, name] = repoKey.split('/');
    const repo = owner && name ? exec.forge.getRepo(owner, name) : undefined;
    if (!repo) return null;
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueObject(exec.forge, repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullObject(exec.forge, repo, pull) : null;
  }
  if (decoded.kind === 'User') {
    return { __typename: 'User', source: { login: decoded.key, id: 0, name: decoded.key, email: `${decoded.key}@example.invalid` } };
  }
  return null;
}

function mergeableOf(forge: Forge, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseTip) return 'UNKNOWN';
  const merged = forge.threeWayMerge(repo, pull.headSha, baseTip);
  return 'conflict' in merged ? 'CONFLICTING' : 'MERGEABLE';
}

function executeSelection(exec: Executor, parent: GqlObject, selections: SelectionNode[]): Plain {
  const out: Plain = {};
  for (const selection of selections) {
    if (selection.fragmentType) {
      if (selection.fragmentType !== parent.__typename && selection.fragmentType !== 'Node') continue;
      Object.assign(out, executeSelection(exec, parent, selection.selection));
      continue;
    }
    const key = selection.alias ?? selection.name;
    try {
      let value: unknown;
      if (parent.__typename.endsWith('Payload') || parent.__typename === 'CommentEdge') {
        value = resolvePayload(exec, parent, selection, selection.selection);
      } else {
        value = resolveField(exec, parent, selection, selection.selection);
      }
      out[key] = value;
    } catch (err) {
      if (err instanceof GqlError) {
        exec.errors.push({ message: err.message });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function resolveField(exec: Executor, parent: GqlObject, node: SelectionNode, sub: SelectionNode[]): unknown {
  const { forge } = exec;
  const args = evalArgs(node, exec.variables);
  const type = parent.__typename;
  const field = node.name;
  const knownFields = TYPE_FIELDS[type];
  const isRoot = type === 'Query' || type === 'Mutation';

  if (type === 'Query') {
    if (field === 'viewer') {
      const viewer = forge.viewer;
      return executeSelection(exec, { __typename: 'User', source: viewer }, sub);
    }
    if (field === 'repository') {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? forge.getRepo(args.owner, args.name) : undefined;
      if (!repo) return null;
      return executeSelection(exec, repoObject(forge, repo), sub);
    }
    if (field === 'node') {
      const resolved = resolveNode(exec, args.id);
      if (!resolved) return null;
      return executeSelection(exec, resolved, sub);
    }
    if (field === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const fields = TYPE_FIELDS[name];
      const enumValues = name === 'SearchType' ? SEARCH_TYPE_VALUES : null;
      if (!fields && !enumValues) return null;
      const typeObj: GqlObject = {
        __typename: '__Type',
        source: { name, fields: fields ?? [], enumValues: enumValues ?? [] },
      };
      return executeSelection(exec, typeObj, sub);
    }
    if (field === '__schema') throw new GqlError('Cannot query field "__schema" on type "Query".');
    throw new GqlError(`Cannot query field "${field}" on type "Query".`);
  }

  if (type === 'Mutation') {
    return executeMutation(exec, field, args, sub);
  }

  if (knownFields && !knownFields.includes(field)) {
    throw new GqlError(`Cannot query field "${field}" on type "${type}".`);
  }

  const src = parent.source as Plain;
  switch (type) {
    case 'User': {
      if (field === 'login') return (src.login as string) ?? forge.viewer.login;
      if (field === 'id') return globalId('User', (src.login as string) ?? forge.viewer.login);
      if (field === 'name') return (src.name as string) ?? '';
      if (field === 'email') return (src.email as string) ?? '';
      if (field === 'databaseId') return (src.id as number) ?? 0;
      if (field === 'url') return `/api/v3/users/${src.login as string}`;
      return null;
    }
    case 'Repository': {
      const repo = src.repo as Repo;
      if (field === 'id') return globalId('Repository', repo.fullName);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return repo.fullName;
      if (field === 'owner') return executeSelection(exec, { __typename: 'User', source: forge.viewer }, sub);
      if (field === 'defaultBranchRef') {
        const tip = repo.tip();
        if (!tip) return null;
        return executeSelection(exec, { __typename: 'Ref', source: { name: repo.defaultBranch } }, sub);
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'createdAt' || field === 'updatedAt') return FIXED_ISO;
      if (field === 'url') return `/api/v3/repos/${repo.fullName}`;
      if (field === 'issue') {
        const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
        if (!issue) return null;
        return executeSelection(exec, issueObject(forge, repo, issue), sub);
      }
      if (field === 'issues') {
        let issues = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
        return executeSelection(
          exec,
          paginateConnection(issues, args, direction, (issue) => issueObject(forge, repo, issue)),
          sub,
        );
      }
      if (field === 'pullRequest') {
        const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
        if (!pull) return null;
        return executeSelection(exec, pullObject(forge, repo, pull), sub);
      }
      if (field === 'pullRequests') {
        let pulls = [...repo.pulls.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          pulls = pulls.filter((pull) => wanted.has(pull.state));
        } else {
          pulls = pulls.filter((pull) => pull.state === 'open');
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
        return executeSelection(
          exec,
          paginateConnection(pulls, args, direction, (pull) => pullObject(forge, repo, pull)),
          sub,
        );
      }
      return null;
    }
    case 'Issue': {
      const issue = src.issue as Issue;
      const repo = src.repo as Repo;
      if (field === 'id') return globalId('Issue', `${repo.fullName}#${issue.number}`);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state.toUpperCase();
      if (field === 'body') return issue.body;
      if (field === 'createdAt' || field === 'updatedAt') return FIXED_ISO;
      if (field === 'author') return executeSelection(exec, { __typename: 'User', source: forge.viewer }, sub);
      if (field === 'url') return `https://github.com/${repo.fullName}/issues/${issue.number}`;
      if (field === 'labels') {
        const nodes = issue.labels.map((name) => ({ __typename: 'Label', source: { name } }));
        return executeSelection(exec, { __typename: 'Connection', source: { nodes, edges: [], pageInfo: { __typename: 'PageInfo', source: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } }, totalCount: nodes.length } }, sub);
      }
      if (field === 'comments') {
        const nodes = issue.comments.map((comment) => ({ __typename: 'IssueComment', source: { repo, issue, comment, forge } }));
        return executeSelection(exec, { __typename: 'Connection', source: { nodes, edges: [], pageInfo: { __typename: 'PageInfo', source: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } }, totalCount: nodes.length } }, sub);
      }
      return null;
    }
    case 'PullRequest': {
      const pull = src.pull as Pull;
      const repo = src.repo as Repo;
      if (field === 'id') return globalId('PullRequest', `${repo.fullName}#${pull.number}`);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'state') return pull.state.toUpperCase();
      if (field === 'body') return pull.body;
      if (field === 'headRefName') return pull.head;
      if (field === 'baseRefName') return pull.base;
      if (field === 'mergeable') return mergeableOf(forge, repo, pull);
      if (field === 'merged') return pull.merged;
      if (field === 'createdAt' || field === 'updatedAt') return FIXED_ISO;
      if (field === 'author') return executeSelection(exec, { __typename: 'User', source: forge.viewer }, sub);
      if (field === 'url') return `https://github.com/${repo.fullName}/pull/${pull.number}`;
      if (field === 'headRef' || field === 'baseRef') {
        return executeSelection(exec, { __typename: 'Ref', source: { name: field === 'headRef' ? pull.head : pull.base } }, sub);
      }
      if (field === 'files') {
        const baseOid = forge.mergeBase(repo, pull.headSha, pull.baseSha);
        const baseFlat = baseOid ? forge.flattenCommit(repo, baseOid) : new Map<string, { mode: string; oid: string }>();
        const headFlat = forge.flattenCommit(repo, pull.headSha);
        const diff = forge.diffFlat(repo, baseFlat, headFlat);
        const nodes = diff.map((entry) => ({ __typename: 'PullRequestFile', source: { path: entry.path } }));
        return executeSelection(exec, { __typename: 'Connection', source: { nodes, edges: [], pageInfo: { __typename: 'PageInfo', source: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } }, totalCount: nodes.length } }, sub);
      }
      return null;
    }
    case 'IssueComment': {
      const comment = src.comment as Comment;
      const repo = src.repo as Repo;
      const issue = src.issue as Issue;
      if (field === 'id') return globalId('IssueComment', `${repo.fullName}#${issue.number}:${comment.id}`);
      if (field === 'body') return comment.body;
      if (field === 'createdAt' || field === 'updatedAt') return FIXED_ISO;
      if (field === 'author') return executeSelection(exec, { __typename: 'User', source: forge.viewer }, sub);
      if (field === 'url') return `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`;
      return null;
    }
    case 'Ref': {
      if (field === 'name') return src.name as string;
      if (field === 'id') return globalId('Ref', String(src.name ?? ''));
      return null;
    }
    case 'Label': {
      if (field === 'name') return src.name as string;
      if (field === 'id') return globalId('Label', String(src.name ?? ''));
      return null;
    }
    case 'PullRequestFile': {
      if (field === 'path') return src.path as string;
      return null;
    }
    case 'Connection': {
      if (field === 'nodes') {
        const nodes = src.nodes as GqlObject[];
        return nodes.map((node) => executeSelection(exec, node, sub));
      }
      if (field === 'edges') {
        const edges = src.edges as GqlObject[];
        return edges.map((edge) => executeSelection(exec, edge, sub));
      }
      if (field === 'pageInfo') {
        const pageInfo = src.pageInfo as GqlObject;
        return executeSelection(exec, pageInfo, sub);
      }
      if (field === 'totalCount') return src.totalCount as number;
      return null;
    }
    case 'Edge': {
      if (field === 'node') return executeSelection(exec, src.node as GqlObject, sub);
      if (field === 'cursor') return src.cursor as string;
      return null;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return src.hasNextPage as boolean;
      if (field === 'hasPreviousPage') return src.hasPreviousPage as boolean;
      if (field === 'startCursor') return (src.startCursor as string | null) ?? null;
      if (field === 'endCursor') return (src.endCursor as string | null) ?? null;
      return null;
    }
    case '__Type': {
      if (field === 'name') return src.name as string;
      if (field === 'kind') return (src.enumValues as string[]).length ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const names = src.fields as string[];
        return names.map((name) => executeSelection(exec, { __typename: '__Field', source: { name } }, sub));
      }
      if (field === 'enumValues') {
        const names = src.enumValues as string[];
        return names.map((name) => executeSelection(exec, { __typename: '__EnumValue', source: { name } }, sub));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return src.name as string;
      return null;
    }
    default:
      if (!isRoot) throw new GqlError(`Cannot query field "${field}" on type "${type}".`);
      return null;
  }
}

function executeMutation(exec: Executor, field: string, args: Record<string, unknown>, sub: SelectionNode[]): unknown {
  const { forge } = exec;
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (field === 'createIssue') {
    const repoObj = resolveNode(exec, input.repositoryId);
    if (!repoObj || repoObj.__typename !== 'Repository') throw new GqlError('createIssue: repositoryId does not name a repository');
    const repo = (repoObj.source as Plain).repo as Repo;
    const title = input.title;
    if (typeof title !== 'string' || !title) throw new GqlError('createIssue: title is required');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      number,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      seq: number,
      comments: [],
    };
    repo.issues.set(number, issue);
    return executeSelection(exec, { __typename: 'CreateIssuePayload', source: { issue, repo, forge } }, sub);
  }

  if (field === 'closeIssue') {
    const issueObj = resolveNode(exec, input.issueId);
    if (!issueObj || issueObj.__typename !== 'Issue') throw new GqlError('closeIssue: issueId does not name an issue');
    const issue = ((issueObj.source as Plain).issue as Issue);
    issue.state = 'closed';
    return executeSelection(exec, { __typename: 'CloseIssuePayload', source: { issue, repo: (issueObj.source as Plain).repo as Repo, forge } }, sub);
  }

  if (field === 'createPullRequest') {
    const repoObj = resolveNode(exec, input.repositoryId);
    if (!repoObj || repoObj.__typename !== 'Repository') throw new GqlError('createPullRequest: repositoryId does not name a repository');
    const repo = (repoObj.source as Plain).repo as Repo;
    const head = input.headRefName;
    const base = input.baseRefName;
    const title = input.title;
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
      throw new GqlError('createPullRequest: headRefName, baseRefName and title are required');
    }
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) throw new GqlError('createPullRequest: head or base branch does not exist');
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === head && existing.base === base) {
        throw new GqlError('createPullRequest: a pull request already exists for this branch');
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      number,
      title,
      body: typeof input.body === 'string' ? input.body : '',
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
    return executeSelection(exec, { __typename: 'CreatePullRequestPayload', source: { pull, repo, forge } }, sub);
  }

  if (field === 'mergePullRequest') {
    const pullObj = resolveNode(exec, input.pullRequestId);
    if (!pullObj || pullObj.__typename !== 'PullRequest') throw new GqlError('mergePullRequest: pullRequestId does not name a pull request');
    const pull = (pullObj.source as Plain).pull as Pull;
    const repo = (pullObj.source as Plain).repo as Repo;
    if (!pull.merged && pull.state === 'open') {
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (!baseTip) throw new GqlError('mergePullRequest: base branch not found');
      const merged = forge.threeWayMerge(repo, pull.headSha, baseTip);
      if ('conflict' in merged) throw new GqlError('mergePullRequest: merge conflict');
      const treeOid = forge.buildTreeFromFlat(repo, merged.flat);
      const identity = `${forge.viewer.name} <${forge.viewer.email}>`;
      const squash = String(input.mergeMethod ?? '').toUpperCase() === 'SQUASH';
      const data = buildCommit({
        tree: treeOid,
        parents: squash ? [baseTip] : [baseTip, pull.headSha],
        message: squash ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`,
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
    }
    return executeSelection(exec, { __typename: 'MergePullRequestPayload', source: { pull, repo, forge } }, sub);
  }

  if (field === 'addComment') {
    const subject = resolveNode(exec, input.subjectId);
    if (!subject) throw new GqlError('addComment: subjectId does not name a node');
    const body = input.body;
    if (typeof body !== 'string' || !body) throw new GqlError('addComment: body is required');
    let targetIssue: Issue | null = null;
    let targetRepo: Repo | null = null;
    if (subject.__typename === 'Issue') {
      targetIssue = (subject.source as Plain).issue as Issue;
      targetRepo = (subject.source as Plain).repo as Repo;
    } else if (subject.__typename === 'PullRequest') {
      const pull = (subject.source as Plain).pull as Pull;
      targetRepo = (subject.source as Plain).repo as Repo;
      targetIssue = targetRepo.issues.get(pull.number) ?? null;
      if (!targetIssue) {
        pull.comments.push({ id: targetRepo.nextCommentId, body, seq: targetRepo.nextCommentId });
        const comment: Comment = pull.comments[pull.comments.length - 1] as Comment;
        targetRepo.nextCommentId += 1;
        return executeSelection(
          exec,
          { __typename: 'AddCommentPayload', source: { comment, repo: targetRepo, issue: { number: pull.number } as Issue, forge } },
          sub,
        );
      }
    } else {
      throw new GqlError('addComment: subjectId does not name an issue or pull request');
    }
    const comment: Comment = { id: (targetRepo as Repo).nextCommentId, body, seq: (targetRepo as Repo).nextCommentId };
    (targetRepo as Repo).nextCommentId += 1;
    (targetIssue as Issue).comments.push(comment);
    return executeSelection(
      exec,
      { __typename: 'AddCommentPayload', source: { comment, repo: targetRepo, issue: targetIssue, forge } },
      sub,
    );
  }

  throw new GqlError(`Cannot query field "${field}" on type "Mutation".`);
}

// Payload types resolve their single object field through the shared resolver.
function resolvePayload(exec: Executor, parent: GqlObject, node: SelectionNode, sub: SelectionNode[]): unknown {
  const src = parent.source as Plain;
  const field = node.name;
  if (parent.__typename === 'CreateIssuePayload' || parent.__typename === 'CloseIssuePayload') {
    if (field === 'issue') {
      const issue = src.issue as Issue;
      const repo = src.repo as Repo;
      return executeSelection(exec, issueObject(exec.forge, repo, issue), sub);
    }
  }
  if (parent.__typename === 'CreatePullRequestPayload' || parent.__typename === 'MergePullRequestPayload') {
    if (field === 'pullRequest') {
      const pull = src.pull as Pull;
      const repo = src.repo as Repo;
      return executeSelection(exec, pullObject(exec.forge, repo, pull), sub);
    }
  }
  if (parent.__typename === 'AddCommentPayload') {
    if (field === 'commentEdge') {
      const comment = src.comment as Comment;
      const repo = src.repo as Repo;
      const issue = src.issue as Issue;
      const edge: GqlObject = {
        __typename: 'CommentEdge',
        source: { node: { __typename: 'IssueComment', source: { repo, issue, comment, forge: exec.forge } }, cursor: cursorFor(comment.id) },
      };
      return executeSelection(exec, edge, sub);
    }
  }
  if (parent.__typename === 'CommentEdge') {
    if (field === 'node') return executeSelection(exec, src.node as GqlObject, sub);
    if (field === 'cursor') return src.cursor as string;
  }
  throw new GqlError(`Cannot query field "${field}" on type "${parent.__typename}".`);
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

function runOperation(forge: Forge, operation: OperationNode, variables: Record<string, unknown>): { data: Plain | null; errors?: Array<{ message: string }> } {
  const exec: Executor = { forge, variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType, source: {} };
  let data: Plain | null = null;
  try {
    data = executeSelection(exec, root, operation.selection);
  } catch (err) {
    if (err instanceof GqlError) {
      exec.errors.push({ message: err.message });
      data = null;
    } else {
      throw err;
    }
  }
  if (exec.errors.length) return { data, errors: exec.errors };
  return { data };
}

export function graphqlHandler(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const requests = Array.isArray(parsed.value) ? (parsed.value as unknown[]) : [parsed.value];
  const results: Array<{ data: Plain | null; errors?: Array<{ message: string }> }> = [];
  for (const request of requests) {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      results.push({ data: null, errors: [{ message: 'GraphQL request must be an object with a query string' }] });
      continue;
    }
    const body = request as Record<string, unknown>;
    const query = body.query;
    if (typeof query !== 'string' || !query.trim()) {
      results.push({ data: null, errors: [{ message: 'GraphQL query is required' }] });
      continue;
    }
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
    try {
      const operations = new Parser(tokenize(query)).parseDocument();
      let operation = operations[0];
      if (operations.length > 1) {
        operation = operations.find((op) => op.name === operationName) ?? operations[0];
      }
      if (!operation) {
        results.push({ data: null, errors: [{ message: 'GraphQL document is empty' }] });
        continue;
      }
      const mergedVariables: Record<string, unknown> = { ...variables };
      for (const [name, defaultValue] of Object.entries(operation.variables)) {
        if (mergedVariables[name] === undefined && defaultValue !== null) {
          mergedVariables[name] = evalValue(defaultValue, {});
        }
      }
      results.push(runOperation(ctx.forge, operation, mergedVariables));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
    }
  }
  sendJson(ctx.res, 200, Array.isArray(parsed.value) ? results : results[0]);
}

export function registerGraphqlRoutes(router: Router, _forge: Forge): void {
  router.post('/api/graphql', graphqlHandler);
}
