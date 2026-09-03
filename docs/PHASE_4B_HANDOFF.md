# Phase 4B — handoff

What was built, what is actually proved, and what 4C should and should not assume.

Read `docs/PHASE_4B_PLAN.md` first for the design record and the three defects found in existing
code before any 4B code was written. This document is about the finished state.

---

## The one thing 4C needs to know

**Retrieval is reached through `RetrievalService.retrieve()` and nothing else.** It takes a
`RetrievalRequest`, returns bounded `Evidence`, and there is no other supported way to read
knowledge. 4C should not import a knowledge repository, should not write SQL against
`knowledge_chunks`, and should not construct a `ScopeFilter` by object literal — the type is
branded so that last one is a compile error rather than a convention.

```ts
const result = await services.retrieval.retrieve({
  query,
  scope: buildScopeFilter({ audience: 'owner', scopes: ['global', 'project'], projectIds }),
  purpose: 'answer',
  limit: 12,
  charBudget: 12_000,
  sourceKinds: null,
  includeMemories: true,
  includeSources: true,
  asOf: null,
});
```

`RETRIEVAL_API_VERSION` is `1.0.0` and `RANKING_VERSION` is `1.0.0`. Both appear in every
response's diagnostics, so an ordering can be reproduced later or explained as a version change.

### Authorization happens before ranking, in SQL

`buildScopeFilter` is the only producer of a `ScopeFilter`, and it fails closed on five rules
(R-SC1..R-SC5) — an empty scope set, a project scope with no project ids, a non-uuid project id,
a mission scope with no mission, and a requested sensitivity above what the audience may ever see.
The repository turns the filter into a predicate **inside the same statement that ranks**.

Nothing retrieves broadly and discards afterwards. That distinction matters beyond tidiness: a
slow-query log, a cache or an error sample would otherwise hold rows the caller was never allowed
to see.

The audience ceilings are fixed in code and cannot be raised by any request field:

| audience | may see up to |
|----------|---------------|
| `owner`  | private |
| `system` | private |
| `agent`  | internal |
| `display`| public |

### Retrieved text is evidence, never authority

`Evidence` carries content in a field named as quoted material. There is no field through which a
document could grant a tool, change a scope, approve anything or alter a budget — not because such
fields are filtered but because they do not exist. `assertEvidenceIsInert` checks the shape on
every result; it checks *keys*, never content.

There is deliberately no regex hunting for hostile phrasing. A document may legitimately discuss
prompt injection, and an attacker has unlimited ways to rephrase. What is guaranteed is that the
text never reaches a position where it would be read as an instruction.

---

## Retrieval modes are reported, not assumed

Five distinct observable states. `lexical_only` is a valid configuration, not a degraded one.

| mode | what it means |
|------|---------------|
| `lexical_only` | No embedding provider configured. Text search only, and it says so. |
| `hybrid_ready` | Both channels, and the corpus is essentially fully embedded. |
| `hybrid_degraded` | Both channels, but part of the corpus has no current embedding. |
| `indexing` | Embeddings are still being built. |
| `unavailable` | No ready revision. Nothing is searchable. |

Diagnostics also name the semantic index — provider, model, dimensions and similarity floor —
because `hybrid_ready` alone does not tell a caller whether the second channel is a language model
or a hashing scheme, and those deserve different confidence.

### The measurement that shaped this

The bundled `DeterministicEmbeddingProvider` hashes character trigrams. Measured over 153 pairs of
unrelated real sentences:

| dimensions | mean | p90 | p99 | max |
|------------|------|-----|-----|-----|
| 128 | 0.33 | 0.43 | 0.54 | 0.55 |
| 256 | 0.21 | 0.29 | 0.37 | 0.42 |
| 512 | 0.14 | 0.23 | 0.31 | 0.35 |

Two findings, both now enforced in code:

1. **At 128 dimensions unrelated text scores above genuinely related text.** No threshold
   separates them. The constructor refuses anything below 256 (`DETERMINISTIC_MIN_DIMENSIONS`),
   because a channel that returns confident noise is worse than no channel.
2. **Even at workable widths the distributions overlap in the middle.** A weakly related pair
   scored 0.26 while unrelated pairs reached 0.42. This measures character shape, not meaning.

So `minSimilarity` is `0.45` — set *above the highest observed unrelated similarity* rather than
below the lowest related one. The trade is deliberately asymmetric: a semantic miss costs nothing
because two lexical channels are searching the same corpus, while a semantic false positive costs
a citation that reads exactly like a real one.

**The floor is a property of the provider, not of the SQL.** A model with different geometry
declares a different number and nothing else changes.

### If 4C adds a real embedding provider

Implement `EmbeddingProvider`, including `minSimilarity` measured the same way — do not copy 0.45,
it is specific to trigram hashing. Bump `indexingVersion` whenever vector meaning changes; vectors
from two indexing versions are never compared, and the queries enforce that.

**The dimension predicate is load-bearing.** Postgres `unnest` over unequal-length arrays zips to
the longer one and pads NULL, and `sum()` skips NULLs — so without `e.dimensions = $n` a mismatched
vector returns a plausible score rather than an error. Measured: `0.6` for a deliberately
mismatched query. Both the stored `dimensions` column and `array_length` are checked.

---

## Revisions, and why citations survive a refresh

A **source** is a configured origin. A **revision** is the exact bytes at one instant. Citations
resolve to a revision, never to a source.

Refreshing re-reads the origin, hashes the canonical text, and creates a new revision only if the
content actually changed. A page that re-renders its own timestamp is correctly "unchanged", costs
nothing, and leaves every existing citation current.

**Exactly one revision per source is active, and that is a database guarantee** — a partial unique
index on `(source_id) where is_active`. If two refreshes race, the second one's update violates the
index and its transaction rolls back. A test runs six concurrent refreshes and asserts exactly one
active revision.

Activation is last and atomic. Content is fetched, parsed, chunked and indexed against a *new*
revision while the previous one keeps serving. Consequences:

- A failed refresh leaves the last good revision serving. Nothing goes dark because a page moved.
- A half-indexed revision can never answer a question, because it can never be active.

Embeddings are deliberately outside that guarantee. A revision becomes `ready_lexical` and embeds
afterwards; if the provider is down the source is searchable by text and the mode says so.

`isActive` is on the `KnowledgeRevision` domain type, not only in the database, because a caller
asking which revision is live should read a field rather than infer it from timestamps.

---

## Memory: a proposal cannot approve itself

Origins, and what each may become:

| origin | initial status | rule |
|--------|----------------|------|
| `explicit` (owner typed it) | active | R-KN1 |
| `system` (Jarvis's own records) | active | R-KN2 |
| any non-owner origin, owner-only category | suggested | R-KN3 |
| `imported` definition from an owner-supplied source | active | R-KN4 |
| everything else | suggested | R-KN5 |

R-KN4 is the only auto-accept for a non-owner origin and is deliberately narrow: a definition
restates vocabulary rather than asserting project state, and the owner chose the document.
`sourceOwnerSupplied` is derived from the source row — a proposer cannot assert it about itself.

Approval authority is separate from status (`canDecide`):

- **R-KA1** — only the owner decides. There is no trusted-service tier.
- **R-KA2** — the proposer may not approve, checked on actor *identity*. This still refuses if an
  actor kind is ever forged or an agent is run under owner identity by some later code path.
- **R-KA3** — a decision needs something to decide; a silent no-op reads as success.

`MemoryService.propose()` is the only path for non-owner origins and `remember()` is the only path
for `explicit`. Neither takes an origin field, so nothing can dress a model's output as the
owner's words by passing a parameter.

### Forgetting destroys, and is not best effort

`forget()` requires the exact phrase `forget this permanently`, then:

1. deletes every embedding of the item, so the vector index cannot answer from it;
2. clears statement, detail, excerpts, tags and source reference — the generated search vector is
   built from those columns, so the full-text index follows without a second write;
3. writes a deletion receipt naming *where* content was removed from, never what it said;
4. writes a hash-chained audit event describing the act, with classification and counts only.

The audit payload deliberately excludes the statement, because forgetting cannot rewrite a
hash-chained log without breaking the chain — so anything put in the log survives forever.

A test forgets a canary string and then searches for it across the row, the generated search
vector, the embeddings table, a raw scan of every text column, the entire audit trail and the
full export. Another test runs the indexing pass afterwards and asserts no tombstone is re-embedded.

Conflicts are raised and never settled. `keep_both` is a first-class answer. Nothing is deleted by
any resolution; the losing side is retired and its words remain readable.

---

## Ingestion safety

### Uploads

The kind is **derived, never taken from the caller**. Three checks, each stronger than the last:

1. `resolveUploadKind` compares declared content type against extension and refuses when they
   disagree — a `.pdf` sent as `text/plain` is a mistake or an attempt, and refused either way.
2. Anything neither recognises is refused rather than guessed at.
3. The parsers check the bytes themselves. `assertNotBinary` refuses fifteen signatures (PDF, ZIP,
   gzip, ELF, MZ, Mach-O, class, PNG, JPEG, GIF, RAR, 7z, XZ, SQLite) when a file claims to be
   text. This is what stops "rename it to .md" from storing arbitrary bytes as searchable prose.

Nothing unpacks archives. No client-supplied storage path exists — location is decided server-side.
Filenames pass through `safeFilename` before reaching storage or provenance.

A refused upload leaves a source row in `failed` state with its reason, deliberately: an upload
that vanishes without trace is worse than one that says why. It leaves no content, no chunks and
nothing searchable.

`ParseError` is a `JarvisError` mapping to 422 (or 504 for `timeout`), because every reason in
`ParseFailureCode` is a fact about the file rather than a server fault. Its parse-specific code is
`parseCode`; `code` is the HTTP taxonomy.

### URL imports

`assertFetchableUrl` and `SafeUrlFetcher` are the SSRF boundary. HTTP/HTTPS only; embedded
credentials rejected; every DNS answer inspected against blocked CIDRs (loopback, link-local,
private, metadata, and their IPv6 and IPv4-mapped forms); DNS pinned via Node's `lookup` option so
the rebinding window is closed; **every redirect destination re-validated**; redirects, bytes and
time all capped. No application cookies or authorization headers are ever forwarded. The final URL
is recorded as provenance.

IPv4 canonicalisation follows `inet_aton` semantics — decimal, octal, hex and short forms.
Measured divergence worth knowing: `09.1.1.1` is *malformed*, not `9.1.1.1`, because a leading zero
means octal and `9` is not an octal digit. glibc, Node and curl all agree; the implementation
matches them.

The allow-list comes from configuration, never from a request.

### Repository imports

The repository is resolved from the project's own connection. `addRepositoryFileSchema` requires a
`projectId` and has **no owner or repo field** — accepting one would turn "read this project's
docs" into "read anything the token can see". A citation names the commit SHA, never the branch,
because a branch moves and a citation must not.

---

## What the HTTP surface looks like

Every route goes through `ownerRoute`, which authenticates on the server and rejects cross-origin
writes before the handler runs. No route does its own auth check.

| method | path | notes |
|--------|------|-------|
| GET/POST | `/api/knowledge/sources` | List with ingestion state; add note, URL or repository file |
| GET/DELETE | `/api/knowledge/sources/[id]` | Detail with revision history; destructive delete |
| POST | `/api/knowledge/sources/[id]/refresh` | Reports `changed: false` honestly |
| POST | `/api/knowledge/upload` | Multipart only |
| GET/POST | `/api/knowledge/memories` | List with counts; record an explicit memory |
| POST/PATCH | `/api/knowledge/memories/[id]` | Decide (approve/reject/archive/restore/forget); edit |
| GET | `/api/knowledge/memories/[id]/explain` | Why it is remembered, from the record |
| GET | `/api/knowledge/conflicts` | Open disagreements, both sides |
| POST | `/api/knowledge/conflicts/[id]` | Answer one |
| POST | `/api/knowledge/search` | The retrieval inspector |

A source listing physically cannot carry document text: `toKnowledgeSource` has no `bodyText`
field, and reading a body requires calling `readBody` explicitly.

### Export

Export version is now `4` and includes `knowledge` — memories (excluding forgotten), sources,
revisions, conflicts and deletion receipts. `assertNothingForgotten` refuses to serve an export
containing a forgotten item. That check cannot normally trigger, which is exactly why it is worth
having: it is what fails if some later change starts exporting from a path that predates the
destruction.

---

## What is proved, and how

Automated, all run in the standard suite:

- **Unit** — parsers, chunker, embeddings, retrieval contracts, net guard.
- **Integration against a real migrated PostgreSQL (PGlite)** — the ingestion pipeline, concurrent
  activation, project isolation by canary, memory lifecycle, forgetting across every path.
- **Route tests driving the real shipping handlers** — auth, CSRF, upload rejection, forgetting,
  scope widening.

Non-vacuity was checked by mutation rather than by trusting a green suite. Each of these was
broken deliberately and the corresponding test observed to fail, then restored:

| mutation | tests that failed |
|----------|-------------------|
| `isActive` always true in the mapper | refresh keeps one active revision |
| similarity floor removed (`>= -2`) | unrelated query returns no semantic candidates |
| display ceiling raised to `private` | wallboard never sees private memory |
| project clause replaced with `or true` | the four isolation tests |
| chunk overlap reverted to character slicing | four containment assertions |

Two assertions were found vacuous during this phase and replaced rather than made to compile: a
filter on `isActive` before that field existed (always empty, so it passed regardless), and a
search-audience test that only asserted a 200.

---

## What 4C must not assume

- **Do not treat `hybrid_ready` as "semantic search works well".** With the bundled provider it
  means trigram similarity above 0.45. Read `diagnostics.semanticIndex` and say what actually ran.
- **Do not construct a `ScopeFilter` by hand.** The brand makes it a compile error; that is the
  intent, not an obstacle.
- **Do not put retrieved text anywhere it could be read as instruction.** `renderEvidenceForPrompt`
  fences it and labels it as data. Use it.
- **Do not create memories from conversation automatically.** Every non-owner origin is a
  suggestion, and the review queue is the feature rather than friction.
- **Do not assume a citation resolves forever.** Deleting a source destroys its revisions. A
  citation should degrade visibly rather than silently pointing at nothing.

## Known limitations, stated plainly

- **The deterministic provider is not semantic understanding.** It finds near-spellings and
  morphological variants that stemming misses. That is genuinely useful and genuinely not meaning.
- **Ingestion is synchronous.** `knowledge_ingestion_jobs` rows exist and are written, and the
  Operations screen reads them, but nothing leases and drains that queue yet — a large PDF blocks
  its request. The table is ready for a worker; the worker is not written.
- **`memoriesNeedingEmbedding` has no scheduled caller.** `embedPending()` exists and is tested;
  nothing runs it on a timer yet.
- **PDF extraction has no OCR.** A scan is correctly reported as `no_text_layer` rather than as an
  empty document, which is honest but is not extraction.
- **Conflict detection is lexical**, a Jaccard overlap of significant words. It is biased toward
  reporting: a harmless pair costs ten seconds to dismiss, a missed contradiction means Jarvis
  confidently states something the owner stopped believing.
