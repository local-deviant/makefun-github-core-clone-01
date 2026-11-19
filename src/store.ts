// The in-memory store: one Repo per repository, all lookups O(1) Maps.
// No wall-clock time anywhere: every stored timestamp is the fixed epoch.
// Ids are stable opaque base64 ("Kind:key"); databaseIds are small sequential ints.

import { FIXED_EPOCH, lineDiff, opaqueId, objectId } from './util.ts';
import {
  buildCommit,
  buildTree,
  parseCommit,
  parseTree,
  sortTreeEntries,
  type CommitInfo,
  type GitObject,
  type TreeEntry,
} from './objects.ts';

export const FIXED_TIME = '2025-01-01T00:00:00Z';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1;
const AUTHOR_LINE = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@users.noreply.github.com> ${FIXED_EPOCH} +0000`;

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  readonly name: string;
  readonly owner: string;
  readonly databaseId: number;
  readonly id: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdAt = FIXED_TIME;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  labels = new Map<string, Label>();
  /** Shared counter for issue and pull numbers (GitHub numbers them together). */
  nextNumber = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  /** Generation bumps on every ref move; fetch-cache entries pin the generation they were built at. */
  generation = 0;

  // --- small caches, all keyed by object id, all invalidated by generation where it matters
  private commitCache = new Map<string, CommitInfo>();
  private treeCache = new Map<string, TreeEntry[]>();
  private fetchCache = new Map<string, { gen: number; pack: Buffer }>();

  constructor(owner: string, name: string, databaseId: number, description: string, isPrivate: boolean) {
    this.owner = owner;
    this.name = name;
    this.databaseId = databaseId;
    this.description = description;
    this.isPrivate = isPrivate;
    this.id = opaqueId('Repository', `${owner}/${name}`);
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  putObject(type: GitObject['type'], content: Buffer): string {
    const id = objectId(type, content);
    if (!this.objects.has(id)) this.objects.set(id, { type, content });
    return id;
  }

  getObject(id: string): GitObject | undefined {
    return this.objects.get(id);
  }

  commitInfo(id: string): CommitInfo | undefined {
    let info = this.commitCache.get(id);
    if (info) return info;
    const obj = this.objects.get(id);
    if (!obj || obj.type !== 'commit') return undefined;
    info = parseCommit(obj.content);
    this.commitCache.set(id, info);
    return info;
  }

  treeEntries(id: string): TreeEntry[] | undefined {
    let entries = this.treeCache.get(id);
    if (entries) return entries;
    const obj = this.objects.get(id);
    if (!obj || obj.type !== 'tree') return undefined;
    entries = parseTree(obj.content);
    this.treeCache.set(id, entries);
    return entries;
  }

  /** Fetch-response cache (FIFO, bounded). Returns a hit only for the current generation. */
  fetchGet(key: string): Buffer | undefined {
    const hit = this.fetchCache.get(key);
    if (!hit || hit.gen !== this.generation) return undefined;
    return hit.pack;
  }

  fetchPut(key: string, pack: Buffer): void {
    if (this.fetchCache.size >= 32) {
      const first = this.fetchCache.keys().next().value;
      if (first !== undefined) this.fetchCache.delete(first);
    }
    this.fetchCache.set(key, { gen: this.generation, pack });
  }

  bump(): void {
    this.generation += 1;
  }

  // --- refs ---------------------------------------------------------------

  ref(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, sha: string): void {
    this.refs.set(name, sha);
    this.bump();
  }

  deleteRef(name: string): boolean {
    const ok = this.refs.delete(name);
    if (ok) this.bump();
    return ok;
  }

  /** Branch names, sorted. */
  branches(): string[] {
    const out: string[] = [];
    for (const name of this.refs.keys()) {
      if (name.startsWith('refs/heads/')) out.push(name.slice('refs/heads/'.length));
    }
    out.sort();
    return out;
  }

  // --- issues / pulls / labels --------------------------------------------

  newIssue(title: string, body: string, labels: string[]): Issue {
    const number = this.nextNumber++;
    const issue: Issue = {
      number,
      id: number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      user: VIEWER_LOGIN,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    this.issues.set(number, issue);
    return issue;
  }

  newPull(title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const number = this.nextNumber++;
    const pull: Pull = {
      number,
      id: number,
      title,
      body,
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergeSha: '',
      user: VIEWER_LOGIN,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    this.pulls.set(number, pull);
    return pull;
  }

  newLabel(name: string): Label {
    const label: Label = { id: this.nextLabelId++, name, color: 'ededed', description: '' };
    this.labels.set(name.toLowerCase(), label);
    return label;
  }

  newComment(issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, user: VIEWER_LOGIN, createdAt: FIXED_TIME };
    issue.comments.push(comment);
    return comment;
  }

  /** Squash-merge an open pull request onto its base branch. Returns the merge commit
   *  sha, or a reason the merge cannot happen ('closed' | 'not-found' | 'conflict'). */
  mergePull(pull: Pull): { ok: true; sha: string } | { ok: false; reason: 'closed' | 'not-found' | 'conflict' } {
    if (pull.state !== 'open') return { ok: false, reason: 'closed' };
    const tip = this.ref(`refs/heads/${pull.baseRef}`);
    if (!tip) return { ok: false, reason: 'not-found' };
    const headInfo = this.commitInfo(pull.headSha);
    if (!headInfo) return { ok: false, reason: 'not-found' };
    if (tip !== pull.baseSha && this.hasOverlap(pull.baseSha, pull.headSha, tip)) {
      return { ok: false, reason: 'conflict' };
    }
    const mergeCommit = buildCommit(headInfo.tree, [tip], `${pull.title} (#${pull.number})\n\n${pull.body}`, AUTHOR_LINE, AUTHOR_LINE);
    const mergeSha = this.putObject('commit', mergeCommit);
    this.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = mergeSha;
    pull.updatedAt = FIXED_TIME;
    return { ok: true, sha: mergeSha };
  }

  /** True when the same paths changed from base→head and from base→tip. */
  hasOverlap(baseSha: string, headSha: string, tipSha: string): boolean {
    const baseInfo = this.commitInfo(baseSha);
    const headInfo = this.commitInfo(headSha);
    const tipInfo = this.commitInfo(tipSha);
    if (!baseInfo || !headInfo || !tipInfo) return false;
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const tipFiles = new Map<string, string>();
    this.collectFiles(baseInfo.tree, '', baseFiles);
    this.collectFiles(headInfo.tree, '', headFiles);
    this.collectFiles(tipInfo.tree, '', tipFiles);
    const changed = new Set<string>();
    for (const [p, sha] of headFiles) if (baseFiles.get(p) !== sha) changed.add(p);
    for (const p of baseFiles.keys()) if (!headFiles.has(p)) changed.add(p);
    for (const p of changed) {
      if (tipFiles.get(p) !== baseFiles.get(p)) return true;
    }
    return false;
  }

  // --- tree surgery (contents API + merge) --------------------------------

  /** Read a file's blob id at a path inside a tree, or undefined. */
  getPathBlob(treeId: string, path: string): string | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeId;
    for (let i = 0; i < parts.length; i++) {
      const entries = this.treeEntries(current);
      if (!entries) return undefined;
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry.mode === '40000' ? undefined : entry.id;
      if (entry.mode !== '40000') return undefined;
      current = entry.id;
    }
    return undefined;
  }

  /** List a directory's entries at a path inside a tree ('' = root). */
  listPath(treeId: string, path: string): TreeEntry[] | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeId;
    for (const part of parts) {
      const entries = this.treeEntries(current);
      if (!entries) return undefined;
      const entry = entries.find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return undefined;
      current = entry.id;
    }
    return this.treeEntries(current);
  }

  /**
   * Return a new tree id with `path` set to `blobId` (or removed when blobId is null),
   * rebuilding only the trees on that path. Empty directories are dropped.
   */
  private rewriteTree(treeId: string, parts: string[], blobId: string | null, depth: number): string {
    const entries = this.treeEntries(treeId) ?? [];
    const name = parts[depth];
    const last = depth === parts.length - 1;
    const next: TreeEntry[] = [];
    let found = false;
    for (const e of entries) {
      if (e.name !== name) {
        next.push(e);
        continue;
      }
      found = true;
      if (last) {
        if (blobId !== null) next.push({ mode: '100644', name, id: blobId });
        // else: drop the entry
      } else {
        if (e.mode !== '40000') continue;
        const sub = this.rewriteTree(e.id, parts, blobId, depth + 1);
        const subEntries = this.treeEntries(sub);
        if (subEntries && subEntries.length > 0) next.push({ mode: '40000', name, id: sub });
        // else: the directory emptied out, drop it
      }
    }
    if (!found && blobId !== null) {
      if (last) {
        next.push({ mode: '100644', name, id: blobId });
      } else {
        const sub = this.rewriteTree(this.putObject('tree', buildTree([])), parts, blobId, depth + 1);
        const subEntries = this.treeEntries(sub);
        if (subEntries && subEntries.length > 0) next.push({ mode: '40000', name, id: sub });
      }
    }
    return this.putObject('tree', buildTree(sortTreeEntries(next)));
  }

  /** Commit a file change on a branch; returns the new commit id. */
  commitFile(branch: string, path: string, content: Buffer, message: string): string {
    const refName = `refs/heads/${branch}`;
    const tip = this.refs.get(refName);
    const blobId = this.putObject('blob', content);
    let treeId: string;
    if (tip) {
      const info = this.commitInfo(tip);
      treeId = info ? this.rewriteTree(info.tree, path.split('/').filter((p) => p !== ''), blobId, 0) : this.putObject('tree', buildTree([]));
    } else {
      treeId = this.rewriteTree(this.putObject('tree', buildTree([])), path.split('/').filter((p) => p !== ''), blobId, 0);
    }
    const commit = buildCommit(treeId, tip ? [tip] : [], message, AUTHOR_LINE, AUTHOR_LINE);
    const commitId = this.putObject('commit', commit);
    this.setRef(refName, commitId);
    return commitId;
  }

  /** Delete a file on a branch; returns the new commit id, or '' when the path is absent. */
  deleteFile(branch: string, path: string, message: string): string {
    const refName = `refs/heads/${branch}`;
    const tip = this.refs.get(refName);
    if (!tip) return '';
    const info = this.commitInfo(tip);
    if (!info) return '';
    const parts = path.split('/').filter((p) => p !== '');
    if (this.getPathBlob(info.tree, path) === undefined) return '';
    const treeId = this.rewriteTree(info.tree, parts, null, 0);
    const commit = buildCommit(treeId, [tip], message, AUTHOR_LINE, AUTHOR_LINE);
    const commitId = this.putObject('commit', commit);
    this.setRef(refName, commitId);
    return commitId;
  }

  /** All paths (file blobs) under a tree, with their blob ids. */
  collectFiles(treeId: string, prefix: string, out: Map<string, string>): void {
    const entries = this.treeEntries(treeId);
    if (!entries) return;
    for (const e of entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.collectFiles(e.id, p, out);
      else out.set(p, e.id);
    }
  }

  /** Files changed between two commits: {path, status, sha}, sorted by path. */
  diffFiles(baseSha: string, headSha: string): Array<{ path: string; status: string; sha: string; additions: number; deletions: number }> {
    const baseInfo = this.commitInfo(baseSha);
    const headInfo = this.commitInfo(headSha);
    if (!baseInfo || !headInfo) return [];
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    this.collectFiles(baseInfo.tree, '', baseFiles);
    this.collectFiles(headInfo.tree, '', headFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ path: string; status: string; sha: string; additions: number; deletions: number }> = [];
    for (const p of [...paths].sort()) {
      const b = baseFiles.get(p);
      const h = headFiles.get(p);
      if (b === h) continue;
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      const oldText = b === undefined ? '' : (this.getObject(b)?.content.toString('utf8') ?? '');
      const newText = h === undefined ? '' : (this.getObject(h)?.content.toString('utf8') ?? '');
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ path: p, status, sha: h ?? b ?? '', additions, deletions });
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (bounded walk). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    let steps = 0;
    while (stack.length > 0 && steps < 100000) {
      const id = stack.pop() as string;
      if (id === ancestor) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      steps += 1;
      const info = this.commitInfo(id);
      if (info) for (const p of info.parents) stack.push(p);
    }
    return false;
  }

  /** Walk commits from a tip, newest first (parents after the commit, breadth-ish order). */
  walkCommits(tip: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && out.length < limit) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const info = this.commitInfo(id);
      if (!info) continue;
      out.push(id);
      for (const p of info.parents) queue.push(p);
    }
    return out;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(VIEWER_LOGIN, name, this.nextRepoId++, description, isPrivate);
    this.repos.set(repo.fullName.toLowerCase(), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`.toLowerCase());
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => (a.databaseId - b.databaseId));
  }
}
