// The contest's fixed scenario, re-derived from its one seed.
//
// The suite builds every name it sends (the viewer login, repo names, file
// paths, ...) from SCENARIO_SEED with the generators below. The forge needs
// the same derivation for exactly one thing: the identity of the token
// owner (the viewer), so GET /api/v3/user and repository ownership answer
// with the login the suite expects. Everything else the suite sends, the
// forge stores verbatim.
//
// The seed, the word lists and the generator shapes are the contest's fixed
// data, published in the kit; the code below is my own implementation of
// those public algorithms (FNV-1a, splitmix64 finalizer, xorshift64*).

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
const U64_MASK = 0xffffffffffffffffn;
/** 2025-01-01T00:00:00Z. Every timestamp the forge authors is this stamp. */
export const FIXED_EPOCH_SEC = 1_735_689_600;
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
export const DEFAULT_BRANCH = 'main';

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

export function seedForLabel(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: deterministic 64-bit stream, no clock, no Math.random. */
export class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  static forLabel(label: string): Rng {
    return new Rng(seedForLabel(label));
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  chance(p: number): boolean {
    return this.nextU32() / 4_294_967_296 < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** `count` users with unique logins, in scenario order. */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The scenario's viewer: users[0] of the 'users' stream. Cached after first build. */
let cachedViewer: ScenarioUser | null = null;
export function viewerUser(): ScenarioUser {
  if (cachedViewer === null) {
    cachedViewer = generateUsers(Rng.forLabel('users'), 12)[0] as ScenarioUser;
  }
  return cachedViewer;
}

/** All 12 scenario users, in scenario order. Cached after first build. */
let cachedUsers: ScenarioUser[] | null = null;
export function scenarioUsers(): ScenarioUser[] {
  if (cachedUsers === null) {
    cachedUsers = generateUsers(Rng.forLabel('users'), 12);
  }
  return cachedUsers;
}
