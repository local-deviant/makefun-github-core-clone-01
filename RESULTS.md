# RESULTS — github-core-clone-01 (rebuild orisinal)

Bounty: **github-core-clone-01** — "Build a GitHub-compatible git forge", $500,
tutup 2026-11-21 06:30 UTC. Entry: `~/workspace/makefun/github-core-clone-ours/`
(Node 22, TypeScript stdlib-only, `main.ts`).

## Pendekatan Cervus (referensi, dipelajari prinsipnya saja)

Repo `cervus-snoopy/makefun-github-core-clone`, satu proses Node 22, stdlib
saja, store in-memory, tanpa UI. `main.ts` hanya lifecycle (bind port 0 →
POST `/register` → poll `/done` → exit 0); `app.ts` satu file 115.976 byte
berisi seluruh forge: git object store + smart HTTP, REST v3, GraphQL, MCP.
Git: blob/tree/commit/tag, SHA-1, pack v2, ofs- dan ref-delta, sideband-64k;
`info/refs` mengiklankan upload-pack v2 bila klien kirim `Git-Protocol:
version=2`, receive-pack selalu v0; push menegakkan fast-forward (alasan
penolakan persis `non-fast-forward`). REST: root/meta/user/user-repos, repos,
branches, commits, git refs, contents, labels, issues + comments, PRs
(counter nomor bersama issues/PRs), semua balasan JSON dengan
`X-GitHub-Request-Id` non-kosong. GraphQL: executor kecil (tokenizer +
recursive-descent) untuk dokumen yang dikirim gh dan github-mcp-server,
introspeksi `__type`, array batch. MCP: JSON-RPC 2.0 streamable HTTP,
`server/discover` modern (revisi 2026-07-28) dan handshake legacy
`initialize` + `notifications/initialized`, 6 tools. Determinisme: tanpa
jam dinding di data tersimpan; commit server memakai epoch tetap
2025-01-01T00:00:00Z dan author `ada iversen <adaiversen@example.invalid>`;
id global berupa base64 opaque (`Kind:key`) yang stabil.

Hasil Cervus (BUILD_LOG, 2026-11-15): grade-local run 3 = 930/1000
(feature 600/600, agent 200/200, perf 130/200). Re-grade lokal kami di sesi
ini: **939/1000** (feature 600, agent 200, perf 139).

## Desain kami dan bedanya

Ditulis ulang dari nol dalam modul-modul terpisah (bukan satu file raksasa),
dengan kata-kata dan kode sendiri; hanya prinsip dan format protokol publik
(git, GitHub REST/GraphQL/MCP) yang dipakai ulang:

- `src/seed.ts` — generator skenario deterministik (FNV-1a, splitmix64,
  xorshift64*) yang direplikasi dari kit; viewer terverifikasi persis
  `adaiversen` / `quinnkeller` / `olgabauer`.
- `src/git.ts` — objek git, pkt-line, pack v2, delta. `inflateAt` memakai
  binary search (bukan scan linear) untuk menemukan ujung stream zlib.
- `src/store.ts` — state in-memory + operasi graf git (ancestry,
  merge-base, flatten/build tree, three-way merge, diff baris LCS),
  dan JSON views GitHub.
- `src/githttp.ts` — smart HTTP + **fetch planner sendiri**: walk
  berbatas-kedalaman dari wants yang berhenti di haves / shallow boundary
  klien, sehingga fetch inkremental dan shallow mengirim tepat objek yang
  kurang; cache respons fetch FIFO 128.
- `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts` — tiga permukaan di atas
  store yang sama, sehingga id stabil lintas permukaan.
- Perbedaan perilaku yang disengaja: auth menerima Basic (password = token)
  selain Bearer, dan 401 membawa header `WWW-Authenticate` — tanpa ini git
  CLI sungguhan tidak pernah mengirim kredensial (ia menunggu challenge).
  `main.ts` tetap melayani bila `MAKEFUN_ENV_URL` tidak diset (mode dev).

## Hasil test

### Smoke test sendiri — `node tests/smoke.mjs`: **58/58 lolos**

Stub env + entrypoint asli (`main.ts`), lalu REST (healthz, root, meta,
user, repo CRUD, contents create/update/stale-sha 409, branches, commits,
git refs, labels, issues + comments, PR + files + merge, paginasi Link
rel="next"), GraphQL (viewer, repository fields, introspeksi `__type`,
unknown field → 200 + errors, unknown repo → null tanpa errors,
createIssue, open-issues, batched), MCP (discover, tools/list 6 tools,
create/list issue, unknown tool −32601, missing args isError, non-JSON
→ 400/−32700, tanpa token → 401, legacy initialize), dan **git CLI
sungguhan**: clone, push branch baru, shallow clone depth 1 (1 commit),
penolakan non-fast-forward, push tag, exit 0 setelah `/done`.

### grade-local kit (`--driver process`) — ground truth

| run | trial 0 | trial 1 | trial 2 | rata-rata |
|---|---|---|---|---|
| `--instances 1` | 964 | – | – | 964 |
| `--instances 2` | 972 | 973 | – | 972.5 |
| `--instances 3` | 983 | 976 | 974 | **977.7** |

Semua trial: **feature 600/600, agent 200/200**, replay **matched
byte-for-byte**, live exit 0 dalam 8–9,7 dtk, 0 model calls (kompetisi ini
tidak mewajibkan model call). Interval 90% skor: 969.7–985.6.

Rincian perf (trial 2, poin maks 50/workload): push 40 (p50 727 ms vs
referensi 1.641 ms), clone 41 (108 ms vs 267 ms), read 48 (785 ms vs
2.760 ms), write 45 (112 ms vs 349 ms) — total 174/200. Rata-rata perf
3 trial: 177,7/200.

### Perbandingan dengan Cervus (re-grade lokal, mesin yang sama)

| | Cervus | Kami |
|---|---|---|
| Skor total | 939 | 964–978 |
| Feature / agent | 600 / 200 | 600 / 200 |
| Perf | 139 | 164–183 |
| Replay | cocok | cocok |

## Varian yang dicoba dan ditolak

- Delta pack saat kirim fetch: tidak dipakai — pack polos (deflate level 1)
  lebih cepat dibuat dan lolos `pack-deltas` (cek itu memverifikasi hash,
  bukan mengharuskan delta).
- Mengirim packfile section kosong untuk clone repo kosong: ditolak — cek
  `clone-empty` gagal bila `packBytes > 0`; section dihilangkan bila tidak
  ada objek.
- `shallow-info` pada fetch non-shallow: tidak dikirim — hanya bila
  `deepen` diminta atau klien mengirim boundary shallow.
- Menghitung id request dari `Date.now()`/acak: ditolak — determinisme
  replay menuntut counter naik dari 1.

## Batasan yang tersisa

- Perf tersisa ~22 poin: butuh speedup 2–4× pada push/clone (dominan
  overhead HTTP per-request + round trip advertisement klien). Tidak
  dikejar: risiko merusak kebenaran lebih besar dari nilainya.
- Diuji pada Node v24.22.1 lokal; server grading memakai Node v26.13.1 —
  kode hanya memakai API stabil (node:http/crypto/zlib, fetch).
- Tidak ada test Docker (tidak terpasang di mesin ini); `--driver process`
  adalah plausibility check, bukan verdict grader.
- Transcript gate belum dipenuhi di run dev (`no_transcripts`,
  `coverage_below_gate`) — itu urusan bundle transkrip saat submit,
  bukan skor fungsional entry.

## Penilaian

Entry **siap diajukan untuk submit**: 120/120 cek fungsional lolos di
ketiga trial practice, replay deterministik cocok, skor 964–978/1000
(di atas referensi Cervus 939 dan di atas patokan ~900). Satu-satunya
pekerjaan tersisa ada di sisi submit (transkrip + pengiriman), bukan di
kode entry.
