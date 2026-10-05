# 08 — The commit error ledger

Every commit whose message admits an error, a gap or an open item, and what has happened to it since.
This is a review of the repository's own history: not a list of things that went wrong, but the list of
things the history says went wrong and the evidence for where each one stands now.

Reconciled against `main` at the commit this file landed on. A closed row names the file or the test
that closes it; an open row names the chunk that will.

| Commit | What it admitted | Status | Where it stands now |
|---|---|---|---|
| `c25b6ed` — Filing the return, chunk 91-C | Acknowledging in the console crashed: the acknowledge response carries no `assessment`/`manifest` and the UI read them anyway (`TypeError: Cannot read properties of undefined`) | **closed** | The type carries those fields as optional and the render guards them; the offline pack had to be re-recorded for it (`src/ui/main.tsx`), and the 91-C commit itself carries the fix |
| `c25b6ed` — Filing the return, chunk 91-C | `POST /api/extracts/issue {event:true}` did not produce a new version, so supersession was unproven over HTTP | **closed** | Supersession now shows in the live route and in the pack: `RI-EX-ALK-CONV-00007` v2 with `supersedes: RI-EX-ALK-CONV-00001` after a later event (`src/core/extracts.ts`, `tools/drill-repro.sh`) |
| `84e4f01` — Fleet claims judged on evidence | Fleet keyword matching over-claimed: titles matched off a file that did not prove them, and `RI-STORE-000892` was claimed without being built | **closed** | Reopened in that commit, corrected in `84e9622`; the fleet judges on evidence in `ledger/runs.jsonl` and `docs/06-QA-REPORT.md` (1211 done / 659 open at the correction) |
| `84e9622` — The registers survive a restart | The drill could say "the restore did not reproduce" without naming a record; a second `buildWorld()` drifted from the first because the id sequences kept counting; a return prepared after a transaction could not be re-proved against books that had already seen it | **closed** | All three fixed in the same chunk: `resetTakafulIds`/`resetBillingIds` (`src/core/takaful.ts`, `src/core/billing.ts`), the replay log names the record and the version claim, and records carry `booksThrough` (`src/core/registerstore.ts`, 18 tests) |
| `d48fed2` — The registers replay their own actions, first pass | Three gaps named in the message: a facultative acceptance was not recorded; a claim recovery's collaborator could not be found on replay; three register methods minted a journal id at call time so a late replay reused an id the books already held | **closed** | Fixed in `17187a3` and `8626c38`: the acceptance is an action, the register is found by name through `ReplayContext`, and a replay uses the recorded journal id (`src/core/actionlog.ts`, `src/core/reinsurance.ts`, `src/core/claims.ts`) |
| `8626c38` — The chart travels with the journals | A replay could arrive at the same totals through different entries; a restore that only compares balances would call that a success | **closed** | The fixpoint compares every journal — id, source, postings, amounts — not the balances (`BooksTimeline.settle()` in `src/core/registerstore.ts`) |
| `c9725ae` — The pack records the drill it can prove | **Open:** re-issuing a return prepared *before* the seeded baseline finished can read journals posted after it, because the drill's target world is seeded rather than empty. One seeded exhibit (`RI-EX-ALK-CONV-00002`) therefore comes back with different content once the console's session has traded | **open** | Named in the commit, reproduced by `tools/drill-repro.sh`, and the pack records the drill on the world it can prove rather than a prettier one. The chunk that closes it: a bare world the timeline builds from nothing — engines with no seeded journals, then books, chart and registers replayed in order |
| `3f19f48` — Repo weight | The repository carried 188 MiB of pack history, almost all of it regenerable media committed on every recording | **closed** | `demo/video` (24 MB) and `demo/screens` (9.3 MB) deleted and ignored; the media purged from all 35 commits; pack file 199 MiB → 10 MiB; the gallery rebuilt with `DEMO_NO_VIDEO=1` at 1.7 MB instead of 4.4 MB |

## How this list is kept

A commit that admits an open item is not a mistake — pretending it does not exist is. Each row above
was verified against the current tree rather than taken from the message: a row is only **closed**
when a file or a test in `main` proves it. When the bare-world chunk lands, its row moves to
**closed** and names the test that does it.
