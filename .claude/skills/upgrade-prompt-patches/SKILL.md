---
name: upgrade-prompt-patches
description: Port system prompt patches to a new Claude Code version. Use when CC has updated and --check shows prompt patch failures.
---

# Upgrading Prompt Patches to a New CC Version

## When to Use

The `patch-prompt-slim.js` patch applies find/replace pairs from `patches/<version>/prompt-patches/` to optimize the system prompt. When a new CC version ships, some patches may fail because Anthropic changed the text. This skill guides you through porting and merging.

## Why Most Patches Port Unchanged

The regex engine uses placeholder-based matching:

| Placeholder | Matches | Example |
|-------------|---------|---------|
| `${varName}` | Template literal vars like `${n3}`, `${XYZ}` | Tool references in prompts |
| `__NAME__` | Plain identifiers like `kY7`, `aBC` | Function names in code |

Variable names change every build, but the regex auto-adapts. **You only fix patches where Anthropic changed the actual text content.**

## Patch Ownership

All prompt patches live in `patches/<version>/prompt-patches/` and are fully self-contained. There is no upstream repo — the local set is authoritative.

## Porting Workflow

### Step 1: Assess the Gap

```bash
node claude-patching.js --status           # What CC version is installed?
node lib/prompt-baseline.js --list         # What versions have local patches?
```

Identify: `NEW_VERSION` (installed CC) and the latest local patch set.

### Step 2: Setup and Init

```bash
node claude-patching.js --setup            # Refresh tweakcc reference + workspace
node claude-patching.js --init             # Create index.json + import prompt patches locally
```

`--init` copies the latest local patch set ≤ `NEW_VERSION` into `patches/<NEW_VERSION>/prompt-patches/`. The result is a fresh local patch set ready for verification.

After import, `--init` outputs the patch count and total savings.

### Step 3: Check

```bash
node claude-patching.js --check            # bare (if single install)
node claude-patching.js --bare --check     # or explicit
node claude-patching.js --native --check   # native
```

If all patches pass, the text didn't change — move to **Step 5** (apply).

**Surface the per-patch divergence warnings.** The orchestrator's top-level `--check` summarizes prompt-slim as a single `M/N patches` line and the divergence diagnostics get swallowed in the noise. To get the structured warnings directly, invoke the patch script and filter with `jq`:

```bash
# native
node patches/<NEW_VERSION>/patch-prompt-slim.js --check cli.js.native.original \
  | jq -c 'select(.type=="warning" or .type=="result")'
# bare
node patches/<NEW_VERSION>/patch-prompt-slim.js --check cli.js.bare.original \
  | jq -c 'select(.type=="warning" or .type=="result")'
```

The `result` line shows the running tally (e.g. `prompt-slim (v2.1.162): 65/67 patches, ~34,684 chars saved`); the `warning` entry carries a `details` array with one diverged/chained/not-found diagnostic per failed patch. Use this same invocation iteratively as you fix `.find.txt`/`.replace.txt` pairs — it's the only view that shows the *next* failure after you fix the current one.

### Step 4: Fix Failures

`patch-prompt-slim.js` has **built-in diagnostics** for failures. The `--check` output classifies each skipped patch:

- **`chained (consumed by <patch>)`** — an earlier patch already removed this text. Remove the entry from `patches.json`. No investigation needed.
- **`diverged (N% match, line X/Y)`** — text content changed at a specific point. The output shows both the patch context and bundle context at the divergence. Update `.find.txt` and `.replace.txt`. **Don't trust the `N%`/`line X/Y` numbers or the diagnostic's whitespace rendering for the *exact* divergence point** — its line-diff and context display are coarse and mislead on blank lines. To localize precisely, bisect the longest matching prefix of the `.find.txt` against the bundle using the engine's own `createRegexPatch` (eval it out of `patch-prompt-slim.js`; reimplement `toNativeEscapes` as `s=>s.replace(/[-￿]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))`), binary-searching prefix length and printing ~90 chars around the cut. To check raw whitespace authoritatively, use `node -e` with `indexOf`+`slice`+`JSON.stringify` on the bundle — **never `rg ... | head -1 | od`**, which truncates at the first newline and makes a real blank line (`\n\n`) look like a single `\n`. **Red herring to rule out first:** when the diagnostic anchors on an em-dash or whitespace, the real divergence is often a *hardcoded identifier that renamed* a few chars later — the diagnostic just stopped on the stable text right before it. Before bisecting, eyeball the bundle a few chars past the reported point for a renamed literal token. Two forms recur: a literal-ternary var (`${$?"…":"…"}` where the bare `$` renamed to `t` — fix with a `${__SVAR__?"…":"…"}` placeholder) and a property that dropped (`${__VAR__.name}` → `${__VAR__}`). The `lean-edit` em-dash "divergence" in 2.1.186 was actually `$`→`t` two tokens downstream.
- **`not found`** — no meaningful match from line 1. The section may be removed or heavily rewritten. **This requires judgment**: search the bundle for distinctive phrases from the `.find.txt` to determine if the text was relocated/reworded or truly deleted.

Example output:
```
parallel-calls-duplicate: chained (consumed by task-usage-notes)
doing-tasks-intro: diverged (16% match, line 1/1)
    patch: er will primarily request you perform software engineering tasks. This
    bundle: er will primarily request you to perform software engineering tasks. T
professional-objectivity: not found — Section may be removed or heavily rewritten
```

**Fix the patch files** in `patches/<NEW_VERSION>/prompt-patches/`:

- **Reworded**: Update `.find.txt` to match the new bundle text. Update `.replace.txt` only if it references the changed portion. Preserve all `${varName}` and `__NAME__` placeholders.
- **Removed by Anthropic**: Delete both `.find.txt` and `.replace.txt`, and remove the entry from the `patches` array in `patches.json`.
- **Chained casualty**: Just remove the entry from `patches.json`. Optionally delete the patch files.

#### Rebuilding a Heavily-Restructured Patch

When a section's surrounding JS changed shape (not just reworded prose) — vars renamed, an assignment dropped, a clause inserted — don't incrementally patch the old `.find.txt`. **Rebuild it from the exact bundle bytes.** Extract the region with node and author the find from what you see:

```bash
node -e 'const c=require("fs").readFileSync("cli.js.native.original","utf8");
const i=c.indexOf("## When not to use");          // a stable anchor in the section
console.log(JSON.stringify(c.slice(i,i+3000)));'   # JSON.stringify shows \n / \uXXXX / \` verbatim
```

Then write the `.find.txt` as the bundle's own bytes with only the minified vars swapped to placeholders:

- Keep `\uXXXX`, `\n` (literal backslash-n), and escaped backticks `` \` `` **exactly as the bundle has them** — they match byte-for-byte. `toNativeEscapes()` is a no-op on already-escaped sequences, so a find built straight from the slice is the most reliable form. (Literal `—` also works via conversion, but copying the slice removes all guesswork.)
- Replace each minified identifier with a `__NAME__` placeholder in its slot: `${ns}`→`${__TOOLVAR__}` (var form), `if(c){`→`if(__QVAR__){` (bare form). The engine builds an **independent** capture group per occurrence — it does *not* enforce that repeated placeholders match the same identifier (it relies on the bundle being internally consistent), and the `.replace.txt` substitutes each placeholder with its *first* capture group.
- For the `.replace.txt`, reproduce any runtime JS the find consumed (variable assignments, ternaries, gating) faithfully — only trim the human-readable prose. The replacement is executable code; a dropped `let`/`return` or an unbalanced template-literal backtick breaks the bundle. `--apply`'s syntax check catches it, but verify the template-literal boundaries line up before trusting it.

`task-usage-notes` (2.1.186) needed exactly this — the `__XVAR__` assignment vanished, a var was added to the `let`, and `team_name` dropped from three strings. Rebuilding from the slice beat editing the old find.

**Write all fixes in a single Node script** rather than editing files one at a time. Use `fs.writeFileSync` for updates and `fs.unlinkSync` for deletions. Avoid template literals for patch content that contains backticks — use string concatenation or `Array.join('\n')` instead.

Recheck and iterate until all patches apply:
```bash
node claude-patching.js --check   # should show more patches passing now
```

### Step 5: Apply

```bash
node claude-patching.js --apply
```

## Gotchas

### Empty Replacements Break /context

Never leave a `.replace.txt` completely empty. The API requires non-whitespace in text blocks. Use:
```
# .
```
This renders as a harmless orphan heading.

### Hardcoded Identifiers in Replacements

**Scan the `.replace.txt` for any literal minified identifier, not just the `.find.txt`.** A `__NAME__` placeholder becomes a capture group from the NEW bundle, so a replacement that references `__NAME__` always gets the current name. A replacement that *hardcodes* the old name silently binds to the wrong thing. Two flavors:

- **Function name** → `SyntaxError: Identifier 'oldName' has already been declared` (or a redeclaration). The `.replace.txt` must define the function via the placeholder, not the old literal name.
- **Assignment variable** → no error, just dead code. Real case (`work-principles`, 2.1.186): the principles array assignment `K=[…]` renamed to `r=[…]`. The `.find.txt` hardcoded `K=[` (failed `not found`) AND the `.replace.txt` hardcoded `K=[` — which would have declared a fresh, unread `K` while the rest of the bundle read `r`. Fix: placeholder-ize **both** files (`__AVAR__=[`), so the replacement reuses the captured var.

Rule of thumb: every minified token that appears literally in a `.find.txt` (array vars like `K=[`, spread targets like `...$,`, trailing element vars like `,q`) must become a `__NAME__` placeholder, and any of those the `.replace.txt` re-emits must use the same placeholder.

### Chained Patches Can Mask Failures

Patches run in order. If an early patch removes a large block (e.g., `task-usage-notes` strips the entire Task tool usage section), later patches targeting text within that block will report "pattern not found" even though nothing is wrong — the text was already removed.

The built-in diagnostics detect this automatically as `chained (consumed by <patch>)`.

### Native Unicode Escaping

Native (Bun) builds store unicode characters as escape sequences (`\u2014` instead of `—`). The `toNativeEscapes()` function handles this automatically.

**However**: if a `.find.txt` was written specifically for native (already contains literal `\u2019` etc.), then `toNativeEscapes()` is a no-op because there are no unicode characters to convert. This is expected — don't waste time debugging why the "native path" isn't triggering.

### Backticks in Fix Scripts

Patch text often contains JS template literal backticks. If you write a Node fix script using template literals, those backticks cause syntax errors. Use `Array.join('\n')`, string concatenation, or `fs.readFileSync` + `.replace()` on the existing file instead.

### Cross-Delimiter String Merges

Some patches merge adjacent array elements by removing the boundary between them (e.g., removing `",'` that separates two strings). **This is dangerous when the elements use different quote delimiters.** If the first string uses `"` and the second uses `'`, merging them produces a `"`-delimited string containing unescaped `"` characters from the second string's content:

```js
// Original: two separate elements, different delimiters
"When referencing code locations.",'Do not use "Let me read"...'
//                                 ^^^ safe — inside single quotes

// BAD replacement: removes boundary, merges into double-quoted string
"Do not use "Let me read"...'
//           ^ JS parser sees this as end of string → SyntaxError

// GOOD replacement: close first string, preserve second string's delimiter
",'Do not use "Let me read"...'
// Creates empty "" element, keeps inner " safe in single quotes
```

**Detection:** Bun reports `TypeError: Expected CommonJS module to have a function wrapper` — misleading, but always means a JS syntax error. Run `node --check <extracted-js>` to find the actual error location.

**Prevention:** When a patch spans a `",'` or `','` boundary, verify the replacement preserves or correctly transitions between delimiters. An empty string element (`""`) in an array is harmless when the array is joined.

## Debugging Runtime Crashes

If patches apply but Claude crashes or shows `[object Object]`:

1. The replacement text has a stale variable reference
2. Use bisect: comment out patches in `patches.json`, binary search for the culprit
3. Check for `[object Object]` — means a variable resolved to the wrong type
4. Check for empty text blocks — means a replacement produced whitespace-only content
