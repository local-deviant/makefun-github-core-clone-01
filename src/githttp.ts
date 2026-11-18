// Smart-HTTP git surface: protocol v2 upload-pack (ls-refs, fetch), v0
// upload-pack advertisement + fetch, and v0 receive-pack (push).
//
// Wire formats follow the public git protocol (pkt-line framing, sideband,
// report-status). The planner below is my own: a depth-limited walk from the
// wants that stops at the client's haves / shallow boundary, so incremental
// and shallow fetches send exactly the objects the client lacks.

import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  pktFlush,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { Forge, type Repo } from './store.ts';
import { notFound, requireAuth, sendBuffer, sendError, type Ctx, type Router } from './http.ts';

const AGENT = 'makefun-github-core-clone/1.0';
const SIDEBAND_CHUNK = 65500;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs, HEAD first, then heads and tags sorted. */
function listRefs(repo: Repo, opts: { peel?: boolean } = {}): RefLine[] {
  const out: RefLine[] = [];
  const tip = repo.tip();
  if (tip) {
    out.push({ oid: tip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (opts.peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        const targetObj = repo.objects.get(target);
        if (targetObj && targetObj.type === 'commit') line.peeled = target;
      }
    }
    out.push(line);
  }
  return out;
}

function v0UploadCapabilities(): string {
  return `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=${AGENT}`;
}

function v0ReceiveCapabilities(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? v0UploadCapabilities() : v0ReceiveCapabilities();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0 && service === 'git-upload-pack') {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else if (realRefs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = refs[0] as RefLine;
    lines.push(`${head.oid} HEAD\0${caps}\n`);
    for (const ref of realRefs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, sorted by oid for determinism. */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Peel an annotated tag (recursively) to the commit it points at, if any. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Tree closure (trees + blobs) of a commit, plus the commit itself. */
function commitClosure(repo: Repo, commitOid: string): Set<string> {
  const out = new Set<string>([commitOid]);
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  const treeOid = parseCommit(obj.data).tree;
  for (const oid of collectReachable([treeOid], (id) => repo.objects.get(id), { allowMissing: false })) out.add(oid);
  return out;
}

/** Objects the client already holds: haves plus its shallow boundary commits. */
function heldObjects(repo: Repo, haves: readonly string[], clientShallow: readonly string[]): Set<string> {
  const shallowSet = new Set(clientShallow);
  const held = new Set<string>();
  const queue = [...haves, ...clientShallow];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      for (const child of commitClosure(repo, oid)) held.add(child);
      if (!shallowSet.has(oid)) {
        for (const parent of parseCommit(obj.data).parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const child of collectReachable([oid], (id) => repo.objects.get(id), { allowMissing: false })) held.add(child);
    }
  }
  return held;
}

export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | null,
): FetchPlan {
  const heldSet = new Set([...haves, ...clientShallow]);
  // Walk commits from the wants. Depth is the edge distance from the nearest
  // want; a depth limit of N includes commits at distance < N.
  const walk = new Set<string>();
  const queue: Array<{ commit: string; depth: number }> = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit) queue.push({ commit, depth: 0 });
  }
  const seenDepth = new Map<string, number>();
  while (queue.length) {
    const { commit, depth } = queue.shift() as { commit: string; depth: number };
    const known = seenDepth.get(commit);
    if (known !== undefined && known <= depth) continue;
    seenDepth.set(commit, depth);
    const limited = deepen !== null && depth >= deepen;
    if (limited) continue;
    const held = heldSet.has(commit);
    if (deepen === null && held) continue; // the client has this commit: stop here
    walk.add(commit);
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      queue.push({ commit: parent, depth: depth + 1 });
    }
  }

  const held = heldObjects(repo, haves, clientShallow);
  const send = new Set<string>();
  for (const commit of walk) {
    for (const oid of commitClosure(repo, commit)) {
      if (!held.has(oid)) send.add(oid);
    }
  }
  // Tag objects the client asked for by oid travel as themselves.
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj && obj.type === 'tag' && !held.has(want)) send.add(want);
  }
  const objects: GitObject[] = [...send]
    .sort()
    .map((oid) => repo.objects.get(oid) as GitObject)
    .filter(Boolean);

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (deepen !== null || clientShallow.length > 0) {
    for (const commit of walk) {
      const obj = repo.objects.get(commit);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.some((parent) => !walk.has(parent))) shallow.push(commit);
    }
    shallow.sort();
    for (const boundary of clientShallow) {
      if (!walk.has(boundary)) continue;
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.every((parent) => walk.has(parent))) unshallow.push(boundary);
    }
    unshallow.sort();
  }
  return { objects, shallow, unshallow };
}

// -------------------------------------------------------------------------------------------
// sideband + section framing
// -------------------------------------------------------------------------------------------

function sidebandPackets(data: Buffer): Buffer[] {
  if (data.length === 0) return [];
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDEBAND_CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** A v2 fetch response: optional shallow-info section, then the packfile section. */
function v2FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.shallow.length || plan.unshallow.length) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  if (plan.objects.length) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(pktFlush());
  } else if (plan.shallow.length || plan.unshallow.length) {
    // A shallow-only response still ends cleanly after the shallow-info section.
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

/** A v0 fetch response: ACK/NAK lines, shallow lines, then the sideband pack. */
function v0FetchResponse(repo: Repo, plan: FetchPlan, wants: readonly string[], haves: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of haves) {
    if (wants.some((want) => {
      const commit = peelToCommit(repo, want);
      return commit !== null && (commit === have || isAncestorOf(repo, have, commit));
    })) {
      acks.push(have);
    }
  }
  if (acks.length) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length) {
    const pack = writePack(plan.objects);
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function isAncestorOf(repo: Repo, maybeAncestor: string, oid: string): boolean {
  if (maybeAncestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur === maybeAncestor) return true;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// request parsing
// -------------------------------------------------------------------------------------------

interface ParsedPktBody {
  /** Data-packet text lines, in order; 'flush'/'delim' markers preserved. */
  items: Array<{ kind: 'line'; text: string } | { kind: 'flush' } | { kind: 'delim' }>;
  /** Offset in the raw body just past the final flush packet (start of a pack). */
  packOffset: number;
}

/** Parse a pkt-line stream. When `stopAfterFirstFlush` is set, parsing stops
 * just past the first flush packet and the rest of the body is the pack
 * (a receive-pack request carries raw pack bytes after its command list). */
function parsePktBody(body: Buffer, stopAfterFirstFlush = false): ParsedPktBody | null {
  const items: ParsedPktBody['items'] = [];
  // Re-walk the buffer tracking how many bytes each packet consumed.
  let offset = 0;
  try {
    for (;;) {
      if (offset + 4 > body.length) break;
      const head = body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        items.push({ kind: 'flush' });
        offset += 4;
        if (stopAfterFirstFlush) break;
        continue;
      }
      if (head === '0001') {
        items.push({ kind: 'delim' });
        offset += 4;
        continue;
      }
      if (head === '0002') {
        items.push({ kind: 'flush' });
        offset += 4;
        if (stopAfterFirstFlush) break;
        continue;
      }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || offset + len > body.length) return null;
      items.push({ kind: 'line', text: body.subarray(offset + 4, offset + len).toString('utf8') });
      offset += len;
    }
  } catch {
    return null;
  }
  return { items, packOffset: offset };
}

function splitSections(items: ParsedPktBody['items']): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const item of items) {
    if (item.kind === 'line') current.push(item.text);
    else {
      sections.push(current);
      current = [];
    }
  }
  sections.push(current);
  return sections;
}

/** Strip the `\0capabilities` suffix from the first command line. */
function stripCapabilities(line: string): string {
  const nul = line.indexOf('\0');
  return nul < 0 ? line : line.slice(0, nul);
}

// -------------------------------------------------------------------------------------------
// handlers
// -------------------------------------------------------------------------------------------

function lookupRepo(ctx: Ctx): Repo | null {
  const owner = ctx.params.owner as string;
  const repoName = ctx.params.repo as string;
  const repo = ctx.forge.getRepo(owner, repoName);
  if (!repo) {
    notFound(ctx.res, 'Not Found');
    return null;
  }
  return repo;
}

export function gitInfoRefs(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx.res, 400, 'service parameter is required');
    return;
  }
  const wantsV2 = ctx.req.headers['git-protocol'] === 'version=2';
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  if (service === 'git-receive-pack' || !wantsV2) {
    sendBuffer(ctx.res, 200, v0Advertisement(service, repo), contentType);
  } else {
    sendBuffer(ctx.res, 200, v2Advertisement(), contentType);
  }
}

function fetchCacheKey(wants: readonly string[], haves: readonly string[], shallow: readonly string[], deepen: number | null): string {
  return JSON.stringify({ w: [...wants].sort(), h: [...haves].sort(), s: [...clientShallowSort(shallow)], d: deepen });
}
function clientShallowSort(list: readonly string[]): string[] {
  return [...list].sort();
}

export function gitUploadPack(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const parsed = parsePktBody(ctx.rawBody);
  if (!parsed) {
    sendError(ctx.res, 400, 'malformed pkt-line stream');
    return;
  }
  const sections = splitSections(parsed.items);
  const first = sections[0]?.[0] ?? '';
  const commandLine = stripCapabilities(first).trim();
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2';

  if (commandLine === 'command=ls-refs') {
    handleLsRefs(ctx, repo, sections);
    return;
  }
  if (commandLine.startsWith('command=fetch') || commandLine.startsWith('want ') || isV2) {
    handleFetch(ctx, repo, sections, isV2);
    return;
  }
  sendError(ctx.res, 400, `unsupported upload-pack command ${JSON.stringify(commandLine.slice(0, 40))}`);
}

function handleLsRefs(ctx: Ctx, repo: Repo, sections: string[][]): void {
  const args = sections[1] ?? [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of listRefs(repo, { peel })) {
    if (ref.unborn) {
      if (!unborn) continue;
      if (!keep(ref.name)) continue;
      lines.push(`unborn ${ref.name} symref-target:${ref.symrefTarget ?? ''}\n`);
      continue;
    }
    if (!keep(ref.name)) continue;
    let text = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) text += ` peeled:${ref.peeled}`;
    if (symrefs && ref.symrefTarget) text += ` symref-target:${ref.symrefTarget}`;
    lines.push(`${text}\n`);
  }
  lines.push('flush');
  sendBuffer(ctx.res, 200, pktLines(lines), 'application/x-git-upload-pack-result');
}

function handleFetch(ctx: Ctx, repo: Repo, sections: string[][], isV2: boolean): void {
  // v2: section 0 = command lines, section 1 = fetch args. v0: section 0 =
  // wants (+ shallow/deepen), section 1 = haves + done.
  const argLines = isV2 ? (sections[1] ?? []) : [...(sections[0] ?? []), ...(sections[1] ?? [])];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n >= 0) deepen = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / agent / object-format /
    // done / deepen-since / deepen-not: parsed for tolerance, no effect here.
  }
  if (wants.length === 0) {
    // An empty clone's fetch never reaches us (the client short-circuits), but
    // answer an empty result anyway rather than hanging.
    sendBuffer(ctx.res, 200, Buffer.alloc(0), 'application/x-git-upload-pack-result');
    return;
  }
  const missing = wants.filter((oid) => !repo.objects.has(oid));
  if (missing.length) {
    if (isV2) {
      const error = pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`object ${missing[0]} not found\n`, 'utf8')]));
      sendBuffer(ctx.res, 200, Buffer.concat([pktLine('packfile\n'), error, pktFlush()]), 'application/x-git-upload-pack-result');
    } else {
      sendError(ctx.res, 404, `object ${missing[0]} not found`);
    }
    return;
  }
  const key = fetchCacheKey(wants, haves, shallow, deepen);
  const cached = repo.fetchCache.get(key);
  if (cached) {
    sendBuffer(ctx.res, 200, cached, 'application/x-git-upload-pack-result');
    return;
  }
  const plan = planFetch(repo, wants, haves, shallow, deepen);
  const response = isV2 ? v2FetchResponse(plan) : v0FetchResponse(repo, plan, wants, haves);
  if (repo.fetchCache.size >= 128) {
    const oldest = repo.fetchCache.keys().next().value as string | undefined;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(key, response);
  sendBuffer(ctx.res, 200, response, 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function gitReceivePack(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const repo = lookupRepo(ctx);
  if (!repo) return;
  const parsed = parsePktBody(ctx.rawBody, true);
  if (!parsed) {
    sendError(ctx.res, 400, 'malformed pkt-line stream');
    return;
  }
  const sections = splitSections(parsed.items);
  const commands: PushCommand[] = [];
  for (const raw of sections[0] ?? []) {
    const line = stripCapabilities(raw).replace(/\n$/, '');
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 3) {
      sendError(ctx.res, 400, 'malformed push command');
      return;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) {
    sendError(ctx.res, 400, 'no push commands');
    return;
  }

  // Unpack the pack (if any). Objects land in the store even when a ref update
  // is later refused — that is how git behaves.
  let unpackError: string | null = null;
  const packBytes = ctx.rawBody.subarray(parsed.packOffset);
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const obj of pack.objects.values()) {
        if (!repo.objects.has(obj.type + ':' + hashObject(obj.type, obj.data))) {
          repo.objects.set(hashObject(obj.type, obj.data), obj);
        }
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError === null) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObj = repo.objects.get(command.newOid);
      if (!newObj) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (command.ref.startsWith('refs/heads/')) {
          const commit = peelToCommit(repo, command.newOid);
          if (commit === null) {
            results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
            continue;
          }
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      // Update of an existing ref.
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.newOid === current) {
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = peelToCommit(repo, command.newOid);
        if (newCommit === null || !isAncestorOf(repo, current, newCommit)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    if (results.some((r) => r.ok)) repo.fetchCache.clear();
  }

  const reportLines: Array<string | 'flush'> = [];
  if (unpackError !== null) {
    reportLines.push(`unpack error: ${unpackError}\n`);
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    reportLines.push('unpack ok\n');
  }
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  reportLines.push('flush');
  const inner = pktLines(reportLines);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()]);
  sendBuffer(ctx.res, 200, outer, 'application/x-git-receive-pack-result');
}

export function registerGitRoutes(router: Router, _forge: Forge): void {
  router.get('/:owner/:repo.git/info/refs', gitInfoRefs);
  router.post('/:owner/:repo.git/git-upload-pack', gitUploadPack);
  router.post('/:owner/:repo.git/git-receive-pack', gitReceivePack);
}
