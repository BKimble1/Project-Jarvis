# Phase 4B — design record

Written before implementation, from a first-hand read of the Phase 4A code rather than from its
documentation. Baseline at the time of writing: **882 tests across 23 files, all passing**, working
tree clean at `71f2f8a`.

## Defects found in the existing code before writing anything

Each was confirmed by executing the code, not by reading it.

### D1 — `normaliseSourceText` destroys line numbers

`src/domain/knowledge-source.ts` ends with `.replace(/\n{4,}/g, '\n\n\n')`, directly under a doc
comment promising _"Line count is preserved exactly … because `lines 40-58` has to still mean lines
40-58 afterwards."_

```
input  'alpha\n\n\n\n\nbravo\ncharlie'   -> 7 lines, line 5 = "bravo"
output 'alpha\n\n\nbravo\ncharlie'        -> 5 lines, line 5 = undefined
```

Every citation into a document containing four or more consecutive blank lines points at the wrong
place. Fixed in 4B: the collapse is removed, and a test asserts line-count identity over inputs
designed to trip it.

### D2 — chunk locators do not contain their own chunk text

`chunkText` re-seeds its buffer with the tail of the previous chunk (the overlap) but then sets
`startLine = index + 1`. From the second chunk onward the reported range excludes the text the chunk
actually begins with:

```
lines 0-6  #0 | chunk starts "line 0 xxx…" | range starts "line 0 xxx…" | contained: true
lines 7-11 #1 | chunk starts "xxxxxxxx…"   | range starts "line 7 xxx…" | contained: FALSE
lines 12-16 #2 | …                                                       | contained: FALSE
```

"Open this citation" would highlight the wrong region for every chunk but the first. Superseded in
4B by a chunker that carries an explicit `contentStartLine`/`contentEndLine` for the whole chunk
including overlap, with a test that asserts the claimed range contains the chunk text.

### D3 — `--radius-control` does not exist

Five controls in `src/components/operations/qualification-panel.tsx` (my own 4A work) use
`rounded-[var(--radius-control)]`. `globals.css` defines only `--radius-card`, so those controls
rendered square. Fixed.

## Decisions

### Vector storage without a database extension

**Decision.** Embeddings are stored as `real[]` holding **unit-normalised** vectors, and similarity
is exact dot product computed in SQL via `unnest(embedding, $query)`. No `pgvector`, no ANN index.

Verified working on PGlite: a scope-filtered, scored query returned correct cosine values, and the
scope predicate was evaluated before scoring. This keeps every driver (neon, pg, pglite) on one code
path with no extension to install, which matters more for a single-user system than sub-linear
search does. Recorded as a performance limit in the handoff.

**The trap this design has, and the guard for it.** Postgres `unnest` over two arrays of different
lengths zips to the _longer_ one and pads with NULL, and `sum()` skips NULLs. A 2-dimension query
against a 3-dimension stored vector therefore returns a plausible number rather than an error:

```
mismatch result: [{"s": 0.6000000238418579}]   -- looks like a score, means nothing
```

So every similarity query carries `and dimensions = $dims and array_length(embedding, 1) = $dims`,
dimensions are validated at write time, and a test asserts a mismatched query returns no rows rather
than a wrong score.

### Two lexical channels

**Decision.** Chunks carry two generated tsvectors: `english` (stemmed, for natural language) and
`simple` (unstemmed, for exact identifiers).

Measured, not assumed:

| query                                       | `english` | `simple` |
| ------------------------------------------- | --------- | -------- |
| `E_AUTH_401`                                | matches   | matches  |
| `deploy` (against "deployment", "deployed") | matches   | no match |

`simple` guarantees a literal identifier token survives indexing unstemmed; `english` gives recall
across word forms. Fusion protects exact identifier hits from being buried by semantic scores.

### Revisions are first class

A source is the owner's configured origin. A **revision** is the exact bytes retrieved at one
instant. Citations resolve to a revision, so a refresh cannot silently change the evidence behind an
older answer.

`knowledge_sources.content_hash` currently carries a **global** partial unique index. That index
blocks the entire 4B model twice over: a source cannot have two revisions, and the same public
document cannot exist under two different scopes. Migration 0004 drops it and moves uniqueness to
`(source_id, content_hash)` on revisions. Dropping an index in a new migration is safe for deployed
installations; editing 0003 in place would not be.

Exactly one revision per source may be active, enforced by a partial unique index rather than by
application code, so two concurrent refreshes cannot both activate.

### Scope filtering before ranking

Authorization is a SQL predicate in the same statement that ranks, never a filter applied to
results. The retrieval request has no default that means "everything": a malformed or absent scope
fails closed.

### Prompt injection

Defence is structural, not lexical. Retrieved text is never concatenated into an instruction
position; it is carried in a labelled evidence envelope with its citation, and the contract has no
field through which content could alter scope, tools, permissions or mission state. No regex tries
to detect hostile phrasing — a document may legitimately discuss prompt injection, and an attacker
has infinitely many phrasings.

## Pipeline

```
source → revision → extraction → canonical blocks → chunks → lexical index
                                                          → optional semantic index
                                                          → retrieval result → citation
```

## Schema additions (migration 0004, additive)

| Table                      | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `knowledge_revisions`      | Content-addressed snapshot; one active per source, enforced by a partial unique index.                           |
| `knowledge_blocks`         | Canonical structural extraction: headings, paragraphs, lists, code, page breaks, with location.                  |
| `knowledge_embeddings`     | Unit-normalised `real[]` vectors for chunks and memories, with provider, model, dimensions and indexing version. |
| `knowledge_ingestion_jobs` | Observable, retryable, leasable pipeline work.                                                                   |

Altered: `knowledge_chunks` gains revision, scope, chunker version, stable key, heading path and
location; `knowledge_sources` gains active revision, scope, refreshability and storage metadata.
Dropped: the global unique index on `content_hash`, and the `(source_id, ordinal)` chunk index that
assumed one revision per source.
