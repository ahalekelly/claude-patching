# Reference Repositories

## tweakcc (`/tmp/tweakcc`)

Cloned/updated by `node claude-patching.js --setup`.

The [tweakcc](https://github.com/Piebald-AI/tweakcc) project — authoritative CC patching reference.

**Key resources:**
- `src/patches/` — Battle-tested patch patterns
- `src/patches/index.ts` — Helpers: `getReactVar()`, `findChalkVar()`, `findTextComponent()`, `findBoxComponent()`
- `src/patches/thinkingVisibility.ts` — Our visibility patch reference
- `data/prompts/` — Version-specific system prompt data
- `tools/promptExtractor.js` — Extracts prompts from cli.js

Dispatch haiku explorers to pull information from `/tmp/tweakcc` when needed.

## claude-code (`/tmp/claude-code-src`)

Cloned/updated by `node claude-patching.js --setup` (shallow). The official [anthropics/claude-code](https://github.com/anthropics/claude-code) repo — used solely as the source of `CHANGELOG.md` for the `--port` changelog-impact scan (`scan-changelog.js`).

`CHANGELOG.md` was chosen over `feed.xml`: it's plain markdown (`## X.Y.Z` headers + `- ` bullets, trivial to parse) and preserves the backticks around env vars / flags / tool names / settings keys — the exact impact signal the feed strips out.

## Prompt patches

Prompt patches are now self-contained in `patches/<version>/prompt-patches/`. No external repo.

**Regex engine** (`createRegexPatch()` in `patches/2.1.59/patch-prompt-slim.js`):
- `${varName}` placeholders match template literal vars (`${n3}`, `${T3}`) — auto-adapts across versions
- `__NAME__` placeholders match plain identifiers (`kY7`, `aDA`)
- Placeholders become regex capture groups with backreferences in replacements
- Handles unicode encoding for you — see below
- Ternaries inside `${...}` (e.g. `${flag()?'on':''}`) do NOT tokenize as a `${var}` placeholder — the brace content allows only `[a-zA-Z0-9_.$]+` plus an optional `()` call. The surrounding `${...?...:...}` framing must appear literally, but the bare function-name token inside the ternary can still be made resilient by substituting an `__NAME__` placeholder (e.g. `${__FLAG__()?'on':''}`) — the identifier capture group `[a-zA-Z0-9_$]+` will track minifier renames across versions.

**Unicode: write literal characters, never `\uXXXX`.** One rule for both sides of a pair — the engine owns encoding:
- `.find.txt` — the engine tries the literal text first, then an escaped variant, so either form on disk will match.
- `.replace.txt` — `escapeNonAscii()` converts every codepoint >U+007F to `\uXXXX` **unconditionally** before injection. Raw UTF-8 in the bundle is decoded single-byte by CC's module loading and renders as mojibake (`—` → `â` plus two invisible control chars) with no syntax error to catch it.
- Pre-escaped text is left untouched, so older hand-escaped files stay valid — but don't write new ones that way.
- Backstop: `lib/patch-runner.js` fails any `--apply` whose output *gains* non-ASCII characters, reporting the char, codepoint, count and a snippet. This covers JS patches too, where escaping is still the author's job (spinner frames, injected symbols).

**Backtick escaping inside JS source.** When a target prompt string sits inside a template literal (delimited by `` ` ``), inner backticks at the source level are escaped as `\``. Inside `${...}` interpolations the context flips back to JS expression mode — backticks inside `"..."` or `'...'` strings within that interpolation stay plain. This matters because `.find.txt` content is matched byte-for-byte against the extracted JS:
- Template-literal bullets like ``- \`old_string\` must…`` → write `\`` in find.txt
- Ternary content like `${$?"… `:` …":"…"}` → write plain backticks
The divergence diagnostic surfaces this immediately — `bundle:` line will show `\`name\`` while `patch:` shows `` `name` ``.

**Baseline tool** (`lib/prompt-baseline.js`):
- Generates concatenated baselines in `patches/<version>/`
- Produces stats (per-patch savings) and version-to-version diffs
- Called automatically by `--init` for new versions
