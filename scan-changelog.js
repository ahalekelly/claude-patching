#!/usr/bin/env node
/**
 * scan-changelog.js — Correlate the CC CHANGELOG against our patch set.
 *
 * Sibling to scan-feature-flags.js / scan-env-vars.js. Serves two needs:
 *
 *   1. WHAT CHANGED between two versions — parses anthropics/claude-code's
 *      CHANGELOG.md (## X.Y.Z headers + `- ` bullets) and selects the entries
 *      in the range (from, to].
 *
 *   2. WHAT MIGHT BREAK — for each patch in the target index.json, assembles a
 *      descriptive document (patch id + index.json notes + the patch file's
 *      leading /** *\/ header) and runs a BM25 fuzzy search over the changelog
 *      bullets. Shared *feature* words (thinking, skill, background, table,
 *      compact, …) bridge our prose and Anthropic's release notes; BM25's IDF
 *      down-weights the noise and surfaces the distinctive overlaps. Minified
 *      render-var names (bUD, J4H, Mz) never appear in the changelog, so they
 *      contribute nothing — which is correct.
 *
 * The FTS5/BM25 engine is SQLite's, reached via node:sqlite (Node 22+) or
 * bun:sqlite (Bun) — see openDb(). Neither needs the better-sqlite3 native
 * addon, so this runs under either runtime with no build step and no deps.
 *
 * Usage:
 *   node scan-changelog.js <CHANGELOG.md> --to <ver> [--from <ver>] \
 *        [--index <index.json>] [--broken id1,id2] [--save <out.json>] [--topk N]
 *
 * --from omitted        → only the --to entry is considered.
 * --index omitted       → changelog overview only (no patch correlation).
 * --broken id1,id2      → tag those patch impacts broken:true and sort them first.
 * --topk N              → max changelog matches reported per patch (default 6).
 *
 * Output: NDJSON — one JSON object per line, last line is the summary.
 * The --save artifact is plain JSON (committed under patches/<version>/).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Argument parsing (mirrors scan-env-vars.js)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function consumeArg(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val ?? true;
}

const fromVersion = consumeArg('--from');
const toVersion = consumeArg('--to');
const indexFile = consumeArg('--index');
const brokenArg = consumeArg('--broken');
const saveFile = consumeArg('--save');
const topK = parseInt(consumeArg('--topk') || '6', 10);
const changelogPath = args.find(a => !a.startsWith('--'));

function usage(msg) {
  process.stderr.write(JSON.stringify({ type: 'error', message: msg }) + '\n');
  process.exit(1);
}

if (!changelogPath) usage('Usage: scan-changelog.js <CHANGELOG.md> --to <ver> [--from <ver>] [--index <index.json>] [--broken ids] [--save <out.json>]');
if (!toVersion) usage('--to <version> is required');

const brokenIds = new Set(
  (brokenArg && typeof brokenArg === 'string' ? brokenArg.split(',') : [])
    .map(s => s.trim()).filter(Boolean)
);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// Semver-ish compare (inlined — scanners stay dependency-free)
// ---------------------------------------------------------------------------

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Parse CHANGELOG.md → [{ version, bullets: [] }]  (newest first, as in file)
// ---------------------------------------------------------------------------

let changelogText;
try {
  changelogText = fs.readFileSync(changelogPath, 'utf8');
} catch (err) {
  usage(`Cannot read changelog ${changelogPath}: ${err.message}`);
}

function parseChangelog(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(\d+\.\d+\.\d+)\s*$/);
    if (h) { cur = { version: h[1], bullets: [] }; entries.push(cur); continue; }
    const b = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (b && cur) cur.bullets.push(b[1]);
  }
  return entries;
}

const allEntries = parseChangelog(changelogText);

// Range: version > from (if given) AND version <= to.
const rangeEntries = allEntries.filter(e => {
  if (compareVersions(e.version, toVersion) > 0) return false;
  if (fromVersion && compareVersions(e.version, fromVersion) <= 0) return false;
  if (!fromVersion && compareVersions(e.version, toVersion) !== 0) return false;
  return true;
});

if (rangeEntries.length === 0) {
  usage(`No changelog entries in range ${fromVersion ? fromVersion + ' → ' : ''}${toVersion} (is the changelog current?)`);
}

// Flatten to a corpus of bullets, keeping provenance. rowid = index+1.
const corpus = [];
for (const entry of rangeEntries) {
  for (let i = 0; i < entry.bullets.length; i++) {
    corpus.push({ version: entry.version, bulletIndex: i, bullet: entry.bullets[i] });
  }
}

emit({
  type: 'range',
  fromVersion: fromVersion || null,
  toVersion,
  versionCount: rangeEntries.length,
  bulletCount: corpus.length,
});

for (const entry of rangeEntries) {
  emit({ type: 'changelog_entry', version: entry.version, bullets: entry.bullets });
}

// ---------------------------------------------------------------------------
// SQLite FTS5 backend — node:sqlite or bun:sqlite
// ---------------------------------------------------------------------------

function openDb() {
  if (typeof Bun !== 'undefined') {
    const { Database } = require('bun:sqlite');
    const db = new Database(':memory:');
    db.run('CREATE VIRTUAL TABLE cl USING fts5(body)');
    const insert = db.prepare('INSERT INTO cl(body) VALUES (?)');
    const query = db.query('SELECT rowid AS rowid, bm25(cl) AS score FROM cl WHERE cl MATCH ? ORDER BY score LIMIT ?');
    return {
      insert: (body) => insert.run(body),
      search: (q, k) => query.all(q, k),
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE cl USING fts5(body)');
  const insert = db.prepare('INSERT INTO cl(body) VALUES (?)');
  const query = db.prepare('SELECT rowid AS rowid, bm25(cl) AS score FROM cl WHERE cl MATCH ? ORDER BY score LIMIT ?');
  return {
    insert: (body) => insert.run(body),
    search: (q, k) => query.all(q, k),
  };
}

// ---------------------------------------------------------------------------
// Tokeniser + FTS5 MATCH query builder
//
// Emit a bag of quoted literal tokens OR-joined. Quoting neutralises FTS5
// operators (OR/AND/NOT/NEAR) and punctuation. BM25 does the ranking, so we
// keep all distinctive tokens and let IDF sort the wheat from the chaff.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(('the a an and or but if then else for from into onto with without to of in on at by as is are was were be been being this that these those it its it\'s not no now new old via per not also more most less than when where which who what how why can will would should could may might must have has had do does did done use used using make made get got set run runs ran only just still now already when').split(/\s+/));

function tokenize(s) {
  const seen = new Set();
  const out = [];
  for (const raw of (s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])) {
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function buildMatch(tokens) {
  // Cap to the longest ~100 tokens (proxy for specificity) to keep MATCH sane.
  const capped = tokens.length > 100
    ? [...tokens].sort((a, b) => b.length - a.length).slice(0, 100)
    : tokens;
  return capped.map(t => `"${t}"`).join(' OR ');
}

// ---------------------------------------------------------------------------
// Assemble per-patch descriptive documents from index.json
// ---------------------------------------------------------------------------

function firstBlockComment(src) {
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!m) return '';
  return m[1].replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ').trim();
}

function loadPatchDocs(indexPath) {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const patchesDir = path.dirname(path.dirname(path.resolve(indexPath))); // patches/<ver>/index.json → patches/
  const notes = index.notes || {};
  const docs = [];
  for (const p of (index.patches || [])) {
    const parts = [p.id.replace(/[-_]/g, ' ')];
    if (notes[p.id]) parts.push(notes[p.id]);
    const patchFile = path.join(patchesDir, p.file);
    try {
      parts.push(firstBlockComment(fs.readFileSync(patchFile, 'utf8')));
    } catch { /* patch file missing — id + notes still usable */ }
    docs.push({ id: p.id, text: parts.join('\n') });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Correlate
// ---------------------------------------------------------------------------

let patchImpacts = [];

if (indexFile) {
  const db = openDb();
  for (const row of corpus) db.insert(row.bullet);

  const docs = loadPatchDocs(indexFile);
  for (const doc of docs) {
    const query = buildMatch(tokenize(doc.text));
    let hits = [];
    if (query) {
      try {
        hits = db.search(query, topK);
      } catch (err) {
        // A malformed MATCH shouldn't sink the whole scan.
        emit({ type: 'warning', patch: doc.id, message: `match failed: ${err.message}` });
      }
    }
    const matches = hits.map(h => {
      const c = corpus[h.rowid - 1];
      return { version: c.version, bulletIndex: c.bulletIndex, bullet: c.bullet, score: Number(h.score.toFixed(4)) };
    });
    patchImpacts.push({ id: doc.id, broken: brokenIds.has(doc.id), matches });
  }

  // Broken patches first, then by best (most negative) score.
  patchImpacts.sort((a, b) => {
    if (a.broken !== b.broken) return a.broken ? -1 : 1;
    const sa = a.matches[0]?.score ?? 0;
    const sb = b.matches[0]?.score ?? 0;
    return sa - sb;
  });

  for (const impact of patchImpacts) emit({ type: 'impact', ...impact });
}

// ---------------------------------------------------------------------------
// Save artifact
// ---------------------------------------------------------------------------

const artifact = {
  fromVersion: fromVersion || null,
  toVersion,
  generatedAt: new Date().toISOString(),
  versionCount: rangeEntries.length,
  entryCount: corpus.length,
  changelog: rangeEntries.map(e => ({ version: e.version, bullets: e.bullets })),
  patchImpacts,
  reasoning: {}, // reserved for the LLM/subagent reasoning layer, filled during porting
};

if (saveFile) {
  try {
    fs.writeFileSync(saveFile, JSON.stringify(artifact, null, 2));
    emit({ type: 'saved', file: saveFile, entryCount: corpus.length, patchCount: patchImpacts.length });
  } catch (err) {
    emit({ type: 'error', message: `Cannot write ${saveFile}: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

emit({
  type: 'summary',
  fromVersion: fromVersion || null,
  toVersion,
  versionCount: rangeEntries.length,
  entryCount: corpus.length,
  patchCount: patchImpacts.length,
  brokenCount: patchImpacts.filter(p => p.broken).length,
  matchedPatchCount: patchImpacts.filter(p => p.matches.length > 0).length,
});
