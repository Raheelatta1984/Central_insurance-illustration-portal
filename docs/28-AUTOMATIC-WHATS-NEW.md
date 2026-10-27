# Automatic What's New publication from pull requests

**Status:** implemented · 2026-10-27 · module PLAT (platform services) · risk: low (release
notes and build tooling only; no money, NAV, rating or regulatory calculation is touched).

## 1. Problem and requirement

Every release needed a human to remember three things: add a `WHATS_NEW_SEED` entry, rebuild the
offline demo, and commit both generated files. PR #38 merged without an entry, PR #39 was a
correction, and the What's New tab had to explain that merging a PR did nothing. The requirement
from the product owner: **whenever a PR is created and merged into `main`, update What's New
automatically by default — no manual release-note step.**

## 2. Decision

The PR lifecycle is the publication trigger. One workflow, one generator, two committed files.

| Event | Action on the feed |
| --- | --- |
| PR opened / edited / synchronize / reopened | upsert `WN-PR-<n>` with `stage: 'proposed'`; post/update a sticky PR comment with the drafted note |
| PR merged into `main` (also `push: main` backfill) | upsert same id with `stage: 'shipped'`, `at` = merge date |
| PR closed without merging | remove the proposed entry |

- **Trigger**: `.github/workflows/whats-new.yml` — `pull_request_target` (write-capable token,
  needed to update `main`) + `push` on `main` + `workflow_dispatch` for backfill. `concurrency:
  whats-new-feed` serialises writers; the push step retries with a rebase if `main` moved.
- **Generator**: `tools/whats-new-sync.mjs` reads only the event payload / GitHub REST, calls the
  domain drafter in `src/core/whatsnew.ts` (`draftFromPullRequest`, `upsertPullRequestFeed`,
  `assertPublishableEntry`), and writes `backlog/whats-new-auto.json` (source of truth) plus
  generated `src/core/whatsnew.auto.ts` (what the app imports). `--check` verifies the two files
  agree without a build; CI runs it on every PR.
- **Publication**: `WhatsNewRegistry` loads the generated entries ahead of the curated
  `WHATS_NEW_SEED`. `snapshot()` reports `pending` (proposed) entries; the UI badges them
  "in review — not shipped" and links to the PR. The workflow runs typecheck, lint, full tests,
  `npm run build` (which regenerates the offline demo), `npm run docs:api` and `--check` **before**
  committing `backlog/whats-new-auto.json`, `src/core/whatsnew.auto.ts`,
  `demo/offline.html` and `demo/offline-responses.json` back to `main`.
- **Authorship**: PR title → title/category (via conventional-commit prefixes or labels), body
  sections `## Why`, `## What changed`, `## What you need to do` → why / what / action; missing
  sections use the existing template fallbacks. Re-running for the same PR rewrites its entry, so
  editing a PR body edits its release note. `whats-new:skip` / `[skip whats-new]` excludes internal
  PRs; bot PRs are excluded unless labelled `whats-new:include`. `risk:high` / `risk:low` labels
  override the category-derived risk.
- **Recovery**: `lastMergedAt` in the data file is a watermark. The `push: main` job lists recently
  updated closed PRs, ships any merged after the watermark, and re-checks every proposed entry —
  so a failed run, a fork PR or a missed event self-heals on the next push.
- **Security**: `pull_request_target` is used **only** with a checkout of `main`; no PR code is
  executed with the write token. PR text is untrusted: `plainText()` strips tags, HTML-significant
  characters, markdown and control characters, and bounds every field before it reaches generated
  TypeScript, the offline HTML `<script>` replay payload, the console or the PR comment. PR links
  are restricted to `https://github.com/…`. Drafting is local and template-based — no external AI
  service, no secrets in the generated files.
- **Token**: by default `secrets.GITHUB_TOKEN` with `contents/pull-requests/issues: write` (needs
  repo setting *Settings → Actions → General → Workflow permissions → Read and write*). Because
  pushes made with that token do not re-trigger workflows, the workflow itself runs the full
  verification. Optionally set a `WHATS_NEW_TOKEN` secret (PAT / GitHub App token) to have the
  automatic commit also trigger CI and Pages; an idempotent re-run commits nothing, so there is no
  loop.

## 3. Alternatives considered

| Alternative | Why not |
| --- | --- |
| Keep manual curation, add a reminder checklist | Still depends on a human; the original defect was a forgotten entry. |
| Draft release notes at merge time with an LLM/API call | Network dependency, non-reproducible text, cost, and a PR body is already the authored source of truth. The `draftSections` interface can be swapped for an LLM later without changing the feed. |
| Read the GitHub API at runtime from the server / browser | The deployed offline console has no token or network; release notes would be unavailable exactly in the demo customers open. |
| Publish only on merge | Does not give reviewers a draft while the PR is open, and does not satisfy "whenever you create [a] PR". |
| Write directly to the PR branch from a `pull_request` job | Fails for forks, races with the author's commits, and executes PR code with a write token. |
| GitHub Releases / CHANGELOG.md only | Operators read the console's What's New tab; a separate file would be another manual surface. |

## 4. Honest limitations

- A `proposed` entry describes work **not yet shipped**; the badge and the "In review" action line
  say so. It is a draft, not a promise.
- The generator summarises the PR body; it does not diff code. A PR with no usable body gets
  template fallbacks and a note telling the reader to open the PR.
- Backfill is bounded to the last 300 recently-updated closed PRs and starts at the committed
  watermark; older releases stay in `WHATS_NEW_SEED`. `workflow_dispatch` with a `since` timestamp
  can re-publish an older window.
- Direct commits to `main` with no PR are not announced. Every change in this repository goes
  through a PR.
- The automatic commit is unverified by *branch* CI when the default `GITHUB_TOKEN` is used
  (GitHub does not re-trigger workflows for token pushes); the publishing workflow runs the same
  typecheck, lint, tests, build and artefact checks before pushing.

## 5. Verification

- `npm run whats-new:check` — data file and generated module agree (also a CI step).
- `npm run verify` — typecheck, lint, full test suite with coverage and deterministic build.
- `src/core/whatsnew.test.ts` — PR drafting, sanitisation, category mapping, opt-out labels,
  proposed → shipped transitions, watermark monotonicity, unmerged-close removal, generated-file
  sync, and the recorded endpoints / offline HTML compared with the live registry.
- `src/ui/platform-features.test.ts` — proposed badge, pending counter and PR link render.
- `npm run test:e2e:whats-new` — browser smoke test asserts the automatic-publication notice on
  the assembled static site.
- End to end: open a PR → proposed entry + sticky comment; merge → shipped entry, regenerated
  offline demo and a single bot commit on `main`; close without merging → entry removed.
