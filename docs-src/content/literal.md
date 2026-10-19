# Tagged template

A second entry point that lets a URL sit in backticks:

```ts
import fch from "@westtrade/fch/literal";

const [user, response] = await fch`https://api.example.com/users/1`;

const request = fch`https://api.example.com/users/1`; // the builder too
```

It is the same client, the same `Fch` class and the same response handling —
only the spelling changes. Import it from the `/literal` subpath so the default
export is the template tag; the main entry's default export stays the factory
function.

## One value, two uses

`fch\`…\`` returns exactly what the shortcut API returns: a promise for
`[parsedBody, response]` that is **also** the request object. So a call can be
awaited directly, or kept and read through its helpers:

```ts
// Await it directly
const [users, response] = await fch`https://api.example.com/users`;

// Or keep the call and choose how to read it
const call = fch`https://api.example.com/users`;

const [same, res] = await call.json<House[]>(); // the body, parsed
await call.send();                              // the raw Response
call.request;                                   // the Fch instance
```

Because the request starts immediately, every helper on the call reads the
**same** request rather than firing a new one.

Available on the returned call:

| Member | Result |
| --- | --- |
| `await call` | `[parsedBody, response]` |
| `call.json<T>()` | `[T, Response]` |
| `call.text()` | `[string, Response]` |
| `call.blob()` | `[Blob, Response]` |
| `call.send()` | `Response` |
| `call.request` | the underlying `Fch` instance |

Because the request starts immediately, `fch\`…\`` also works fire-and-forget:

```ts
fch`https://api.example.com/events`; // sent now, no await needed
```

> **Ordering matters.** The request is created and started the moment the tag
> runs, so anything applied to `call.request` afterwards — headers, retries,
> query params — does **not** reach that request:
>
> ```ts
> const call = fch`https://api.example.com/users`;
> call.request.setHeader("X-Test", "1");
> await call; // X-Test is NOT on this request
> ```
>
> To configure before sending, use the builder: `new Fch(url)` or
> `fch.create().request(url)`. See [Shorthand API](shortcuts.md).

## One tag per method

Bare `fch\`…\`` is a `GET`. The method tags make the verb explicit and, for
methods that carry a body, take the body first:

```ts
fch.get`https://api.example.com/users/1`;       // GET
fch.head`https://api.example.com/users/1`;      // HEAD
fch.options`https://api.example.com/users/1`;   // OPTIONS
fch.delete`https://api.example.com/users/1`;    // DELETE
fch.del`https://api.example.com/users/1`;       // same as delete

fch.post({ name: "Ann" })`https://api.example.com/users`;    // POST + JSON
fch.put({ name: "Ann" })`https://api.example.com/users/1`;   // PUT  + JSON
fch.patch({ name: "Ann" })`https://api.example.com/users/1`; // PATCH + JSON
```

The body goes **before** the template because the template carries only the
URL. One spelling, no second way to do it:

```ts
// right
fch.post({ name: "Ann" })`https://api.example.com/users`;

// wrong: the tag does not take a body after it
// fch.post`https://api.example.com/users`({ name: "Ann" });
```

`del` exists alongside `delete` because `delete` reads awkwardly in a chain and
is a reserved word elsewhere; both send a `DELETE`.

### Bodies are inferred, like the shortcut API

| Body | Sent as |
| --- | --- |
| plain object / array | `JSON.stringify` + `Content-Type: application/json` |
| `<form>` element / submit `Event` | `FormData`, boundary left to the runtime |
| `FormData`, `Blob`, `ArrayBuffer`, `ReadableStream`, `URLSearchParams` | untouched |
| string | as-is, with no `Content-Type` imposed |

```ts
fch.post([{ id: 1 }, { id: 2 }])`https://api.example.com/batch`; // JSON array
fch.put(blob)`https://api.example.com/upload`;                   // binary as-is
fch.patch(form)`https://api.example.com/users/1`;                // multipart
```

An empty call (`fch.put(null)\`…\``) sends no body at all.

### Typing

The generic goes on the body call, before the template:

```ts
const [user] = await fch.get<User>`https://api.example.com/users/1`;
const [created] = await fch.post<House>({ name: "Cottage" })`https://api.example.com/houses`;
```

The tag returns the same `FchCall`, so `await`, `.json()`, `.send()`,
`.request` and `abort()` all work exactly as with the bare tag.

## A custom `fetch`

A literal starts its request the moment the tag runs, so `setFetch()` on
`.request` afterwards is too late. Bind the implementation first:

```ts
import fch from "@westtrade/fch/literal";

await fch.withFetch(myFetch)`https://api.example.com/users/1`;
await fch.withFetch(myFetch).get`https://api.example.com/users/1`;
await fch.withFetch(myFetch).post({ name: "Ann" })`https://api.example.com/users`;
```

A named export exists too, for when you want it once:

```ts
import { withFetch } from "@westtrade/fch/literal";

const traced = withFetch((url, init) => {
	console.log(init?.method, url);
	return fetch(url, init);
});

await traced`https://api.example.com/users/1`;
```

## Interpolation is encoded

This is the reason to use the tag instead of a plain string. Every interpolated
value is passed through `encodeURIComponent`, so user input cannot escape its
path segment or inject a query string:

```ts
const id = "42/../admin?x=1";

fch`https://api.example.com/users/${id}`;
// https://api.example.com/users/42%2F..%2Fadmin%3Fx%3D1
```

The slash, the traversal and the `?` all end up percent-encoded, so the value
stays a single path segment. Spaces and non-Latin characters are encoded too:

```ts
fch`https://api.example.com/search/${"Tom & Jerry"}`;
// .../search/Tom%20%26%20Jerry

fch`https://api.example.com/users/${"Иван"}`;
// .../users/%D0%98%D0%B2%D0%B0%D0%BD
```

Numbers are stringified first, so `fch\`/users/${42}\`` is `/users/42`.
`null` and `undefined` interpolate as an empty string.

### Opting out with `raw()`

When a value is already safe — or must keep its slashes — wrap it:

```ts
import fch, { raw } from "@westtrade/fch/literal";

fch`https://api.example.com/${raw("users/42/posts")}`;
// https://api.example.com/users/42/posts   (slashes preserved)
```

Only use `raw()` for values you control or have already encoded. Applying it to
user input reintroduces exactly the injection the tag prevents.

## Building the URL from parts

Interpolation is for **path segments**, not for query strings — the tag does not
parse its result. Build queries with `searchParams` on the request:

```ts
const call = fch`https://api.example.com/users/${id}/posts`;
call.request.searchParams.set("page", "2");
call.request.searchParams.append("tag", "new");
await call;
```

An absolute URL is still required. A relative template throws the same
`TypeError` the constructor does:

```ts
fch`/users/1`;
// TypeError: Fch requires an absolute URL, got "/users/1".
```

## What it does not change

The tag is a spelling, not a second implementation. Everything else applies
unchanged:

- the same options (`fch.create()`, `new Fch(url, options)`) and defaults;
- the same retries, timeouts, dedupe, interceptors and logging;
- the same eager start as the shortcut API;
- the same response parsing (JSON by content type, text otherwise).

`fch.Fch` is exposed for `instanceof` checks:

```ts
import fch from "@westtrade/fch/literal";

fch`https://api.example.com/x`.request instanceof fch.Fch; // true
```

## When to use it

Use the tagged template when a request is a one-liner and the URL is the whole
configuration:

```ts
const [health] = await fch`https://api.example.com/health`;
```

Reach for the builder or `fch.create()` when you need defaults, chaining, or a
configurable client:

```ts
import { fch } from "@westtrade/fch";

const api = fch.create({ baseUrl: "https://api.example.com", retries: 2, timeout: 5000 });
const [users] = await api.get<House[]>("/users");
```

The two entries share one class, so they mix freely:

```ts
import { Fch } from "@westtrade/fch";
import fch from "@westtrade/fch/literal";

const req = new Fch("https://api.example.com/users").setRetries(2);
const [users] = await req.json();

const [one] = await fch`https://api.example.com/users/1`; // same client
```
