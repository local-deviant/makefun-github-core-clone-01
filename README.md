# github-core-clone-01 v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/local-deviant/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/local-deviant/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, GitHub-compatible git forge. One Node process serves git
smart HTTP, the REST v3 API, the GraphQL v4 API and MCP over one in-memory
store — no database, no git binary, no dependencies, no network.

## Run it

```sh
node --experimental-strip-types main.ts
```

Without `MAKEFUN_ENV_URL` it runs in dev mode on an ephemeral port and prints
the port and the dev token (`dev-token`). With `MAKEFUN_ENV_URL` set it binds
an ephemeral port, registers it with the env, polls `/done` and exits 0.

Environment:

- `MAKEFUN_ENV_URL` — the trial env base URL (dev mode when unset).
- `MAKEFUN_SHOP_TOKEN` — the Bearer/Basic token clients must present
  (defaults to `dev-token` in dev mode).

## Layout

```
main.ts            entrypoint: bind, register, poll /done, exit 0
src/app.ts         HTTP wiring: auth, request ids, routing
src/util.ts        SHA-1, ids, seeded PRNG, pkt-line framing
src/objects.ts     git objects, pack v2 read/write, delta apply
src/store.ts       in-memory store: repos, issues, PRs, labels, comments
src/git.ts         smart HTTP: upload-pack v2/v0, receive-pack v0
src/rest.ts        REST v3
src/graphql.ts     GraphQL v4 (hand-rolled parser + executor)
src/mcp.ts         MCP (JSON-RPC 2.0, streamable HTTP)
tests/smoke.mjs    end-to-end smoke test (real git CLI)
```

## API surface

- **Git smart HTTP** — `/{owner}/{repo}.git/info/refs` (v2 + v0
  advertisements), `git-upload-pack` (v2 ls-refs/fetch/object-info,
  v0 fetch), `git-receive-pack` (v0, per-ref fast-forward enforcement,
  non-fast-forward refused). Pack v2 read/write with ofs- and ref-delta,
  delta application, and a binary search for a zlib stream's end.
- **REST v3** — `/api/v3/`: meta, rate limit, user, repos (CRUD, pagination
  with `Link: rel="next"`), branches, commits, git refs/trees/blobs,
  contents (PUT 201/200, stale-sha 409, DELETE), labels, issues + comments,
  pulls (+ files, merge). Auth required everywhere except `/healthz`;
  every reply carries `X-GitHub-Request-Id`; malformed JSON is 400.
- **GraphQL v4** — `/api/graphql`: `viewer`, `repository` (+ issues,
  pullRequests, pullRequest), `createIssue` / `createPullRequest`,
  `__type` / `__schema` introspection, batched documents. Unknown fields
  return HTTP 200 with `errors`; an unknown repo returns
  `data.repository = null` without errors.
- **MCP** — `/mcp`: `server/discover` (protocol versions 2026-07-28,
  2025-11-25, 2025-06-18, 2025-03-26), legacy `initialize`, `tools/list`
  (8 tools, byte-identical on repeat calls), `tools/call`. Missing required
  arguments return `isError: true`; unknown tools return -32601.
  Non-JSON bodies return 400 with -32700; missing auth returns 401.

## Determinism

Every stored timestamp is the fixed epoch 2025-01-01T00:00:00Z. No
wall-clock time, no randomness in responses (request ids are a counter).
The same sequence of requests always produces the same state.

## Tests

```sh
node tests/smoke.mjs
```

Starts the real entrypoint in dev mode and checks REST, GraphQL, MCP and a
real `git` CLI (clone, push, shallow clone, non-fast-forward refusal, tag
push, pull-request merge). 74 checks, all passing.

---

<sub>Entered on [make.fun](https://make.fun/?ref=njrtxptt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
