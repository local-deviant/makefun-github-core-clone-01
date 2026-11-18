// Git objects, pkt-line framing and packfiles — my own implementation of the
// public git formats (object ids, tree/commit/tag bytes, pack v2, deltas).
// No git binary is ever invoked; everything is computed on node:crypto and
// node:zlib.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of the loose-object header `type <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function objectIdOf(obj: GitObject): string {
  return hashObject(obj.type, obj.data);
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktEnd = (): Buffer => Buffer.from('0002', 'ascii');

/** Encode lines; 'flush'/'delim' become their control packets. */
export function pktLines(lines: ReadonlyArray<string | 'flush' | 'delim' | 'end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'end') parts.push(pktEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Incremental pkt-line decoder: feed chunks, pull packets. */
export class PktDecoder {
  #buf = Buffer.alloc(0);
  push(chunk: Uint8Array): void {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, Buffer.from(chunk)]) : Buffer.from(chunk);
  }
  next(): Packet | null {
    if (this.#buf.length < 4) return null;
    const head = this.#buf.subarray(0, 4).toString('ascii');
    if (head === '0000') {
      this.#buf = this.#buf.subarray(4);
      return { kind: 'flush' };
    }
    if (head === '0001') {
      this.#buf = this.#buf.subarray(4);
      return { kind: 'delim' };
    }
    if (head === '0002') {
      this.#buf = this.#buf.subarray(4);
      return { kind: 'flush' }; // response-end behaves as a flush for our parsing
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    if (this.#buf.length < len) return null;
    const payload = this.#buf.subarray(4, len);
    this.#buf = this.#buf.subarray(len);
    return { kind: 'data', payload: Buffer.from(payload) };
  }
  /** Text lines of the data packets, without trailing newlines. */
  lines(): string[] {
    const out: string[] = [];
    for (;;) {
      const p = this.next();
      if (p === null) break;
      if (p.kind === 'data') out.push(p.payload.toString('utf8').replace(/\n$/, ''));
    }
    return out;
  }
}

// -------------------------------------------------------------------------------------------
// trees, commits, tags
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const space = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buf.length) throw new Error('malformed tree object');
    entries.push({
      mode: buf.subarray(off, space).toString('ascii'),
      name: buf.subarray(space + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build tree bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree');
  return { tree, parents, author, committer, message };
}

export interface BuildCommitOpts {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}

export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

/** Build commit bytes. Timestamp defaults to a fixed constant: never Date.now(). */
export function buildCommit(opts: BuildCommitOpts): Buffer {
  const ts = opts.timestamp ?? 1700000000;
  const who = `${opts.author ?? CONFORMANCE_IDENTITY} ${ts} +0000`;
  const committer = `${opts.committer ?? CONFORMANCE_IDENTITY} ${ts} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(opts: { object: string; type: GitObjectType; tag: string; message: string; tagger?: string; timestamp?: number }): Buffer {
  const ts = opts.timestamp ?? 1700000000;
  const tagger = `${opts.tagger ?? CONFORMANCE_IDENTITY} ${ts} +0000`;
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${tagger}\n\n${opts.message}`,
    'utf8',
  );
}

// -------------------------------------------------------------------------------------------
// deltas and packfiles
// -------------------------------------------------------------------------------------------

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] ?? 0;
  let next = off + 1;
  let shift = 7;
  while (buf[next - 1] !== undefined && (buf[next - 1] as number) & 0x80) {
    value |= (buf[next] ?? 0) << shift;
    shift += 7;
    next += 1;
  }
  return { value, next };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const buf = Buffer.from(delta);
  let off = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const b = buf[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return size;
  };
  const baseSize = readSize();
  const resultSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < buf.length) {
    const op = buf[off] as number;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= (buf[off] as number) << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= (buf[off] as number) << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(Buffer.from(base.subarray(cpOff, cpOff + cpSize)));
      total += cpSize;
    } else if (op !== 0) {
      out.push(buf.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta op 0 is invalid');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/**
 * Inflate the zlib stream starting at `offset` inside `buf` (which ends at the
 * pack trailer). inflateSync throws while truncated and ignores trailing bytes
 * once complete, so success is monotone in the end position: binary-search it.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let lo = offset + 1;
  let hi = buf.length;
  let found: Buffer | null = null;
  let foundEnd = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = zlibInflate(buf.subarray(offset, mid));
      found = data;
      foundEnd = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found === null) throw new Error('zlib stream never completes');
  // Tighten: walk down from foundEnd while inflation still succeeds.
  let end = foundEnd;
  while (end > offset + 1) {
    try {
      zlibInflate(buf.subarray(offset, end - 1));
      end -= 1;
    } catch {
      break;
    }
  }
  return { data: found, next: end };
}

export interface PackEntry {
  offset: number;
  type: GitObjectType;
  data: Buffer;
  oid: string;
  delta: { kind: 'ofs' | 'ref'; baseOid: string } | null;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  entries: PackEntry[];
  deltaCount: number;
}

/** Read a pack v2/v3, resolving ofs- and ref-deltas (ref bases may come from `resolveBase`). */
export function readPack(pack: Uint8Array, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackRead {
  const buf = Buffer.from(pack);
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    // type/size varint: first byte holds type in bits 4-6 and low 4 size bits.
    let byte = buf[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // ofs-delta: negative-offset varint.
      let b = buf[offset] as number;
      offset += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset] as number;
        offset += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOff;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const entries: PackEntry[] = [];
  let deltaCount = 0;

  const resolve = (entry: Raw): GitObject & { oid: string } => {
    if (entry.resolved && entry.oid) return { ...entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let obj: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        obj = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        obj = { type: external.type, data: applyDelta(external.data, entry.data) };
      }
    } else {
      obj = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    const oid = hashObject(obj.type, obj.data);
    entry.resolved = obj;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { ...obj, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset as number)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid as string }
            : null,
    });
  }
  return { objects, entries, deltaCount };
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain objects (no deltas), deflate level 1: size is not scored, wall time is. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const data = Buffer.from(obj.data);
    parts.push(packObjectHeader(obj.type, data.length));
    parts.push(zlibDeflate(data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packChecksumOk(pack: Uint8Array): boolean {
  const buf = Buffer.from(pack);
  if (buf.length < 20) return false;
  const actual = buf.subarray(buf.length - 20).toString('hex');
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  return actual === expected;
}

/** Every object reachable from `roots` (commits, trees, tags; gitlinks skipped). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (isOid(root) && !seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  while (queue.length) {
    const oid = queue.pop() as string;
    const obj = lookup(oid);
    if (!obj) {
      if (options.allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    const visit = (next: string): void => {
      if (isOid(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    };
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      visit(view.tree);
      for (const parent of view.parents) visit(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') visit(entry.oid);
      }
    } else if (obj.type === 'tag') {
      visit(parseTag(obj.data).object);
    }
  }
  return seen;
}
