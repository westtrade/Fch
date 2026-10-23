# Getting started

`Fch` is a tiny HTTP client built on the platform: it **extends the native
`URL` class**, so a single object is both the URL you are building and the
request that targets it. Retries, timeouts, deduplication, interceptors and
typed body helpers come along for the ride.

If you know `fetch` and `URL`, you already know most of `Fch`.

## Install

The package is scoped as `@westtrade/fch`. That matters: the unscoped name
`fch` on npm belongs to an unrelated library, so `npm install fch` would give
you someone else's code.

Install straight from the [GitHub repository](https://github.com/westtrade/Fch),
pinned to a release tag:

```bash
npm install github:westtrade/Fch#v1.15.0
```

Or with any other package manager:

```bash
pnpm add github:westtrade/Fch#v1.15.0
yarn add github:westtrade/Fch#v1.15.0
bun add github:westtrade/Fch#v1.15.0
```

Either way it installs as `@westtrade/fch`, so that is what you import:

```ts
import { Fch } from "@westtrade/fch";
```

Pinning the tag is worth it: without one, npm follows the default branch, which
may contain unreleased changes. To track the latest release instead, drop the
`#v1.15.0` suffix.

The package ships compiled `dist/` output, so a git install builds it for you
via `prepare`. If you vendor the source instead, run `npm install && npm run
build` once.

No configuration, no polyfill, no runtime dependencies. `Fch` calls the global
`fetch` and uses the global `URL`, `Headers`, `FormData`, `AbortController` and
`Response` — everything the platform already gives you.

> **Node:** use Node 18 or newer, where `fetch` is global. On older versions,
> install a `fetch` polyfill first; `Fch` will use whatever `fetch` is global.

## Your first request

The same call, written three ways. Pick one; they share the same class and the
same options.

```tabs
=== class
import { Fch } from "@westtrade/fch";

const [user, response] = await new Fch("https://api.example.com/users/1")
	.setAuthToken("my-token")
	.json<User>();
=== function
import { fch } from "@westtrade/fch";

const api = fch.create({ baseUrl: "https://api.example.com" });

const [user, response] = await api
	.request("/users/1", { headers: { Authorization: "Bearer my-token" } })
	.json<User>();
=== literal
import fch from "@westtrade/fch/literal";

const [user, response] =
	await fch.get`https://api.example.com/users/1`;
```

The **class** is the most explicit and is what the API reference documents. The
**function** form is best when several calls share a base URL and defaults. The
**literal** is the shortest, and is what the rest of these docs use for one-off
requests.

```ts
console.log(user.name);       // the parsed body
console.log(response.status); // 200 — the raw Response is still there
```

`.json<T>()` returns a tuple `[data, response]`. The body is parsed from a
clone, so the `Response` you get back is still readable — you can call
`response.headers.get(...)`, or read it again, without hitting
"Body already used".

## A custom `fetch`

`Fch` calls the global `fetch`, resolved at request time. To supply your own — a
tracing wrapper, a proxy, MSW in tests, or a runtime without a global `fetch` —
pass the `fetch` option:

```tabs
=== class
const req = new Fch("https://api.example.com/x", {
	fetch: (url, init) => fetch(`${proxy}?to=${encodeURIComponent(String(url))}`, init),
});

await req.json();
=== function
const api = fch.create({
	baseUrl: "https://api.example.com",
	fetch: (url, init) => fetch(`${proxy}?to=${encodeURIComponent(String(url))}`, init),
});

await api.get("/x");
=== literal
// a literal starts eagerly, so bind the fetch before the tag runs
await fch.withFetch(myFetch)`https://api.example.com/x`;
```

It is also settable later with `req.setFetch(fn)`, which is what you want on a
builder:

```ts
const req = new Fch("https://api.example.com/x").setFetch(myFetch);
```

The implementation receives the same `(url, init)` as `fetch`, with `init.signal`
already combined from the timeout and your abort signal. Everything above it
still applies: retries, backoff, dedupe, interceptors and the UI timers all run
around your function, and an error it throws is retried like a network failure.

> **Eager start:** `setFetch()` on a request that already started is too late.
> Use the option, or `fch.withFetch(fn)` for the tagged template.

## The mental model

There are only three things to remember.

**1. The object is a URL.** Every standard `URL` property works and changes the
request target:

```ts
const req = new Fch("https://api.example.com/v1/items?page=1");

req.pathname = "/v2/items";              // standard URL property
req.searchParams.set("page", "2");       // standard URLSearchParams
req.searchParams.append("tag", "new");
req.hash = "results";

req.toString(); // "https://api.example.com/v2/items?page=2&tag=new#results"
```

**2. The object is the request.** Anything that is not a URL concern lives on
the same instance as chainable setters:

```ts
req.setMethod("POST")
	.setJsonBody({ name: "Cottage" })
	.setHeader("Accept", "application/json")
	.setRetries(2)
	.setTimeout(5_000);

const response = await req.send();
```

Every setter returns `this`, so chaining works. Nothing is sent until you
execute it.

**3. Executing it starts a request.** `await req`, `req.send()`, `req.json()`,
`req.text()` and `req.blob()` all run the request. The instance is a *builder*,
not a cached promise — so `await req` twice sends two requests, which is what
you want when you reuse a configured client.

```ts
const req = new Fch("https://api.example.com/health", { retries: 2 });

await req.send(); // request 1
await req.send(); // request 2 — same configuration, fresh request
```

> If you want one request reused by several readers, use `dedupe: true` (see
> [Deduplication](dedupe.md)) or call `start()` to fire it immediately and
> memoise it (see [Shorthand API](shortcuts.md)).

## A configured client

For anything beyond a one-off call, create a client with shared defaults:

```ts
import { fch } from "@westtrade/fch";

const api = fch.create({
	baseUrl: "https://api.example.com",
	retries: 2,
	retryDelay: 300,
	timeout: 5_000,
	headers: { Accept: "application/json" },
});

const [houses] = await api.get<House[]>("/houses");
await api.post("/houses", { name: "Cute Cottage" }); // object -> JSON body
```

A client is the only way to share defaults; the literal entry has no defaults,
so it is for one-off calls:

```tabs
=== function
const [house] = await api.get<House>("/houses/1");
=== literal
const [house] = await fch.get<House>`https://api.example.com/houses/1`;
```

Options passed to `create()` apply to every call; per-call options override
them. Shortcut calls (`api.get`, `api.post`, …) start their request immediately,
so they also work in fire-and-forget handlers without `await`.

`api.request(url, options?)` gives you a builder with the same defaults, and
accepts per-call options as its second argument — so a one-off override does not
need a chain:

```ts
const [house] = await api.request("/houses/1", { retries: 5 }).json<House>();
```

Use the setters only for what options cannot express, such as an interceptor or
a dedupe key factory:

```ts
await api.request("/houses", { dedupeKey: () => crypto.randomUUID() }).send();
```

## CommonJS

```js
const { Fch, fch } = require("@westtrade/fch");
```

The default export is the `fch` factory, which also carries `.create()`:

```ts
import fch from "@westtrade/fch";

const req = fch("https://api.example.com/users"); // same as new Fch(...)
const api = fch.create({ baseUrl: "https://api.example.com" });
```

## TypeScript

The package ships its own types. Nothing to install, no `@types/fch`.

The two generics you will use most:

```ts
// The shape of the parsed body
const [user] = await new Fch(url).json<User>();

// Shortcut calls carry the same generic
const [users] = await api.get<User[]>("/users");
```

Options are typed too, and `FetchRequestOptions extends RequestInit` — so every
native `fetch` option (`credentials`, `mode`, `cache`, `redirect`, `signal`, …)
is accepted alongside the `Fch` additions.

## Next steps

- [Why not plain fetch?](vs-fetch.md) — the six things you would otherwise write yourself.
- [The URL is the request](url-first.md) — why the design is shaped this way.
- [Retries & backoff](retries.md) — the most-used feature, explained properly.
