// The forge's in-memory store: repositories, git objects, refs, issues,
// pull requests, labels and comments — plus the git-graph operations the
// REST and git surfaces share (ancestry, merge-base, tree flatten/build,
// three-way merge, file diffs).
//
// Nothing here touches the clock or the network: every timestamp the forge
// authors is the fixed stamp from seed.ts, so two runs of a trial leave
// byte-identical state.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git.ts';
import { DEFAULT_BRANCH, FIXED_EPOCH_SEC, FIXED_ISO, viewerUser, type ScenarioUser } from './seed.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
  comments: Comment[];
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  nextNumber = 1;
  nextCommentId = 1;
  /** Fetch-response cache: key -> finished response bytes (pack + framing). */
  fetchCache = new Map<string, Buffer>();
  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string, createdSeq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdSeq = createdSeq;
  }
  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }
  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }
  tip(branch = this.defaultBranch): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

export class Forge {
  readonly token: string;
  readonly viewer: ScenarioUser;
  repos = new Map<string, Repo>();
  #repoSeq = 0;
  #nextRepoId = 5000;

  constructor(token: string) {
    this.token = token;
    this.viewer = viewerUser();
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.#nextRepoId, owner, name, opts.description ?? '', opts.isPrivate ?? false, opts.defaultBranch ?? DEFAULT_BRANCH, this.#repoSeq);
    this.#nextRepoId += 1;
    this.#repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -- git objects ---------------------------------------------------------

  putObject(repo: Repo, obj: GitObject): string {
    const oid = hashObject(obj.type, obj.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store every object of a parsed pack. */
  storePack(repo: Repo, objects: Iterable<GitObject>): void {
    for (const obj of objects) this.putObject(repo, obj);
  }

  // -- git graph -----------------------------------------------------------

  commitView(repo: Repo, oid: string): ReturnType<typeof parseCommit> {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') throw new Error(`not a commit: ${oid}`);
    return parseCommit(obj.data);
  }

  /** All commit ids reachable from `oid` (itself included). */
  ancestors(repo: Repo, oid: string): Set<string> {
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length) {
      const cur = queue.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
    return seen;
  }

  isAncestor(repo: Repo, maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    return this.ancestors(repo, oid).has(maybeAncestor);
  }

  /** A merge base of `a` and `b` (first common commit found walking from b). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const inA = this.ancestors(repo, a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (inA.has(cur)) return cur;
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Flatten a tree to path -> {mode, oid} (blobs only; subtrees walked). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  flattenCommit(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    return this.flattenTree(repo, this.commitView(repo, commitOid).tree);
  }

  /** Build (nested) tree objects from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      entries: Map<string, TreeEntry>;
    }
    const root: Node = { entries: new Map() };
    const dirs = new Map<string, Node>();
    dirs.set('', root);
    const nodeFor = (dir: string): Node => {
      const existing = dirs.get(dir);
      if (existing) return existing;
      const parentPath = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      const parent = nodeFor(parentPath);
      const node: Node = { entries: new Map() };
      dirs.set(dir, node);
      parent.entries.set(dir.slice(parentPath ? parentPath.length + 1 : 0), { mode: '40000', name: dir.slice(parentPath ? parentPath.length + 1 : 0), oid: '' });
      return node;
    };
    for (const [path, entry] of [...flat.entries()].sort()) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      nodeFor(dir).entries.set(name, { mode: entry.mode, name, oid: entry.oid });
    }
    const build = (dir: string): string => {
      const node = dirs.get(dir) as Node;
      const entries: TreeEntry[] = [];
      for (const entry of node.entries.values()) {
        if (entry.mode === '40000') {
          const sub = dir ? `${dir}/${entry.name}` : entry.name;
          entries.push({ mode: '40000', name: entry.name, oid: build(sub) });
        } else {
          entries.push(entry);
        }
      }
      const data = buildTree(entries);
      return this.putObject(repo, { type: 'tree', data });
    };
    return build('');
  }

  /** Create a commit object on `branch` (or unborn) and move the ref. */
  makeCommit(repo: Repo, opts: { branch: string; tree: string; parents: string[]; message: string; author?: string }): string {
    const identity = opts.author ?? `${this.viewer.name} <${this.viewer.email}>`;
    const data = buildCommit({
      tree: opts.tree,
      parents: opts.parents,
      message: opts.message,
      author: identity,
      committer: identity,
      timestamp: FIXED_EPOCH_SEC,
    });
    const oid = this.putObject(repo, { type: 'commit', data });
    repo.refs.set(`refs/heads/${opts.branch}`, oid);
    repo.fetchCache.clear();
    return oid;
  }

  // -- diff / merge --------------------------------------------------------

  /** Line counts for a changed file: additions/deletions by a small LCS diff. */
  static lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    if (oldLines.length * newLines.length > 250_000) {
      return { additions: newLines.length, deletions: oldLines.length };
    }
    const n = oldLines.length;
    const m = newLines.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    let additions = 0;
    let deletions = 0;
    while (i < n && j < m) {
      if (oldLines[i] === newLines[j]) {
        i += 1;
        j += 1;
      } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
        deletions += 1;
        i += 1;
      } else {
        additions += 1;
        j += 1;
      }
    }
    deletions += n - i;
    additions += m - j;
    return { additions, deletions };
  }

  /** Changed paths between two flat trees, with per-file change counts. */
  diffFlat(
    repo: Repo,
    base: Map<string, { mode: string; oid: string }>,
    head: Map<string, { mode: string; oid: string }>,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; oldOid: string | null; newOid: string | null }> {
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const counts = Forge.lineDiff(oldText, '');
        out.push({ path, status: 'removed', additions: 0, deletions: counts.deletions, oldOid: b.oid, newOid: null });
      } else if (!b && h) {
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const counts = Forge.lineDiff('', newText);
        out.push({ path, status: 'added', additions: counts.additions, deletions: 0, oldOid: null, newOid: h.oid });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const counts = Forge.lineDiff(oldText, newText);
        out.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions, oldOid: b.oid, newOid: h.oid });
      }
    }
    return out;
  }

  /**
   * Three-way merge of `headOid` into `baseTipOid` (both commits). Returns the
   * merged flat tree, or the conflicting paths when both sides changed the
   * same path differently since their merge base.
   */
  threeWayMerge(repo: Repo, headOid: string, baseTipOid: string): { flat: Map<string, { mode: string; oid: string }> } | { conflict: string[] } {
    const baseOid = this.mergeBase(repo, headOid, baseTipOid);
    const baseFlat = baseOid ? this.flattenCommit(repo, baseOid) : new Map<string, { mode: string; oid: string }>();
    const headFlat = this.flattenCommit(repo, headOid);
    const tipFlat = this.flattenCommit(repo, baseTipOid);
    const merged = new Map<string, { mode: string; oid: string }>();
    const conflicts: string[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = tipFlat.get(path);
      const bOid = b?.oid ?? null;
      const hOid = h?.oid ?? null;
      const tOid = t?.oid ?? null;
      if (hOid === tOid) {
        if (h) merged.set(path, h);
      } else if (bOid === hOid) {
        if (t) merged.set(path, t);
      } else if (bOid === tOid) {
        if (h) merged.set(path, h);
      } else {
        conflicts.push(path);
      }
    }
    if (conflicts.length) return { conflict: conflicts.sort() };
    return { flat: merged };
  }

  /** Objects reachable from a set of tips (for fetch planning). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => repo.objects.get(oid), { allowMissing: false });
  }
}

// -------------------------------------------------------------------------------------------
// JSON views (GitHub shapes)
// -------------------------------------------------------------------------------------------

export function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', user.login),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = userJson(forge.viewer);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.fullName),
    name: repo.name,
    full_name: repo.fullName,
    owner,
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
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
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.size + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: 10000 + issue.number,
    node_id: globalId('Issue', `${repo.fullName}#${issue.number}`),
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(forge.viewer),
    labels: issue.labels.map((name) => ({ id: 20000 + name.length, node_id: globalId('Label', `${repo.fullName}:${name}`), url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`, name, color: repo.labels.get(name)?.color ?? 'ededed', default: false, description: repo.labels.get(name)?.description ?? '' })),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    active_lock_reason: null,
  };
}

export function commentJson(forge: Forge, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.fullName}#${issueNumber}:${comment.id}`),
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(forge.viewer),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    author_association: 'OWNER',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: 30000 + pull.number,
    node_id: globalId('PullRequest', `${repo.fullName}#${pull.number}`),
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(forge.viewer),
    body: pull.body ?? '',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.fullName}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.fullName}/commits/${pull.headSha}/statuses`,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userJson(forge.viewer), repo: repoJson(forge, repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userJson(forge.viewer), repo: repoJson(forge, repo) },
    author_association: 'OWNER',
    auto_merge: null,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson(forge.viewer) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}
