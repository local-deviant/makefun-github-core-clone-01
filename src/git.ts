// Git smart HTTP: upload-pack (v2 and v0) and receive-pack (v0), written from scratch.
// Pkt-line framing, v2 ls-refs/fetch, v0 advertisement, pack building with a depth-bounded
// walk, and receive-pack with per-ref fast-forward enforcement.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PKT_DELIM, PKT_FLUSH, objectId, pktLine, parsePktLines } from './util.ts';
import { parsePack, writePack, type GitObject } from './objects.ts';
import type { Repo } from './store.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

/** Read a whole request body into a buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  sendBuffer(res, status, Buffer.from(text, 'utf8'), contentType);
}

/** All refs of a repo, sorted by name, with HEAD first as a symref line handled by callers. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

function advertiseV2(repo: Repo): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine('# service=git-upload-pack\n'));
  lines.push(PKT_FLUSH);
  lines.push(pktLine('version 2\n'));
  lines.push(pktLine(`agent=${AGENT}\n`));
  lines.push(pktLine('ls-refs=unborn\n'));
  lines.push(pktLine('fetch=shallow wait-for-done\n'));
  lines.push(pktLine('server-option\n'));
  lines.push(pktLine('object-format=sha1\n'));
  lines.push(pktLine('object-info\n'));
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function advertiseV0Upload(repo: Repo): Buffer {
  const out: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta agent=' + AGENT + ' shallow deepen-since deepen-not filter object-format=sha1';
  const refs = sortedRefs(repo);
  const head = repo.ref(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    out.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else if (head) {
    // HEAD first (carrying the capabilities), then every ref including the default branch.
    out.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) out.push(pktLine(`${oid} ${name}\n`));
  } else {
    const [name, oid] = refs[0];
    out.push(pktLine(`${oid} ${name}\0${caps}\n`));
    for (let i = 1; i < refs.length; i++) out.push(pktLine(`${refs[i][1]} ${refs[i][0]}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function advertiseV0Receive(repo: Repo): Buffer {
  const out: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const caps = `report-status side-band-64k delete-refs agent=${AGENT} object-format=sha1`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    out.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    const [name, oid] = refs[0];
    out.push(pktLine(`${oid} ${name}\0${caps}\n`));
    for (let i = 1; i < refs.length; i++) out.push(pktLine(`${refs[i][1]} ${refs[i][0]}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Fetch walk: depth-bounded, stops at haves and shallow boundaries.
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function collectTreeObjects(repo: Repo, treeId: string, out: Map<string, GitObject>, exclude?: Set<string>): void {
  const entries = repo.treeEntries(treeId);
  const treeObj = repo.getObject(treeId);
  if (treeObj && !exclude?.has(treeId)) out.set(treeId, treeObj);
  if (!entries) return;
  for (const e of entries) {
    if (exclude?.has(e.id)) continue;
    const obj = repo.getObject(e.id);
    if (!obj) continue;
    out.set(e.id, obj);
    if (e.mode === '40000') collectTreeObjects(repo, e.id, out, exclude);
  }
}

/**
 * Walk from `wants`, collecting the objects a fetch must send. `haves` are commits the
 * client already holds (their ancestors are not sent). `depth` bounds commit depth
 * (0 = no bound). Returns the objects plus the shallow boundary and unshallow lists.
 */
/** All object ids the client already holds: the haves, their trees and blobs, and — for haves
 *  that are NOT shallow boundaries — their full ancestry. A shallow boundary's ancestors are
 *  NOT held (that is what a deepen fetch is for). */
function collectHaveObjects(repo: Repo, haves: Set<string>, clientShallow: Set<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...haves];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const info = repo.commitInfo(id);
    if (!info) continue;
    out.add(id);
    collectTreeIds(repo, info.tree, out);
    // A shallow boundary's parents are not held: do not walk past it.
    if (clientShallow.has(id)) continue;
    for (const p of info.parents) queue.push(p);
  }
  return out;
}

function collectTreeIds(repo: Repo, treeId: string, out: Set<string>): void {
  const entries = repo.treeEntries(treeId);
  out.add(treeId);
  if (!entries) return;
  for (const e of entries) {
    out.add(e.id);
    if (e.mode === '40000') collectTreeIds(repo, e.id, out);
  }
}

export function planFetch(repo: Repo, wants: string[], haves: Set<string>, depth: number, clientShallow: Set<string>): FetchPlan {
  const out = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const visited = new Set<string>();
  const haveObjects = collectHaveObjects(repo, haves, clientShallow);
  // Queue of [commitId, commitDepth]. Depth 0 = the want itself.
  const queue: Array<[string, number]> = [];
  for (const w of wants) {
    const obj = repo.getObject(w);
    if (!obj) continue;
    if (obj.type === 'commit') queue.push([w, 0]);
    else if (obj.type === 'tag') {
      if (!haveObjects.has(w)) out.set(w, obj);
      const tagText = obj.content.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(tagText);
      if (m) {
        const target = repo.getObject(m[1]);
        if (target?.type === 'commit') queue.push([m[1], 0]);
        else if (target && !haveObjects.has(m[1])) out.set(m[1], target);
      }
    } else if (!haveObjects.has(w)) {
      out.set(w, obj);
    }
  }
  while (queue.length > 0) {
    const [id, d] = queue.shift() as [string, number];
    if (visited.has(id)) continue;
    visited.add(id);
    const info = repo.commitInfo(id);
    if (!info) continue;
    const inHaves = haves.has(id);
    if (!inHaves) {
      const obj = repo.getObject(id);
      if (obj) out.set(id, obj);
      collectTreeObjects(repo, info.tree, out, haveObjects);
    }
    // A have with no depth limit is a hard boundary: the client holds it and its history.
    // A have under a depth limit is a shallow boundary: the client holds the commit but not
    // its ancestors, so the walk continues through it up to the depth limit.
    if (inHaves && depth === 0) continue;
    const atBoundary = depth > 0 && d + 1 >= depth;
    if (atBoundary) {
      // Parents exist but are not traversed: this commit is a shallow boundary.
      if (info.parents.length > 0) shallow.push(id);
      continue;
    }
    for (const p of info.parents) {
      if (!visited.has(p)) queue.push([p, d + 1]);
    }
  }
  for (const s of clientShallow) {
    // A client shallow commit is unshallow when its parents were sent (it is no longer a boundary).
    if (visited.has(s) && !shallow.includes(s)) unshallow.push(s);
  }
  return { objects: [...out.values()], shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Upload-pack v2
// ---------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, opts: { peel: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const out: Buffer[] = [];
  const head = repo.ref(`refs/heads/${repo.defaultBranch}`);
  const refs = sortedRefs(repo);
  const wantRef = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (opts.unborn && wantRef('HEAD')) {
      // The wire format for an unborn HEAD is the literal word "unborn"
      // in place of the oid (not a zero oid with an "unborn" attribute).
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (head && wantRef('HEAD')) out.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    for (const [name, oid] of refs) {
      if (!wantRef(name)) continue;
      let line = `${oid} ${name}`;
      if (opts.peel) {
        const obj = repo.getObject(oid);
        if (obj?.type === 'tag') {
          const m = /^object ([0-9a-f]{40})$/m.exec(obj.content.toString('utf8'));
          if (m) {
            const target = repo.getObject(m[1]);
            if (target?.type === 'commit') line += ` peeled:${m[1]}`;
          }
        }
      }
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function fetchResponse(repo: Repo, plan: FetchPlan, haves: Set<string>): Buffer {
  const parts: Buffer[] = [];
  // Protocol v2 fetch is section-based: an "acknowledgments" section first when the client
  // sent haves (real git requires it), then an optional "shallow-info" section, then the
  // "packfile" section. Each section except the last is closed by a delim.
  if (haves.size > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const h of haves) {
      if (repo.getObject(h)) { parts.push(pktLine(`ACK ${h}\n`)); acked = true; }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  // Packfile data in side-band-64k chunks: each pkt-line carries band 1 + a slice.
  // A pkt-line is at most 65520 bytes total (4-byte length prefix included), so the
  // payload is at most 65516 bytes: 1 band byte + 65515 pack bytes.
  let off = 0;
  while (off < pack.length) {
    const n = Math.min(65515, pack.length - off);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(off, off + n)])));
    off += n;
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPackV2(body: Buffer, repo: Repo): Buffer {
  const { frames } = parsePktLines(body);
  const lines = frames.filter((f) => f.kind === 'data').map((f) => f.data.toString('utf8').trim());
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length) ?? '';
  if (command === 'ls-refs') {
    const peel = lines.includes('peel');
    const unborn = lines.includes('unborn');
    const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));
    return lsRefsResponse(repo, { peel, unborn, prefixes });
  }
  if (command === 'object-info') {
    const out: Buffer[] = [];
    for (const l of lines) {
      if (l.startsWith('size ')) {
        const id = l.slice(5).trim();
        const obj = repo.getObject(id);
        if (obj) out.push(pktLine(`size ${id} ${obj.content.length}\n`));
      }
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves = new Set<string>();
    const clientShallow = new Set<string>();
    let depth = 0;
    for (const l of lines) {
      if (l.startsWith('want ')) wants.push(l.slice(5).trim());
      else if (l.startsWith('have ')) haves.add(l.slice(5).trim());
      else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10) || 0;
      else if (l.startsWith('deepen-since ')) depth = 0; // time-based deepen: treat as full fetch
      else if (l.startsWith('shallow ')) clientShallow.add(l.slice('shallow '.length).trim());
    }
    const key = `${repo.fullName}|${wants.sort().join(',')}|${[...haves].sort().join(',')}|${depth}|${[...clientShallow].sort().join(',')}`;
    const cached = repo.fetchGet(key);
    if (cached) return cached;
    const plan = planFetch(repo, wants, haves, depth, clientShallow);
    const res = fetchResponse(repo, plan, haves);
    repo.fetchPut(key, res);
    return res;
  }
  return PKT_FLUSH;
}

// ---------------------------------------------------------------------------
// Upload-pack v0
// ---------------------------------------------------------------------------

function handleUploadPackV0(body: Buffer, repo: Repo): Buffer {
  const { frames } = parsePktLines(body);
  const lines = frames.filter((f) => f.kind === 'data').map((f) => f.data.toString('utf8').trim());
  const wants: string[] = [];
  const haves = new Set<string>();
  let depth = 0;
  let sideband = false;
  for (const l of lines) {
    if (l.startsWith('want ')) {
      const rest = l.slice(5).trim();
      wants.push(rest.split(' ')[0]);
      if (rest.includes('side-band-64k')) sideband = true;
    } else if (l.startsWith('have ')) haves.add(l.slice(5).trim());
    else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10) || 0;
  }
  const plan = planFetch(repo, wants, haves, depth, new Set());
  const out: Buffer[] = [];
  out.push(pktLine('NAK\n'));
  for (const s of plan.shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) out.push(pktLine(`unshallow ${u}\n`));
  const pack = writePack(plan.objects);
  if (sideband) {
    // Sideband-64k: pkt-lines with a 1-byte channel (1 = pack data), then flush.
    let off = 0;
    while (off < pack.length) {
      const n = Math.min(65515, pack.length - off);
      const chunk = Buffer.concat([Buffer.from([1]), pack.subarray(off, off + n)]);
      out.push(pktLine(chunk));
      off += n;
    }
  } else {
    out.push(pack);
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Receive-pack v0
// ---------------------------------------------------------------------------

function handleReceivePack(body: Buffer, repo: Repo): Buffer {
  const { frames, consumed } = parsePktLines(body);
  const commands: Array<{ oldId: string; newId: string; ref: string }> = [];
  for (const f of frames) {
    if (f.kind === 'flush') break;
    if (f.kind !== 'data') continue;
    // A command line is "<old> <new> <ref>" optionally followed by NUL + capabilities.
    const raw = f.data.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul === -1 ? raw : raw.slice(0, nul)).trim();
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldId: parts[0], newId: parts[1], ref: parts[2] });
  }
  // The packfile follows the command list's flush, as raw bytes.
  const packBytes = body.subarray(consumed);
  let unpackError = '';
  try {
    if (packBytes.length > 0) {
      const objects = parsePack(packBytes, (id) => repo.getObject(id));
      for (const obj of objects) {
        if (!repo.getObject(objectId(obj.type, obj.content))) repo.objects.set(objectId(obj.type, obj.content), obj);
      }
    }
  } catch (err) {
    unpackError = err instanceof Error ? err.message : String(err);
  }
  // The command list's first line may carry capabilities after a NUL
  // (e.g. "report-status side-band-64k agent=git/2.43.0"). When the client
  // asks for side-band-64k, the status report rides on band 2.
  let sideband = false;
  for (const f of frames) {
    if (f.kind !== 'data') continue;
    const nul = f.data.indexOf(0);
    if (nul !== -1 && f.data.subarray(nul + 1).toString('utf8').includes('side-band-64k')) sideband = true;
    break;
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError) {
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newId === ZERO) {
        // Delete.
        if (current === undefined) results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' });
        else if (c.oldId !== ZERO && c.oldId !== current) results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        else {
          repo.deleteRef(c.ref);
          results.push({ ref: c.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObj = repo.getObject(c.newId);
      if (!newObj) {
        results.push({ ref: c.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (c.oldId !== ZERO) {
          results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.setRef(c.ref, c.newId);
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      if (c.oldId !== current) {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (c.newId === current) {
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      if (repo.isAncestor(c.oldId, c.newId)) {
        repo.setRef(c.ref, c.newId);
        results.push({ ref: c.ref, ok: true, reason: '' });
      } else {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  }
  // The report is a run of pkt-lines (unpack, ok/ng per ref, flush) carried
  // as ONE band-1 (primary) sideband chunk, followed by an outer flush —
  // exactly as git's own receive-pack sends it. Band 2 is progress only and
  // the client prints it, never parses it.
  const inner: Buffer[] = [];
  inner.push(pktLine(`unpack ${unpackError ? unpackError : 'ok'}\n`));
  for (const r of results) {
    inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  if (sideband) {
    return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), innerBuf])), PKT_FLUSH]);
  }
  return innerBuf;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Route a git smart-HTTP request. Returns true when handled. */
export async function routeGit(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, subpath: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!repo) {
    sendText(res, 404, 'Not Found\n', 'text/plain; charset=utf-8');
    return true;
  }
  if (method === 'GET' && subpath === '/info/refs') {
    const url = new URL(req.url ?? '/', 'http://x');
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? advertiseV2(repo) : advertiseV0Upload(repo);
      sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, advertiseV0Receive(repo), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendText(res, 404, 'Not Found\n');
    return true;
  }
  if (method === 'POST' && subpath === '/git-upload-pack') {
    const body = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const out = v2 ? handleUploadPackV2(body, repo) : handleUploadPackV0(body, repo);
    sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
    return true;
  }
  if (method === 'POST' && subpath === '/git-receive-pack') {
    const body = await readBody(req);
    const out = handleReceivePack(body, repo);
    sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
    return true;
  }
  return false;
}
