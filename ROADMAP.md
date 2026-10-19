# Roadmap & positioning

Three pillars guide the project. Every goal below is stated against a
measurement taken at v1.2.5, so progress is checkable rather than aspirational.

| Pillar | Goal | Status |
| --- | --- | --- |
| **AI-first** | Shortest possible spelling, so an LLM spends fewer tokens | literal entry exists; no LLM-facing docs yet |
| **Human-first** | Obvious API, every common "how do I…" answered | 16 doc pages; cookbook missing |
| **Minimal** | Smallest raw (uncompressed) bundle | 15.6 kB; 3.6× larger than wretch |

## 1. AI-first: token economy

The hypothesis: shorter code means fewer output tokens, and a compact
instruction set means fewer input tokens.

Same task, a `GET` returning JSON, measured in characters:

| Chars | Spelling |
| --- | --- |
| 41 | `` fch`https://a.test/u/1` `` |
| 44 | `ofetch("https://a.test/u/1")` |
| 47 | `ky("https://a.test/u/1").json()` |
| 54 | `new Fch("https://a.test/u/1").json()` |
| 54 | `axios.get("https://a.test/u/1")` → `{ data }` |
| 57 | `wretch("…").get().json()` |
| 69 | `fetch(…)` + `.json()` |
| 150 | `fetch(…)` with timeout (`AbortController` + `setTimeout`) |

The largest win is not the one-liner but query building: the URL *is* the
request object, so params need no string assembly.

```js
// native: 121 chars
const u = new URL("https://a.test/u");
u.searchParams.set("page", "2");
const r = await fetch(u);
const d = await r.json();

// Fch: no URL/request hand-off
const req = new Fch("https://a.test/u");
req.searchParams.set("page", "2");
const [d] = await req.json();
```

**The trap.** Short code saves *output* tokens, but a long manual spends *input*
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
| 1 | `llms.txt` + LLM cheat sheet | Cheap, directly targets AI-first |
| 2 | Measured comparison table | Cheap, serves both pillars |
| 3 | Cookbook (10–15 recipes) | Medium, closes human-first |
| 4 | Entry-point split | Expensive, delivers minimal |
| 5 | Remove deprecated aliases | Breaking; 2.0 only |

## Open questions

- **Token measurement.** Without a way to measure "tokens a model spends
  solving a task with this library", AI-first stays a hypothesis. A proxy
  (characters in the solution + characters of instruction) is possible, but
  then marketing must say it is a proxy.
- **`llms.txt` location.** The standard expects the domain root, but the site
  is served from `/Fch/`. Needs a check on how crawlers resolve it.
- **Compete with wretch on size?** Or accept "more features" instead — the
  latter is honest and does not require dropping dedupe or forms.
