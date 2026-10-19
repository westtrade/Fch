# Why not plain `fetch`?

`fetch` is a great primitive. It is also a primitive: it gives you exactly one
HTTP exchange and nothing around it. Every real app then rebuilds the same
handful of things on top — and that is where the bugs live.

This page is honest about what `fetch` cannot do, and shows what the same job
looks like in `Fch`.

## 1. `fetch` has no timeout

There is no `timeout` option. `fetch()` waits forever by default. The accepted
workaround is an abort signal:

```js
const controller = new AbortController();
const id = setTimeout(() => controller.abort(), 5000);

try {
  const res = await fetch("/api/slow", { signal: controller.signal });
  return await res.json();
} finally {
  clearTimeout(id); // forget this and you leak a timer per request
}
```

Every call site now carries a timer, a controller, and a `finally` block. Miss
one and a request hangs until the browser or Node gives up.

```ts
const [data] = await new Fch("/api/slow", { timeout: 5000 }).json();
```

The timeout is per attempt, it is cleared correctly, and it does not interfere
with your own `AbortController` if you pass one.

## 2. `fetch` does not retry

Transient failures are normal: a dropped connection, a 503 from a load
balancer, a 429 from a rate limiter. `fetch` returns or throws once and stops.

Hand-rolled retry code usually gets three things wrong:

- it retries `POST`/`PATCH`/`DELETE` and duplicates writes;
- it retries immediately, hammering an already-struggling server;
- it retries an abort the user asked for.

`Fch` ships a retry loop that is correct by default:

```ts
const api = new Fch("https://api.example.com/orders", {
  retries: 3,          // 1 attempt + 3 retries
  retryDelay: 500,     // exponential backoff with ±20% jitter
  maxRetryDelay: 10_000,
  retryOn: (response) => !!response && (response.status === 429 || response.status >= 500),
});
```

- Backoff is exponential (`base * 2^(attempt-1)`) with jitter, so a fleet of
  clients does not retry in lockstep.
- An explicit `abort()` is **never** retried.
- Network errors retry by default; HTTP status codes retry only when you say so
  via `retryOn`, because retrying a `500` on a `POST` is a business decision,
  not a library default.

## 3. `fetch` does not throw on HTTP errors

A `404` or a `500` is a *successful* promise resolution. This is a constant
source of silent failures:

```js
const res = await fetch("/api/user/1");
const user = await res.json(); // 404 page HTML -> SyntaxError, or worse, silent undefined
```

`Fch` keeps `fetch`'s honest behaviour — you get the `Response` and decide — but
makes the strict version one line:

```ts
const [user] = await new Fch("/api/user/1")
  .after((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  })
  .json<User>();
```

> Why not throw by default? Because sometimes a `404` *is* the answer. Libraries
> that throw on non-2xx force you to catch-and-inspect to read an error body,
> which is the same amount of code in the opposite direction. `Fch` gives you
> the explicit switch instead of a policy.

## 4. `fetch` mangles bodies silently

`fetch` accepts `BodyInit` — a string, `Blob`, `FormData`, `URLSearchParams`,
`ArrayBuffer`, `ReadableStream`. Pass it anything else and it does **not** throw.
It stringifies:

```js
// In Chrome, verified:
const r = new Request("/api/houses", { method: "POST", body: { name: "Cottage" } });
await r.text();                    // "[object Object]"
r.headers.get("content-type");     // "text/plain;charset=UTF-8"
```

The same happens with a `<form>` element and with a submit `Event`:

```js
new Request("/api", { method: "POST", body: form }).text();  // "[object HTMLFormElement]"
new Request("/api", { method: "POST", body: event }).text(); // "[object SubmitEvent]"
```

Your server receives the literal string `[object Object]` with a `text/plain`
content type. No error, no warning.

`Fch` converts what you meant:

```ts
api.post("/houses", { name: "Cottage" });          // JSON + Content-Type: application/json
api.post("/houses", form);                          // FormData, boundary left to the browser
api.post("/houses", event);                         // the submit Event itself
api.put("/houses/1", new Blob([png]));              // binary passed through untouched
```

And the form case follows HTML semantics rather than guessing: the form's own
`method` attribute is honoured, the clicked submit button's name/value is
included, disabled and unchecked fields are excluded, and a
`<form method="get">` puts its fields in the query string instead of sending a
body.

## 5. `fetch` gives you strings, not URLs you can edit

Building a query string by hand is where encoding bugs come from:

```js
// Broken: "Tom & Jerry" and "a+b" corrupt the query
const url = `/api/search?q=${query}&tag=${tags.join(",")}`;
const res = await fetch(url);
```

`URL` and `URLSearchParams` solve this — but then you have two objects to keep
in sync, and the URL is rebuilt at every call site.

`Fch` **is** the URL:

```ts
const req = new Fch("https://api.example.com/v1/search");
req.pathname = "/v2/search";                    // standard URL property
req.searchParams.set("q", "Tom & Jerry");       // encoded correctly
req.searchParams.append("tag", "new");
await req.send();                               // one request, exactly that URL
```

`req instanceof URL` is `true`. There is no separate "build then send" step and
no string concatenation to get wrong.

## 6. Duplicate requests are your problem

Two components mount, both need the user profile, both fire. `fetch` sends two
requests. Add a cache and you get staleness bugs instead.

```ts
const req = new Fch("/api/profile", { dedupe: true });
const [a, b] = await Promise.all([req.json(), req.json()]); // one request on the wire
```

For writes, dedupe requires an explicit key, so a `POST` is never collapsed by
accident:

```ts
req.setDedupeKey(() => crypto.randomUUID()); // also sent as Idempotency-Key
```

## What `fetch` still is

Use `fetch` when you need one request, no configuration, and you control both
ends. It is the standard, it is everywhere, and `Fch` calls it internally —
there is no second HTTP stack, no polyfill, no `XMLHttpRequest` fallback.

`Fch` is the layer you would otherwise write yourself, ~6 kB gzipped, with the
edge cases already handled.

## Side by side

| Task | Plain `fetch` | `Fch` |
| --- | --- | --- |
| Timeout | `AbortController` + `setTimeout` + `clearTimeout` | `{ timeout: 5000 }` |
| Retry with backoff | hand-written loop, jitter, abort handling | `{ retries: 3, retryDelay: 500 }` |
| Retry only some statuses | branch inside the loop | `setRetryOn(...)` |
| Throw on 4xx/5xx | `if (!res.ok) throw` at every call site | `.after(...)` once |
| JSON body | `JSON.stringify` + `Content-Type` header | `.setJsonBody(obj)` or `api.post(url, obj)` |
| Form body | `new FormData(form)` + method/query handling | pass the form or the event |
| Query params | `URLSearchParams` kept in sync by hand | `req.searchParams` — it *is* the URL |
| Dedupe concurrent GETs | a `Map` of promises you maintain | `{ dedupe: true }` |
| Cancel in-flight + retries | one controller per request, wired by hand | `req.abort()`, builder stays reusable |
| Typed result | `await res.json() as T` | `await req.json<T>()` |
| Bundle cost | 0 kB | ~6 kB gzipped |
