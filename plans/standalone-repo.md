# Standalone claude-patching

## Goal

Make `ahalekelly/claude-patching` a public, self-contained repo others can use: behavioral-tested patches for the native Claude Code binary plus the non-blocking auto-port. `agent-config` consumes it as a submodule at `~/.agents/claude-patching` — same path, so the zshrc wrapper is untouched — following the `pi-for-claude` / `browser-swarm` pattern.

## Why rewrite instead of vendor

phate45/claude-patching has no license, so its patch code cannot be redistributed in a public repo. The five upstream-derived patches are rewritten as original implementations — house style: content-bearing anchors (never bare control-flow shapes), exact match-count assertions, splice-by-index (never substring replace), loud refusal on drift — with each patch's behavioral test in `tests/` as its spec and gate. phate45 is credited in the README as the project that pioneered the approach; no code carries over. The rewrite is also an engineering upgrade: it retires their `content.replace` first-occurrence idiom and generic-anchor weaknesses (documented in phate45/claude-patching#3) across the whole set.

## Layout

- `patches/` — committed, flat, uniform interface (`node patches/<id>.mjs <unpacked.js>`), eleven patches:
  - Five rewrites: `no-collapse-reads`, `toolsearch-visibility`, `cron-visibility`, `tool-defer-whitelist`, `trim-context-bloat`.
  - The defer pair (split below): `defer-workflow-description`, `defer-artifact-description`.
  - Four existing local patches moved in: `sticky-prompt-header`, `task-reminder-conditional`, `agents-view-shortcut`, `mcp-per-subagent` (mandatory, never droppable).
- `patches-local/<ver>/<id>.mjs` — gitignored machine state: per-version re-anchors written by the background port; same filename wins over `patches/`. `dropped` file semantics unchanged. A re-anchor that proves durable gets promoted into `patches/` with a commit.
- All `repo/`-clone machinery deleted: the index.json/jq resolution, the `git pull` step in `check-and-apply.sh`, the lib symlink, the per-version baseline drift inputs. The patch list is one ordered list at the top of `apply-display-patches.sh`.
- Stamp: hash of `apply-display-patches.sh` + `patches/` + `patches-local/`, expression identical in both scripts.

## Split defer-tool-descriptions into two patches

One patch per tool description: `defer-workflow-description` (Workflow → stub pointing at the `workflow-tool` skill) and `defer-artifact-description` (Artifact → stub pointing at the `artifact-tool` skill), each with its own content hashes and its own suite test. They drift independently — 2.1.224 rewrote the Artifact description (new size cap, new theme contract) while the Workflow text was nearly unchanged — so splitting means one tool's content drift no longer drops the deferral of the other.

## Port-agent drift inputs

Point `port-agent.sh`'s prompt at Piebald-AI/claude-code-system-prompts — per-release Claude Code system prompts, updated within minutes of each release — plus the previous version's unpacked bundle. A better drift input than per-version patch baselines ever were, especially for prompt-anchored patches: `trim-context-bloat` and content refreshes of the two defer patches.

## Upstream watch

Each new version's port also runs the suite against the stock `.orig`, recording every test's result **and failure-reason string**. A test that **passes on stock** is not a verdict, it is a lost-discrimination flag with three possible causes: Anthropic shipped the behavior natively (retire the patch), the assertion drifted vacuous (an unrelated change satisfied it — the test needs strengthening, and until then its pass on the candidate proves nothing, so the gate treats it as suspect), or a flake. The reason strings are the diagnostic for the mirror-image miss too: tests that assert patch artifacts (the mcp canary, the defer stub text) can never pass on stock even when Anthropic fixes the underlying behavior, but their stock failure reasons distinguish "behavior still broken" from "behavior possibly fixed, artifact absent".

After promotion, the port spawns an advisory `claude -p` agent (same sandboxed auto mode and Terminal-window-or-headless launch as tier 2) that:

1. Reviews phate45/claude-patching commits since the SHA recorded in `port-state/phate45-reviewed` (shallow fetch to a temp dir — the vendored clone no longer exists): new patches worth adopting as rewrites, improved anchors, retirements or advisories (the quiet-notifications retirement is the model case).
2. Reads the stock run's per-test reasons plus the version's release notes: classifies any passed-on-stock test as fixed/vacuous/flake, and looks for artifact-asserting tests whose underlying behavior Anthropic has fixed.

It writes recommendations into the port message (printed at the next launch) and the completion notification, updates the reviewed SHA, and never edits patches itself — recommendations only, promotion is already done by the time it runs.

## External-user readiness

- No machine-specifics: audit scripts and tests for `/Users/akelly`, `.agents`, and other local assumptions; everything stays `$ROOT`-relative plus the standard native-install paths.
- `LICENSE`: MIT, Adrian Kelly. `package.json` metadata with the tweakcc dependency.
- README rewritten for an external audience: what it does; requirements (macOS, native Claude Code install, node, jq, python3 with pyte, a logged-in `claude` CLI for the tier-2 port agent); install (clone anywhere, add the wrapper function — snippet included); choosing patches; how the gate and promotion work; credits (phate45 prior art, tweakcc for unpack/repack); operational notes kept (spare-kill session bounce, code-signature-per-inode caveat).

## Phases

1. `git subtree split` the `claude-patching/` directory out of agent-config, preserving its commit history (`repo/`, `node_modules/`, `patches-local/`, `port-state/` are gitignored, so the split is clean). This plan file rides along into the split repo's `plans/`.
2. Restructure and rewrite in the split repo; then merge that history into the fork's existing `master` (`git merge --allow-unrelated-histories`, resolved to the new tree, phate45's patch files removed from HEAD) and push normally. The repo stays a fork: phate45's history remains its base — natural attribution, no force-push. HEAD carries only our code plus the MIT license, which covers our original work.
3. agent-config: remove the tracked directory, `git submodule add` the new repo at the same path, migrate machine state (`patches-local/`, `port-state/`), `npm ci` for tweakcc. Sequence the swap so `check-and-apply.sh` works at every moment (push first, move the old directory aside, trash it only after verification). Push both repos.

## Verification

- Per rewritten patch: applies to 2.1.224, `node --check` passes, each guard refuses correctly on a mutated scratch copy.
- Full gate from the new layout: a real background-port run ends 11 passed / 0 failed / 0 skipped and promotes (promotion bounces daemon-attached sessions — expected).
- Negative control: all 11 tests fail against `2.1.224.orig`.
- Post-swap: `check-and-apply.sh <tmpfile>` takes the silent fast path (exit 0, target = the promoted binary).

## Risks

- Fresh anchors on five rewritten patches — the behavioral suite is the gate; a patch that cannot be cleanly re-derived stays out, with the suite honest about the gap.
- Live-machine swap mid-restructure — mitigated by push-then-swap and keeping the old directory until verified.
