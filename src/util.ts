// Small shared helpers: deterministic ids, a seeded PRNG, pkt-line framing and JSON I/O.
// Everything here is written from scratch for this forge.

import { createHash } from 'node:crypto';

/** The epoch every server-created timestamp uses, so stored data never carries wall-clock time. */
export const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_AUTHOR = 'adaiversen <adaiversen@users.noreply.github.com>';

/** SHA-1 of a buffer, hex. Git object ids are SHA-1. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Line counts for a text diff: added lines and removed lines, via longest-common-
 *  subsequence on lines. Small files get the exact LCS; large files fall back to
 *  counting lines that appear in one side only. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const splitLines = (s: string): string[] => {
    if (s === '') return [];
    const parts = s.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 250000) {
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    return {
      additions: newLines.filter((l) => !oldSet.has(l)).length,
      deletions: oldLines.filter((l) => !newSet.has(l)).length,
    };
  }
  // LCS table, one row at a time.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i++) {
    const cur = new Array<number>(newLines.length + 1).fill(0);
    for (let j = 1; j <= newLines.length; j++) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** Stable opaque id: base64 of "Kind:key". */
export function opaqueId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** SplitMix64: a tiny deterministic PRNG. Seed it once from the trial seed. */
export class SplitMix64 {
  private state: bigint;
  constructor(seed: bigint) {
    this.state = seed & 0xffffffffffffffffn;
  }
  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  }
  /** A number in [0, n). */
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

/** FNV-1a 64-bit hash of a string, for stable bucketing. */
export function fnv1a(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

// ---------------------------------------------------------------------------
// pkt-line framing (git wire format)
// ---------------------------------------------------------------------------

/** Encode one pkt-line: 4 hex length chars (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** A flush packet. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** A delim packet. */
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/**
 * Split a buffer of pkt-lines into frames. Each frame is { kind: 'data'|'flush'|'delim', data }.
 * Stops at the first malformed length. `consumed` is how many bytes were read.
 */
export function parsePktLines(buf: Buffer): { frames: Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }>; consumed: number } {
  const frames: Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      frames.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      frames.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    frames.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { frames, consumed: off };
}

/** Read a varint as git packs it (7 bits per byte, high bit set on all but the last). */
export function readPackVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let next = off + 1;
  while (buf[next - 1] & 0x80) {
    value = ((value + 1) << 7) | (buf[next] & 0x7f);
    next += 1;
  }
  return { value, next };
}

/** The git object header: "<type> <size>\0". */
export function objectHeader(type: string, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** The id of a git object from its type and raw content. */
export function objectId(type: string, content: Buffer): string {
  return sha1(Buffer.concat([objectHeader(type, content.length), content]));
}
