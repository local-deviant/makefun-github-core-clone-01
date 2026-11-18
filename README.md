# makefun-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/local-deviant/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/local-deviant/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library
only. Built from scratch for make.fun's **github-core-clone-01** bounty
("Build a GitHub-compatible git forge", $500).

## What it serves

- **Git smart HTTP** — `/{owner}/{repo}.git`: protocol v2 upload-pack
  (`ls-refs`, `fetch` with shallow/deepen/thin-pack), v0 upload-pack
  advertisement and fetch, v0 receive-pack (push) with report-status and
  sideband-64k. Pack v2 read/write, ofs- and ref-deltas, fast-forward
  enforcement (`non-fast-forward` per ref, mixed pushes apply the ok half).
- **REST v3** — `/api/v3`: root/meta, users, repos, branches, commits, git
  refs, contents (create/update/delete with base64 blobs), labels, issues
  (+ comments, shared number counter with pull requests), pull requests
  (files diff, three-way merge, squash via GraphQL), pagination with
  absolute `Link` headers.
- **GraphQL** — `/api/graphql`: `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issue/pull-request connections with cursor
  pagination, and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations. Batched operation arrays
  answer in order. Unknown fields are HTTP 200 with an `errors` array.
- **MCP** — `/mcp`: JSON-RPC 2.0 streamable HTTP. Modern revision
  `2026-07-28` via `server/discover`, legacy handshake revisions via
  `initialize` + `notifications/initialized`. Six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — all acting on the same
  in-memory store as REST, so ids are stable across surfaces.

## Determinism

The forge keeps all state in memory and never reads the wall clock or an
unseeded random source: server commits use the fixed timestamp
2025-01-01T00:00:00Z, request ids count up from 1, and fetch responses are
sorted by object id. Two runs of the same trial leave byte-identical state.

## Run

```sh
node --experimental-strip-types main.ts
```

Environment: `MAKEFUN_ENV_URL` (register + poll `/done`), `MAKEFUN_SHOP_TOKEN`
(bearer token; empty means the checks run fail-open), `PORT` (optional;
an ephemeral port is bound by default, never 8080).

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit 0.
- `src/app.ts` — HTTP server + route wiring.
- `src/seed.ts` — the deterministic scenario generator (FNV-1a, splitmix64,
  xorshift64*; the viewer identity `adaiversen`).
- `src/git.ts` — git objects, pkt-line, pack v2, deltas.
- `src/store.ts` — in-memory repositories, git-graph operations, merge/diff,
  JSON views.
- `src/http.ts` — router, auth, request ids, pagination.
- `src/githttp.ts` — smart-HTTP git (fetch planning, receive-pack).
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL executor.
- `src/mcp.ts` — MCP endpoint.
- `tests/` — smoke tests (stub environment + real `git` CLI).

---

<sub>Entered on [make.fun](https://make.fun/?ref=njrtxptt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
