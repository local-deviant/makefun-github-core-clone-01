// Git objects and packs, written from scratch for this forge.
//
// The store keeps objects as { type, content } keyed by SHA-1. Packs are read and written
// here, including ofs- and ref-delta resolution. Finding where one zlib stream ends inside
// a pack uses a binary search: Node's inflateSync ignores trailing bytes, so the smallest
// prefix that inflates to the header's expected size is the stream's end.

import { inflateSync, deflateSync } from 'node:zlib';
import { objectId, readPackVarint, sha1 } from './util.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  content: Buffer;
}

const TYPE_BY_CODE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const CODE_BY_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Smallest prefix of buf starting at off that inflates to exactly `size` bytes. */
export function zlibStreamEnd(buf: Buffer, off: number, size: number): number {
  let lo = 0;
  let hi = buf.length - off;
  // A stream can never be longer than the rest of the buffer; binary-search the end.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(buf.subarray(off, off + mid)).length === size;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return off + lo;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  readVar(); // base size
  const resultSize = readVar();
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  const result = Buffer.concat(out, total);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Build a delta that simply inserts the whole target (used when no base is worth reusing). */
export function wholeDelta(baseSize: number, target: Buffer): Buffer {
  const varint = (n: number): Buffer => {
    const bytes: number[] = [];
    do {
      let b = n & 0x7f;
      n >>= 7;
      if (n) b |= 0x80;
      bytes.push(b);
    } while (n);
    return Buffer.from(bytes);
  };
  const head = Buffer.concat([varint(baseSize), varint(target.length)]);
  const chunks: Buffer[] = [head];
  let off = 0;
  while (off < target.length) {
    const n = Math.min(127, target.length - off);
    chunks.push(Buffer.from([n]));
    chunks.push(target.subarray(off, off + n));
    off += n;
  }
  return Buffer.concat(chunks);
}

/**
 * Parse a packfile buffer into objects. `resolve` looks up an already-stored object by id
 * (for ref-deltas whose base is outside the pack). Returns the objects in pack order.
 */
export function parsePack(pack: Buffer, resolve: (id: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const objects: GitObject[] = [];
  // Deltas may reference earlier objects in this pack; keep them by offset and by id.
  const byOffset = new Map<number, GitObject>();
  const byId = new Map<string, GitObject>();
  const remember = (start: number, obj: GitObject): void => {
    objects.push(obj);
    byOffset.set(start, obj);
    byId.set(objectId(obj.type, obj.content), obj);
  };
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    let byte = pack[off++];
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = TYPE_BY_CODE[code];
    if (!typeName) throw new Error(`unknown pack object type ${code}`);
    if (code === 6) {
      // ofs-delta: negative offset varint
      let b = pack[off++];
      let neg = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        neg = ((neg + 1) << 7) | (b & 0x7f);
      }
      const baseOff = start - neg;
      const base = byOffset.get(baseOff);
      if (!base) throw new Error('ofs-delta base not in pack');
      const end = zlibStreamEnd(pack, off, size);
      const delta = inflateSync(pack.subarray(off, end));
      const content = applyDelta(base.content, delta);
      const obj: GitObject = { type: base.type, content };
      remember(start, obj);
      off = end;
    } else if (code === 7) {
      const baseId = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = resolve(baseId) ?? byId.get(baseId);
      if (!base) throw new Error('ref-delta base missing');
      const end = zlibStreamEnd(pack, off, size);
      const delta = inflateSync(pack.subarray(off, end));
      const content = applyDelta(base.content, delta);
      const obj: GitObject = { type: base.type, content };
      remember(start, obj);
      off = end;
    } else {
      const end = zlibStreamEnd(pack, off, size);
      const content = inflateSync(pack.subarray(off, end));
      if (content.length !== size) throw new Error('object size mismatch');
      const obj: GitObject = { type: typeName as ObjectType, content };
      remember(start, obj);
      off = end;
    }
  }
  return objects;
}

/** Encode one object into a pack entry (undelted). */
function packEntry(type: ObjectType, content: Buffer): Buffer {
  const code = CODE_BY_TYPE[type];
  const deflated = deflateSync(content, { level: 6 });
  const size = content.length;
  // Header varint: low 4 bits of size in the first byte, then 7 bits per byte.
  const head: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest) first |= 0x80;
  head.push(first);
  while (rest) {
    let b = rest & 0x7f;
    rest >>= 7;
    if (rest) b |= 0x80;
    head.push(b);
  }
  return Buffer.concat([Buffer.from(head), deflated]);
}

/**
 * Write a packfile (v2) of the given objects, in the order supplied. Objects are stored
 * undelted: correct and fast for the small objects this forge serves, and the delta path
 * is exercised on the read side (client pushes may carry deltas).
 */
export function writePack(objects: GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const entries = objects.map((o) => packEntry(o.type, o.content));
  const body = Buffer.concat(entries);
  const headAndBody = Buffer.concat([head, body]);
  const trailer = Buffer.from(sha1(headAndBody), 'hex');
  return Buffer.concat([headAndBody, trailer]);
}

// ---------------------------------------------------------------------------
// Tree and commit parsing (with a small cache kept by the caller)
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  id: string;
}

/** Parse a tree object's entries. */
export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < content.length) {
    const sp = content.indexOf(0x20, off);
    const nul = content.indexOf(0x00, sp);
    const mode = content.subarray(off, sp).toString('ascii');
    const name = content.subarray(sp + 1, nul).toString('utf8');
    const id = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, id });
    off = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(content: Buffer): CommitInfo {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a tree object from sorted entries. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.id, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Sort tree entries the way git does: by name, directories as if suffixed with '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** Build a commit object. */
export function buildCommit(tree: string, parents: string[], message: string, author: string, committer: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}
