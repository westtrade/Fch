# Bodies, headers, methods

A request is mostly plumbing: pick a method, encode a body, set a header, do not
forget the `Content-Type`. `Fch` makes each of those one call, and picks the
right encoding based on what you hand it.

## Methods

```tabs
=== class
const req = new Fch("https://api.example.com/houses", { method: "POST" })
	.setJsonBody({ name: "Cottage" });
=== function
const api = fch.create({ baseUrl: "https://api.example.com" });

api.post("/houses", { name: "Cottage" }); // object -> JSON
=== literal
fch.post({ name: "Cottage" })`https://api.example.com/houses`;
```

Methods are upper-cased, and anything the platform can send is accepted:

```ts
new Fch(url, { method: "post" }).method; // "POST"
new Fch(url).setMethod("post").method;   // "POST"

// Not on the standard list, but a real method: sent as-is, with a warning.
new Fch(url).setMethod("PURGE").method;  // "PURGE"  → [WARN] Non-standard HTTP method
new Fch(url, { method: "PROPFIND" });    // WebDAV, works
```

Common methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. They
are never warned about.

### What is rejected, and why

Only two cases throw, because neither can result in a request:

| Call | Result |
| --- | --- |
| `setMethod("CONNECT")` | `TypeError` — `fetch` forbids `CONNECT`, `TRACE`, `TRACK` |
| `setMethod("GE T")` | `TypeError` — not a valid HTTP method token |

A non-standard *legal* method (`PURGE`, `PROPFIND`, `LINK`, a custom verb) is
**not** an error. It is sent, and reported through the logger as a warning:

```text
[WARN] Non-standard HTTP method "PURGE": it will be sent as-is.
       Most servers reject unknown methods; check that this is intended.
```

The warning goes through the event stream, so it needs the
[logger plugin](logging.md) to be visible. Without it, the request is still sent.

The same rules apply in the constructor, `setMethod` and `setFetchOptions`, so
there is no back door that lets an unsendable method through to `fetch`.

## Bodies

`setBody()` is the raw door: it passes anything `fetch` accepts straight
through, plus form elements (below).

```ts
req.setBody(JSON.stringify(data), "application/json");
req.setBody(blob);
req.setBody(arrayBuffer);
req.setBody(new URLSearchParams({ a: "1" }));
req.setBody(readableStream);        // note: cannot be retried, see below
req.setBody(null);                  // no body
```

The second argument is an optional `Content-Type`. Pass it and the header is
set; omit it and `Fch` **removes** any existing `Content-Type` instead of
guessing — because for `FormData`, `URLSearchParams` and streams the runtime
must generate its own (including the multipart boundary).

### JSON

```ts
await new Fch("https://api.example.com/houses")
	.setMethod("POST")
	.setJsonBody({ name: "Cottage", price: 120_000 })
	.send();
```

`setJsonBody` runs `JSON.stringify` and sets `Content-Type: application/json`.

### URL-encoded

```ts
await new Fch("https://api.example.com/login")
	.setMethod("POST")
	.setFormUrlEncodedBody({ username: "alice", scopes: ["read", "write"] })
	.send();

// body: username=alice&scopes=read&scopes=write
// Content-Type: application/x-www-form-urlencoded
```

Arrays repeat the key, which is what most server frameworks expect for
multi-value fields.

### Binary

`Blob`, `File`, `ArrayBuffer` and typed arrays are passed through untouched.
`Content-Type` is left alone so a `Blob` keeps its own type:

```ts
const png = await fetch("/chart.png").then((r) => r.blob());

await new Fch("https://api.example.com/uploads")
	.setMethod("POST")
	.setBody(png)          // Content-Type comes from the Blob
	.send();
```

### Streams

```ts
const stream = new ReadableStream({
	start(controller) {
		controller.enqueue(new TextEncoder().encode("hello"));
		controller.close();
	},
});

await new Fch("https://api.example.com/ingest")
	.setMethod("POST")
	.setBody(stream)
	.setFetchOptions({ duplex: "half" }) // Node needs this for streamed uploads
	.send();
```

A stream body cannot be replayed, so `Fch` refuses to combine it with retries:

```ts
new Fch(url, { retries: 1 }).setBody(stream).send();
// TypeError: Cannot retry requests with ReadableStream body. Set retries to 0.
```

That is a deliberate hard failure. Silently retrying a consumed stream would
send a truncated request.

## Headers

```ts
req.setHeader("Accept-Language", "en");
req.setHeaders({ "X-Trace-Id": "abc", "X-Tenant": "acme" });

req.getHeader("Accept-Language"); // "en"
req.deleteHeader("X-Trace-Id");
```

`setHeaders` **merges** — it does not replace the whole header set. Both accept
plain objects; header names are case-insensitive, as usual.

### Auth helpers

```ts
req.setAuthToken(token);              // Authorization: Bearer <token>
req.setBasicAuth("user", "p@ssw0rd"); // Authorization: Basic <base64>
```

`setBasicAuth` base64-encodes as UTF-8, so non-Latin-1 credentials work
(`btoa` alone would throw on them).

## Forms

A `<form>` element, a submit `Event`, or a `FormData` can go anywhere a body
goes:

```ts
const req = new Fch("https://api.example.com/houses");

req.setFormData(form);        // the element
req.setFormData(event);       // the submit event
req.setFormData(new FormData(form));
```

All four spellings of the same intent are accepted, including `event.target`.
See [Forms & events](forms.md) for the details — the form's own `method`
attribute is honoured, the clicked submit button is included, and a
`method="get"` form serialises into the query string.

Append to a form body incrementally:

```ts
req.appendToFormData("name", "Cottage")
	.appendToFormData("photo", fileBlob);
```

`appendToFormData` creates the `FormData` on first call, switches the method to
`POST` (unless it is already `PUT`), and clears `Content-Type` so the runtime can
add the multipart boundary.

## Everything else from `fetch`

`FetchRequestOptions extends RequestInit`, and `setFetchOptions` merges into it:

```ts
req.setFetchOptions({
	credentials: "include",
	mode: "cors",
	cache: "no-store",
	redirect: "follow",
	keepalive: true,
	referrerPolicy: "strict-origin-when-cross-origin",
});
```

Two conveniences for the common cases:

```ts
req.setCORS("cors");     // mode
req.disableCache();      // cache: "no-store"
```

Headers passed to `setFetchOptions` are merged into `this.headers` rather than
replacing them, because that is the header set the request is actually sent
with.

## Order does not matter

Setters only record state. Nothing is serialised until the request runs, so you
can set the body before the method, the timeout after the headers, or mutate
the URL at the last moment:

```ts
const req = new Fch("https://api.example.com/houses")
	.setJsonBody({ name: "Cottage" })
	.setMethod("POST")
	.setSearchParams({ dry_run: true });

req.pathname = "/v2/houses";   // still fine
await req.send();
```

## A complete example

```ts
import { Fch } from "@westtrade/fch";

const [created, response] = await new Fch("https://api.example.com/v1/houses")
	.setMethod("POST")
	.setAuthToken(process.env.API_TOKEN!)
	.setJsonBody({
		name: "Cute Cottage",
		price: 120_000,
		tags: ["garden", "quiet"],
	})
	.setHeader("Idempotency-Key", crypto.randomUUID())
	.setTimeout(10_000)
	.setRetries(2)
	.json<{ id: number }>();

console.log(response.status, created.id);
```
