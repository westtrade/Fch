# Roadmap & positioning

Three pillars guide the project. Every goal below is stated against a
measurement taken at v1.2.5, so progress is checkable rather than aspirational.

| Pillar | Goal | Status |
| --- | --- | --- |
| **AI-first** | Shortest possible spelling, so an LLM spends fewer tokens | literal entry exists; no LLM-facing docs yet |
| **Human-first** | Obvious API, every common "how do I…" answered | 20 doc pages; cookbook missing; playground covers 1 case |
| **Minimal** | Smallest raw (uncompressed) bundle | 15.6 kB; 3.6× larger than wretch |

## 0. Playground: every case, one page

**Status: nearest task.** Today the landing page has a playground, but it covers
one case: edit a pathname and a query param, press Run, see the request and one
mocked JSON response. That proves the URL *is* the request and nothing else.

The goal is a single page where **every documented behaviour can be exercised
and observed**, so neither a reader nor an LLM has to trust prose. It also
becomes the fixture source for the docs: if a case cannot be demonstrated there,
the claim is not verified.

### What "every case" means

A checklist, not a wish list. Each row is one control group with a visible
effect.

**Requests** — `setMethod`, `setJsonBody`, `setFormData` (element, event and
selector), `appendToFormData`, `setFormUrlEncodedBody`, `setBody` with a
`Blob`/stream for binary, `setHeader`/`setHeaders`/`deleteHeader`,
`setAuthToken`/`setBasicAuth`, `setSearchParams` vs `appendSearchParams`,
`appendFormToQuery`, `setFetchOptions`, `setCORS`, `disableCache`.

**Reading** — `.json<T>()`, `.text()`, `.blob()`, `.send()` returning the raw
`Response`, the `[data, response]` tuple, shortcuts (`fch.get`, `.post`, …) and
the tagged template, all against the same mock so the shapes can be compared.

**Reliability** — retries with a visible attempt counter and backoff timeline;
`retryOn` filtering by status; `timeout` firing (and recovering); `maxRetryDelay`
clamping; dedupe showing one call for N concurrent callers; `abort()` mid-flight
and the builder staying reusable afterwards.

**Interceptors** — `before()` running per attempt (counter) and `after()` running
once, including an `after()` that throws and turns 200 into a rejection.

**Timers** — `delayMs` / `timeoutMs` transitions (`idle → submitting → delayed →
timeout`) driven by an adjustable mock latency, visible as a phase track.

**Plugins** — nanostores (live store panel: `loading`, `data`, `error`, `timer`),
validate (valid and invalid form, valid and invalid response, the formData
default and the JSON skip warning), logger (live log lines at each level),
compat (the deprecated aliases).

**Polling** — `poll()` streaming iterations, with stop-on-abort and a yielded
error visible in the stream.

### Shape

- One page, case list on the left, controls and output on the right.
- Every case states **what to expect** next to what happened, so a mismatch is
  visible without reading docs.
- The mock `fetch` is scriptable per case (status, latency, body, throw) — the
  same knob that makes retries and timeouts demonstrable.
- Runs the real library bundle, as the current playground already does.
- A case is done only when it can be linked with a URL fragment, so docs can
  deep-link `?case=retry-429`.

### Why this is first

- It **verifies** the docs instead of asserting them. Running the documented
  behaviours by hand already exposed three bugs this session (a rejecting
  `onRequest` skipping `onError`, `poll()` dead after `abort()`, the absent
  `Response` on a form failure). A playground makes that routine instead of
  something I must remember to script.
- It gives the cookbook and the LLM cheat sheet a source of truth to generate
  from, rather than prose to keep in sync.
- It is the cheapest way to find behaviours that are documented but unreachable,
  and interactions nobody wrote down.

### Open questions

- **Compose a request into a body (2b).** Worth a feature, or is the explicit
  `await …blob()` enough? The silent `[object Promise]` is a bug either way.

- Does this become a Playwright-verified page (each case asserted) or a manual
  demo? Asserted, ideally: a case that cannot be checked is decoration.
- Reuse the existing `check-interactions` harness, or fold these into it?

## 0b. Docs shaped like svelte.dev: a catalog, one file, and per-section LLM docs

**Status: after the playground.** The reference here is svelte.dev, which
publishes a machine-readable catalog next to the pages instead of keeping the
navigation in a template.

### What Svelte actually ships (measured)

| Artefact | Shape | Size |
| --- | --- | --- |
| `/docs/experimental/sections.json` | 203 entries, key is the path, value `{ metadata: { title }, slug }` | 19.6 kB |
| `/llms.txt` | index of documentation *sets* plus per-package files | 1.7 kB |
| `/llms-full.txt` | every page concatenated | 1.26 MB |
| `/llms-medium.txt` | examples and non-essential content removed | 870 kB |
| `/llms-small.txt` | minimal version | 53 kB |
| `/docs/<pkg>/llms.txt` | that section only, prefixed with `<SYSTEM>…</SYSTEM>` | 481 kB (svelte) |

So the catalog is not decoration: it is the source the navigation *and* the LLM
files are generated from, at three verbosity levels, sliced per package.

### What Fch has

- `llms.txt` (7.2 kB) and `llms-full.txt` (150 kB) — the two extremes, no middle,
  no slicing.
- The page list lives in **three** places that must agree by hand: the `NAV`
  array in `scripts/build-site.mjs`, a second hardcoded list in
  `test/docs.test.ts`, and the files in `docs-src/content/`. Nothing
  machine-readable is published, so an agent cannot discover the pages without
  fetching the HTML.
- No per-section files: to read the plugin docs, an agent takes all 150 kB or has
  to scrape the HTML page.

### TODO

- [ ] Publish `sections.json`: path → `{ metadata: { title, blurb }, slug }`,
      generated from the existing `NAV` so the site nav and the file cannot drift
- [ ] Generate `llms-full.txt` from that catalog instead of a separate page list
- [ ] Add a middle tier (`llms-medium.txt`): every page, code blocks trimmed to
      the first per page — the 150 kB file is beyond most useful context
- [ ] Per-section files at `docs/<slug>/llms.txt`, each as a standalone
      `<SYSTEM>`-prefixed document, so "read the retries docs" costs ~2 kB
- [ ] Teach `llms.txt` to index those sets, the way Svelte's does
- [ ] Collapse the three copies of the page list into the catalog, and make the
      tests read it instead of repeating it — one source, or drift returns

### Why not now

Generating five artefacts from one catalog multiplies the surfaces a single
`NAV` edit has to keep consistent. The playground comes first because it decides
*what* the pages should contain; restructuring the output before settling the
content means generating five slightly wrong things instead of one.

## 1. AI-first: token economy

The hypothesis: shorter code means fewer output tokens, and a compact
instruction set means fewer input tokens.

> **Status: internal only.** This measurement is recorded here and must not be
> published — not on the site, not in `llms.txt`, not in the comparison pages.
> It is not yet in a state worth quoting: the task list is small, the tokenizer
> is one of several (cl100k), and several rows still need a fairer alternative
> implementation. Revisit once the suite is broader and reviewed.
>
> `test/docs.test.ts` fails if a token count or a ROADMAP link reaches the
> published pages.

### Measured with a real tokenizer

Characters are a proxy; tokens are what you pay for. Measured with a BPE
tokenizer (`gpt-tokenizer`, cl100k), counting the code a developer writes for
each task. Reproduce with `node scripts/measure-tokens.mjs`; the numbers are
guarded by its `--check` flag, so this table cannot rot silently.

**Simple tasks — one-liners.** `Fch` is *not* the cheapest here:

| Library | Tokens | vs Fch |
| --- | --- | --- |
| axios | 88 | 3 fewer |
| **Fch** | **91** | — |
| ky | 96 | 5 more |
| ofetch | 102 | 11 more |
| native `fetch` | 140 | 49 more |

**Hard tasks — dedupe, retry, abort with a reusable builder.** Here the others
need a hand-written helper, and the gap is wide:

| Library | Tokens | vs Fch |
| --- | --- | --- |
| **Fch** | **78** | — |
| ky | 144 | 66 more |
| ofetch | 153 | 75 more |
| axios | 157 | 79 more |
| native `fetch` | 229 | 151 more |

Per task:

| Task | Fch | ofetch | ky | axios | native |
| --- | --- | --- | --- | --- | --- |
| GET JSON | 17 | 15 | 16 | 19 | 21 |
| POST JSON | 17 | 26 | 21 | 17 | 39 |
| query params | 26 | 20 | 22 | 20 | 25 |
| timeout | 20 | 17 | 18 | 17 | 32 |
| form submit | 11 | 24 | 19 | 15 | 23 |
| dedupe concurrent GET | 25 | 92 | 90 | 92 | 90 |
| retry with backoff | 26 | 23 | 18 | 27 | 106 |
| abort + reuse builder | 27 | 38 | 36 | 38 | 33 |

The honest headline is **"~70–150 tokens cheaper on tasks with dedupe, retry or
abort; about the same as a one-liner library on simple calls"** — not "the
shortest library". axios wins a bare `GET` by three tokens.

### How to quote this honestly

- Never say "the shortest library": on a bare one-liner axios is smaller.
- Quote the **hard-task** numbers, and say which tasks they are.
- The counts are code the developer writes. Instruction tokens are a separate
  cost, and `llms.txt` exists to keep those small.
- Where a library lacks a feature, the helper the caller must write is counted —
  not a comment placeholder, which would flatter `Fch` for free.
- Re-run `node scripts/measure-tokens.mjs` when the API or the competitors move.

**The trap.****The trap.** Short code saves *output* tokens, but a long manual spends *input*
tokens. Adding more prose to the docs can cost more than the API saves. The
hierarchy must stay shallow:

```
llms.txt (≤200 lines)  →  the one relevant page  →  full reference
```

Do not repeat the same instruction in three places; that costs more than it
saves.

### TODO

- [ ] `llms.txt` and `llms-full.txt` ([llmstxt.org](https://llmstxt.org))
- [ ] A one-screen LLM cheat sheet: every common case, minimal code, under 200 lines
- [ ] Measure token cost on *multi-line* cases (params + retries + JSON body),
      not just one-liners
- [ ] Objective comparison table (characters, not impressions) in `vs-libraries.md`

## 2. Human-first: simplicity and coverage

Current: 16 pages, ~105 KB of prose, 924 lines of code, 845 lines of JSDoc.

Verified gaps (`grep` over `src/`), i.e. problems people search for that the
library does not address:

| Gap | Status |
| --- | --- |
| Upload / download progress | **Deliberately out** — `fetch` needs XHR for this |
| `Retry-After` parsing | Manual retry loop only |
| Pagination helpers | `poll()` is not pagination |
| GraphQL helper | Absent |
| SSE / `EventSource` | Absent; native `EventSource` is the alternative |
| Node-stream upload | `ReadableStream` only |

### TODO

- [ ] **Cookbook**: one recipe per searched problem, phrased as it is googled
      ("fetch timeout", "fetch retry 429", "fetch cancel request",
      "fetch 401 refresh token") → solution → why
- [ ] Decide each gap above: implement it, or document why not
- [ ] Keep the JSDoc at its current standard as the API changes
- [ ] Reduce cognitive load: one obvious way per task. Duplicates today:
      `setRetryTimeout`/`setRetryDelay`, `setIdempotencyKey`/`setDedupeKey`,
      `addRequestInterceptor`/`before`, `fch()`/`new Fch()`, and three call
      styles (builder, `api.get`, literal). Prune the deprecated aliases in 2.0.

**Risk:** three call styles are flexibility *and* load. Every page needs a short
"which one should I use".

## 2b. Idea: a request in a body position

**Status: unscoped. Decide whether this should exist at all.**

The proposal: let a body be another request, so a download can be composed into
an upload without a hand-written `then`.

```ts
// today: explicit, three lines, obvious
const png = await fetch("/chart.png").then((r) => r.blob());
await new Fch("https://api.example.com/uploads")
	.setMethod("POST")
	.setBody(png)            // Content-Type comes from the Blob
	.send();

// proposed: composition
await new Fch("https://api.example.com/uploads")
	.setMethod("POST")
	.setBody(fch`/chart.png`)
	.send();
```

### What I verified before writing this down

- `` setBody(fch`https://…`) `` **does not throw today** — it stores the call
  object, and `fetch` receives a `Promise`, so the wire body is the string
  `[object Promise]`. Silent corruption, not an error. That alone argues for
  either implementing this or rejecting it loudly.
- The example as written (`` fch`/chart.png` `` — a relative path) **throws**:
  `Fch requires an absolute URL`. The literal entry has no `baseUrl` support at
  all, so a composed body would need one first.
- The current `Blob` route works and is documented: the `Content-Type` comes
  from the blob.

### The hard questions

1. **What does it mean?** Two readings, both defensible:
   - *eager*: fetch the inner request to a `Blob`, then send — two round trips,
     simple to reason about;
   - *streaming*: pipe the inner response body into the outer request — one
     pass, no memory spike, but the outer request must not start before the
     inner responds, and Content-Type has to be copied across.
2. **Is it worth the ambiguity?** A promise-typed body is the kind of magic that
   reads well in a tweet and badly in a stack trace. The explicit `await` is one
   line and needs no explanation.
3. **Which entry points?** If `setBody` accepts it, does `setJsonBody`? Does
   `` api.post(url, fch`…`) ``? Consistency argues for all of them or none, and
   "all" is a much larger surface than the one case that motivated the idea.
4. **Failure.** If the inner request fails, is the outer request rejected before
   it is sent? Retries then apply to which request?
5. **`baseUrl`.** Without it the feature only works with absolute URLs, which
   makes the short form less useful than it looks.

### Cheaper alternative

Make the invalid case loud: if `setBody` receives a thenable, throw
`TypeError` explaining that a request is not a body and pointing at
`` fch`…`.json() `` / `await …blob()`. That removes the silent
`[object Promise]` corruption for a few lines, without inventing a feature.

**Recommendation: do the cheaper alternative first.** It fixes a real bug. Then
decide the composition on its merits, with the question "does this remove a line
or only hide one?" answered honestly.

## 3. Minimal: raw size

Minified, raw / gzip:

| Library | Raw | Gzip |
| --- | --- | --- |
| wretch | 4 302 | 1 810 |
| ofetch | 9 527 | 3 881 |
| **Fch** | **15 635** | **5 252** |
| Fch literal entry | 15 984 | 5 432 |
| ky | 30 939 | 10 739 |
| axios | 50 756 | 18 926 |

The literal entry is *not* a duplicate: 1.02× the main bundle, one
`extends URL` (verified), both built from `dist/Fch.js`.

**"Smaller than every competitor, uncompressed" is not reachable** with the
current feature set: wretch is 3.6× smaller, and beating ofetch needs a 39% cut.
Only removing features closes that gap.

### Measured cost of each feature

Removing a member and re-minifying, so these are byte deltas of the real build
(15 657 B baseline), not estimates:

| Feature | Cost |
| --- | --- |
| request execution + retry loop (`executeRequest`) | 2 544 B |
| `clone()` | 1 021 B |
| logger (all 4 levels, adapters, gating) | ~818 B |
| `setFormUrlEncodedBody()` | 233 B |
| `setFormData()` | 403 B |
| `appendToFormData()` | 245 B |
| 7 deprecated aliases | ~191 B |
| `poll()` | 285 B |
| `setFetchOptions()` | 234 B |
| dedupe (key resolution + header) | ~131 B |
| `setBody()` / `isNativeBody` | 179 + 303 B |
| form parsing (`toFormData`/`resolveForm`/`buildFormData`) | 526 B |
| URL validation (`assertAbsolute`) | 440 B |

### Why splitting into plugins does not reach wretch

A "core only" build — every optional member and helper above removed at once —
still measures **11 993 B**, i.e. **2.8× wretch's entire 4 302 B**. The optional
features total only **3 613 B**: even deleting *all* of them leaves a 12 kB
package, because the irreducible part is the retry/timeout/URL machinery the
library exists for.

Plugin splitting is still worth doing — it is a 23% cut for users who want only
the request core — but it cannot deliver "smaller than wretch". Two further
reasons the comparison flatters wretch:

- wretch's retry lives in `wretch/middlewares` and its FormData support in
  `wretch/addons`, so its 4.3 kB is not the same feature set;
- `Fch` parses responses, validates URLs, types bodies and carries a thenable
  builder API, which wretch does not.

Realistic target: **below ofetch (9 527 B)** after the split, and **below
axios/ky** today. Not below wretch.

Weight candidates, in the order the measurements justify:

- everything in the table above that a plugin could carry (~3.6 kB);
- the `combineSignals` fallback (only matters below Node 18, which already
  needs a `fetch` polyfill);
- body copying in `clone()` (5 type branches, accounts for most of its 1 kB).

### TODO

- [ ] Measure each feature's byte cost by building variants
- [ ] Split into entry points beside `literal`: core + `/dedupe` + `/forms` + `/poll`
- [ ] Drop the `combineSignals` fallback
- [ ] Raise the `size-limit` gate (8 kB now, actual 6.24) and keep it in CI

**Honest position:** do not chase "smallest of all"; claim "smaller than
axios/ky with more features". That is true and verifiable.

## Priority

| # | Work | Why |
| --- | --- | --- |
| 1 | **Playground: every case, one page** | Makes the whole API testable without reading docs; feeds every other task |
| 2 | **Docs like svelte.dev: `sections.json`, one file, per-section LLM docs** | Makes the docs machine-readable and sliceable |
| 3 | `llms.txt` + LLM cheat sheet | Cheap, directly targets AI-first |
| 4 | Measured comparison table | Cheap, serves both pillars |
| 5 | Cookbook (10–15 recipes) | Medium, closes human-first |
| 6 | Entry-point split | Expensive, delivers minimal |
| 7 | Remove deprecated aliases | Breaking; 2.0 only |
| — | Reject a thenable body loudly (2b) | Small bug fix; the composition question can wait |

## Open questions

- **Token measurement — measured, not yet publishable.** `scripts/measure-tokens.mjs`
  counts code tokens per task with a real BPE tokenizer (section 1). Still open:
  the suite is small, one tokenizer is used, and instruction tokens are not
  counted at all. Internal until those are answered.
- **`llms.txt` location.** The standard expects the domain root, but the site
  is served from `/Fch/`. Needs a check on how crawlers resolve it.
- **Compete with wretch on size?** Or accept "more features" instead — the
  latter is honest and does not require dropping dedupe or forms.
