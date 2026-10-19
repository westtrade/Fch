# How Fch compares

`Fch` is not the first fetch wrapper, and it will not be the last. Here is an
honest comparison against the libraries you are most likely to evaluate —
including the places where they are the better choice.

## The one-line version

| | `fetch` | **Fch** | axios | ky | ofetch | wretch |
| --- | --- | --- | --- | --- | --- | --- |
| Bundle (gzipped) | 0 | **~6 kB** | ~19 kB | ~10.7 kB | ~3.9 kB | ~1.8 kB |
| Dependencies | 0 | **0** | 4 | 0 | 3 | 0 |
| Request target is a real `URL` | ✗ | **✓ `instanceof URL`** | ✗ | ✗ | ✗ | ✗ |
| Timeout | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ (addon) |
| Retry + backoff | ✗ | ✓ | ✗ (addon) | ✓ | ✓ | ✓ (middleware) |
| Per-status retry policy | ✗ | ✓ | — | ✓ | ✓ (status list) | ✓ |
| Concurrent request dedupe | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `Idempotency-Key` header | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `<form>` / submit event as body | ✗ (sends `[object HTMLFormElement]`) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Throws on 4xx/5xx | ✗ | opt-in | ✓ | ✓ | ✓ | opt-in |
| Request/response hooks | ✗ | ✓ | ✓ interceptors | ✓ hooks | ✓ interceptors | ✓ middleware |
| Abort keeps builder reusable | ✗ | ✓ | — | — | — | — |
| Typed `json<T>()` | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Works in browser / Node / workers | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Sizes are from [bundlephobia](https://bundlephobia.com) for the latest published
versions (axios 1.20.0, ky 2.2.0, ofetch 1.5.1, wretch 3.0.9). `Fch` is measured
from its own `dist/Fch.js` with `esbuild --minify`, then gzipped. Every "✗" above is a
real capability gap, not a stylistic difference — check the docs of each library
if a cell matters to you.

## Where Fch is genuinely different

### The URL and the client are the same object

Every other library in that table asks you to keep two things in sync: the URL
(string, `URL`, or template literal) and the client instance. `Fch` removes the
boundary:

```ts
const req = new Fch("https://api.example.com/v1/items?page=1");

req.pathname = "/v2/items";           // a real URL property
req.searchParams.set("page", "2");    // a real URLSearchParams
req.setHeader("Accept", "application/json"); // ...and it is the request

await req.send();                     // to exactly req.toString()
```

This is not cosmetic. It means URL logic and request logic are one object you
can pass around, clone, log, and mutate — and it is why `Fch` can accept a
relative path with a `baseUrl` while still being a standard `URL` underneath.

No other library in the table does this. `ky` takes a `URL` as input but the
instance is not a URL; `axios` and `ofetch` take strings and build a config
object; `wretch` chains from a URL string.

### Retry policy is one function, not a feature matrix

Most libraries decide for you: "we retry GET on 408/429/500/502/503/504 with N
attempts". That is a reasonable default, and it is also wrong the moment your
API has different semantics.

`Fch` exposes the decision as a predicate that sees both the response and the
error:

```ts
api.setRetryOn((response, error, attempt) => {
  if (response) return response.status === 429 || response.status >= 500;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return attempt < 3;
});
```

One place to reason about retries instead of a config object with a status list
plus a method list plus an "always retry after custom value" caveat.

### Deduplication and idempotency are built in

Not a plugin, not an addon, not a middleware you import:

```ts
const req = new Fch("/api/profile", { dedupe: true });
const [a, b] = await Promise.all([req.json(), req.json()]); // 1 request, 2 readable responses

// Writes need an explicit key — no accidental collapsing of POSTs
api.setDedupeKey(() => crypto.randomUUID()); // also sent as Idempotency-Key
```

Safe methods (`GET`, `HEAD`, `OPTIONS`) dedupe by method + URL. Mutating
methods never dedupe unless you give them a key, and that same key is sent as
`Idempotency-Key` so your server can dedupe too.

### Forms are a first-class body

A browser `<form>` is the most common way to collect data, and no other library
in the table accepts one. `Fch` does, and it follows the HTML spec while doing
it:

```ts
form.onsubmit = (e) => {
  e.preventDefault();
  api.post("/houses", e);        // the event
  api.post("/houses", e.target); // the form
  api.post("/houses", form);     // the element
  api.post("/houses", new FormData(form)); // still fine
};
```

The form's `method` attribute wins over the default, the clicked submit button
is included, file inputs and multi-selects are handled by the native
`FormData` constructor (not a reimplementation), and a `method="get"` form
serialises into the query string with no body — exactly as the browser would.

## Where another library is the better choice

Being honest about this is more useful than a feature table.

- **You need a tiny, focused wrapper and nothing else.** `wretch` at ~1.8 kB
  with a beautiful chainable API is a better fit if you never need dedupe,
  URL-as-object, or form handling.
- **You want the ecosystem.** `axios` has the largest plugin and adapter
  ecosystem, request cancellation helpers, progress events in browsers, and
  battle-tested edge-case handling across exotic runtimes. If you are on
  React Native or need proxy support in Node, axios has an adapter for it.
- **You want Nitro/Nuxt integration.** `ofetch` is the default in the UnJS
  ecosystem and integrates with Nitro's caching and prerendering.
- **You want the smallest possible surface.** `ky` is small, dependency-free,
  and has excellent hook ergonomics plus upload/download progress.

`Fch` is the answer when the *shape* of the request matters: when you want the
URL to be the object, retries and timeouts to be correct by default, and forms
to just work — at roughly the cost of `ofetch` and a third of the cost of `axios`.

## What Fch deliberately does not do

- **No XHR fallback.** It calls the global `fetch`. Node < 18 needs a polyfill;
  that is your choice, not a bundled second stack.
- **No automatic throwing on 4xx/5xx.** You opt in with `.after()`, because
  sometimes a `404` is a legitimate answer.
- **No request progress events.** `fetch` cannot report upload progress without
  a stream `body` and a `ReadableStream` upload; adding it would mean shipping
  an XHR path for everyone.
- **No retry of streamed bodies.** A `ReadableStream` body cannot be replayed,
  so `Fch` throws a clear `TypeError` instead of silently sending a truncated
  request on retry.
