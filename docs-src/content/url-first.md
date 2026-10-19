# The URL is the request

Most HTTP clients make you hold two things at once:

```js
const url = new URL("https://api.example.com/items");
url.searchParams.set("page", "2");

const res = await client.get(url.toString(), { headers: { ... } });
//        ^^^^ the client has to be told again what the URL says
```

The URL is data; the client is behaviour. They drift apart the moment a
helper, a hook or a retry needs to know the final target.

`Fch` collapses them into one object by **extending `URL`**:

```ts
import { Fch } from "@westtrade/fch";

const req = new Fch("https://api.example.com/v1/items?page=1");

req instanceof URL;      // true
req instanceof Fch;      // true

req.pathname = "/v2/items";
req.searchParams.set("page", "2");

await req.send();        // requests exactly req.toString()
```

There is no `.toString()` hand-off, because the object being configured *is*
the object being sent.

## Why this is not cosmetic

### One source of truth

The request target can only be one thing. There is no "the URL I passed" versus
"the URL after interceptors ran" versus "the URL the retry used" — it is the
same property, read at the same moment the request is built.

This matters most with retries and interceptors. A request interceptor runs
before **every** attempt, so it can adjust the URL and the next attempt picks it
up automatically:

```ts
const req = new Fch("https://api.example.com/data", { retries: 3 })
	.before((r) => {
		r.searchParams.set("attempt_at", String(Date.now()));
	});

await req.send(); // every attempt carries its own timestamp
```

### The standard API, not a lookalike

Because it *is* a `URL`, every platform feature works: `URLSearchParams`
encoding, relative resolution via `new URL(path, base)`, `hostname`, `origin`,
`protocol`, `hash`. You can pass it to anything that accepts a `URL`:

```ts
const req = new Fch("https://api.example.com/items");
req.searchParams.set("q", "Tom & Jerry");

// Correctly encoded: q=Tom+%26+Jerry
console.log(req.toString());

// Libraries that accept URL accept it too
someOtherFetchClient.get(req);
fetch(req); // native fetch takes URL objects
```

That last line is worth pausing on: **`Fch` is a valid `fetch` input**. You can
use it as a URL today and start using its features incrementally, without a
rewrite.

### No string concatenation

The classic query-building bug:

```js
// Wrong: no encoding, and "a+b" becomes "a b" on the server
const url = `/api/search?q=${query}&tag=${tags.join(",")}`;
```

`Fch` inherits `URLSearchParams`, so encoding is the platform's job:

```ts
const req = new Fch("https://api.example.com/search");
req.searchParams.set("q", "a+b & c");   // -> q=a%2Bb+%26+c
req.searchParams.append("tag", "new");  // repeated keys work
req.searchParams.append("tag", "sale");
```

### Absolute URLs are enforced, early

`URL` cannot represent a relative path, and neither can `Fch`. Instead of
letting `fetch` fail later with an opaque `Failed to parse URL`, the constructor
throws a `TypeError` that says what to do:

```ts
new Fch("/api/users");
// TypeError: Fch requires an absolute URL, got "/api/users".
//   Pass a full URL, or resolve it against the page origin (https://my.app),
//   or set `baseUrl` via fch.create({ baseUrl }).
```

With a client, relative paths are resolved against `baseUrl`:

```ts
const api = fch.create({ baseUrl: "https://api.example.com" });

api.request("/users").toString();  // "https://api.example.com/users"
api.request("users").toString();   // "https://api.example.com/users" (leading slash optional)
api.request("https://other.example/x"); // absolute URLs ignore the base
```

## URL helpers

Two convenience methods for the common cases, on top of the standard API:

```ts
const req = new Fch("https://api.example.com/items?page=1&sort=asc");

// Replace the whole query string
req.setSearchParams({ page: 2, sort: "desc" });
// -> ?page=2&sort=desc   (old params are gone)

// Add to it, keeping what is there; arrays repeat the key
req.appendSearchParams({ tag: ["new", "sale"], q: "cottage" });
// -> ?page=2&sort=desc&tag=new&tag=sale&q=cottage
```

`setSearchParams` accepts `string | number | boolean` values and stringifies
them; `appendSearchParams` accepts a single value or an array.

For everything else, use the standard API directly — `req.searchParams.delete()`,
`req.searchParams.has()`, `req.searchParams.sort()`, and so on.

## Cloning

`clone()` produces an independent builder with the same URL, headers, body and
configuration:

```ts
const base = new Fch("https://api.example.com/items", {
	timeout: 5_000,
	headers: { Authorization: `Bearer ${token}` },
});

const one = base.clone().setSearchParams({ page: 1 });
const two = base.clone().setSearchParams({ page: 2 });

await Promise.all([one.json(), two.json()]); // two different requests
```

The clone gets fresh abort state — aborting the original does not cancel the
clone, and a caller-supplied `signal` is deliberately not carried over.

> Bodies that cannot be copied are logged as a warning rather than silently
> shared. `FormData`, strings, `URLSearchParams`, `Blob`, `ArrayBuffer` and
> typed arrays are all copied properly; a `ReadableStream` cannot be cloned.

## What lives where

Since the object is a `URL`, it is worth being precise about which members come
from the platform and which are `Fch` additions.

| From `URL` (standard) | From `Fch` (additions) |
| --- | --- |
| `href`, `origin`, `protocol`, `username`, `password` | `send()`, `json()`, `text()`, `blob()` |
| `host`, `hostname`, `port`, `pathname` | `setHeader()`, `setAuthToken()`, `setBasicAuth()` |
| `search`, `searchParams`, `hash` | `setJsonBody()`, `setFormData()`, `setBody()` |
| `toString()`, `toJSON()` | `setRetries()`, `setTimeout()`, `setRetryOn()` |
| `URL.canParse()`, `URL.parse()` (static) | `before()`, `after()`, `abort()`, `clone()`, `poll()` |

If a member is in the left column, the MDN page for `URL` is the documentation.
Nothing is overridden, so platform behaviour is exactly what you expect.
