# API reference

Every public member of `Fch`, with the behaviour that is easy to get wrong.
Options marked *deprecated* still work.

## Creating a request

### `new Fch(url, options?)`

`url` must be absolute — a `string` or a `URL`. A relative path throws a
`TypeError` explaining the fix, because `URL` cannot represent one.

```ts
new Fch("https://api.example.com/users");
new Fch(new URL("https://api.example.com/users"));
new Fch("https://api.example.com/users", { retries: 2, timeout: 5000 });
```

### `fch(url, options?)`

The default export. Same as `new Fch(...)`, for a shorter call. It also carries
`.create()`.

### `fch.create(options?)`

Returns a client with shared defaults and shortcut methods. See
[Shorthand API](shortcuts.md).

```ts
const api = fch.create({ baseUrl: "https://api.example.com", timeout: 5000 });

api.get("/users");              // starts immediately
api.post("/users", body);       // starts immediately
api.request("/users");          // returns a builder
api.request("/users", { retries: 5 }); // builder with per-call options
api.defaults;                   // the shared defaults
```

## Options

`FetchRequestOptions extends RequestInit`, so every native `fetch` option works.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `retries` | `number` | `0` | Retries **after** the first attempt |
| `retryDelay` | `number` | `1000` | Base delay in ms for exponential backoff |
| `maxRetryDelay` | `number` | `30000` | Cap on the delay before jitter |
| `timeout` | `number` | `30000` | Per-attempt timeout in ms; `0` disables |
| `delayMs` | `number \| false` | `500` | UI timer: report `delayed` after N ms (never aborts) |
| `timeoutMs` | `number \| false` | `8000` | UI timer: report `timeout` after N ms (never aborts) |
| `retryOn` | `(response, error, attempt) => boolean` | network errors only | Retry policy |
| `dedupe` | `boolean` | `false` | Collapse concurrent identical requests |
| `dedupeKey` | `string \| () => string` | — | Identity for mutating requests; also sent as `Idempotency-Key` |
| `signal` | `AbortSignal` | — | Your abort signal, combined with the timeout |
| `logger` | `Logger` | `console` | Where log lines go |
| `debug` | `boolean` | `false` | Enable `info`/`debug` logging |
| `headers` | `HeadersInit` | — | Initial headers |
| `fetch` | `typeof fetch` | global | Custom fetch implementation |
| `method` | `string` | `GET` | Validated and upper-cased |
| `retryTimeout` | `number` | — | *Deprecated*: use `retryDelay` |
| `abortController` | `AbortController` | — | *Deprecated*: use `signal` |
| `idempotencyKey` | `string \| () => string` | — | *Deprecated*: use `dedupeKey` |
| `baseUrl` / `baseURL` | `string` | — | `create()` only; must be absolute |

## URL members (inherited)

Standard `URL`, unmodified:

`href`, `origin`, `protocol`, `username`, `password`, `host`, `hostname`,
`port`, `pathname`, `search`, `searchParams`, `hash`, `toString()`, `toJSON()`,
and the static `URL.canParse()` / `URL.parse()`.

### `setSearchParams(params)`

**Replaces** the query string. Accepts `string | number | boolean` values.

```ts
req.setSearchParams({ page: 2, sort: "desc" });
// "?page=2&sort=desc" — old params are gone
```

### `appendSearchParams(params)`

**Adds** to the query string. Arrays repeat the key.

```ts
req.appendSearchParams({ tag: ["new", "sale"], q: "cottage" });
// "?tag=new&tag=sale&q=cottage"
```

## Executing

Every execution starts a **new** request. The instance is a builder, not a
cached promise.

| Member | Resolves to |
| --- | --- |
| `send()` | `Promise<Response>` |
| `await req` / `.then()` | `Response` |
| `.json<T>()` | `Promise<[T, Response]>` |
| `.text()` | `Promise<[string, Response]>` |
| `.blob()` | `Promise<[Blob, Response]>` |
| `makeRequest()` | `Promise<Response>` — same as `send()` |

`.json()`, `.text()` and `.blob()` read the body from a clone, so the returned
`Response` stays readable.

### `start()`

Begins the request immediately and memoises it, so later helpers reuse it
instead of starting another. A failed eager request drops the memo.

```ts
new Fch(url).start();
```

### `then` / `catch` / `finally`

Standard promise methods. `await req` is the same as `await req.send()`.

## Bodies

### `setBody(body, contentType?)`

Raw body. Accepts anything `fetch` accepts, plus a `<form>` element or submit
`Event`. With no `contentType`, any existing `Content-Type` is **removed** so the
runtime can set the right one.

### `setJsonBody(value)`

`JSON.stringify(value)` plus `Content-Type: application/json`.

### `setFormUrlEncodedBody(data)`

`application/x-www-form-urlencoded`. Arrays repeat the key.

### `setFormData(formData)`

Accepts `FormData`, a `<form>` element, a submit `Event`, or a **CSS selector**
for a form (`"#checkout"`). A string is a selector here, never a body. Adopts the form's
method when it is not `GET`; a `GET`/`HEAD` request serialises the fields into
the query string instead of sending a body. Clears `Content-Type`.

### `appendToFormData(key, value)`

Creates the `FormData` on first call, appends, sets the method to `POST` (unless
already `PUT`), clears `Content-Type`.

### `setFormFrom(selector)`

Explicit alias for `setFormData(selector)`. Throws
`setFormData() found no <form> matching "…"` when nothing matches, or when the
match is not a form.

### `appendFormToQuery(data)`

Serialises form fields into the query string, as a browser `GET` submit does.
File inputs contribute their filename.

## Headers

| Method | Behaviour |
| --- | --- |
| `setHeader(name, value)` | Set one header |
| `setHeaders(object)` | **Merge** several headers |
| `getHeader(name)` | Read one, or `null` |
| `deleteHeader(name)` | Remove one |
| `setAuthToken(token)` | `Authorization: Bearer <token>` |
| `setBasicAuth(user, pass)` | `Authorization: Basic <base64>` (UTF-8 safe) |

## Request configuration

| Method | Notes |
| --- | --- |
| `setMethod(method)` | Validated; throws on an unsupported method |
| `setTimeout(ms)` | Throws on negative or non-finite |
| `setRetries(n)` | Throws on negative or non-integer |
| `setRetryDelay(ms)` | Base delay; throws on negative or non-finite |
| `setMaxRetryDelay(ms)` | Cap before jitter |
| `setRetryOn(fn)` | Unified response/error predicate |
| `setFetchOptions(init)` | Merges into the fetch init; `headers` are merged into `this.headers` |
| `setCORS(mode)` | Sets `mode` |
| `disableCache()` | Sets `cache: "no-store"` |
| `setDedupeKey(key)` | String or factory, called at most once per request |

### `setFetch(impl)` / `fetch`

Use a custom `fetch`-compatible function for this instance. The getter returns
the custom one, else the global `fetch` (resolved lazily, so a polyfill loaded
after construction still applies). Throws `TypeError` for a non-function, and a
`TypeError` mentioning `{ fetch }` when no global exists.

### `method`

Readable and writable. Reading returns the current method (`GET` by default);
writing validates like `setMethod`.

## Deduplication

```ts
new Fch(url, { dedupe: true });                 // safe methods: method + URL
req.setDedupeKey(() => crypto.randomUUID());    // mutating: explicit identity
```

The key is sent as `Idempotency-Key` on `POST`, `PUT`, `PATCH` and `DELETE`,
unless you already set that header.

## Interceptors

| Method | Behaviour |
| --- | --- |
| `before(fn)` | Before **every** attempt (including retries) |
| `after(fn)` | After the final response, before it is returned |

Several hooks chain in registration order. An error thrown by `after()` is
never retried.

## Deprecated aliases

Four methods that only ever delegated to another name are no longer in the core,
so their bytes cost only the projects that still call them. Attach the compat
plugin to get them back:

```ts
import { compat } from "@westtrade/fch/plugins/compat";

const req = new Fch(url).use(compat());
```

| Deprecated | Use instead |
| --- | --- |
| `setRetryTimeout(ms)` | `setRetryDelay(ms)` |
| `setIdempotencyKey(key)` | `setDedupeKey(key)` |
| `addRequestInterceptor(fn)` | `before(fn)` |
| `addResponseInterceptor(fn)` | `after(fn)` |

`DEPRECATED_MEMBERS` is exported for tooling and tests.

## Logging (plugin)

Logging lives in `@westtrade/fch/plugins/logger`; the core only emits events.
Attaching it adds these members back:

| Method | Behaviour |
| --- | --- |
| `setLogger(logger)` | Validated; falls back to the default if incomplete |
| `getLogger()` | Logger proxy that respects the instance's gating |
| `enableLogging()` | `debug: true` |
| `disableLogging()` | `debug: false` |

```ts
new Fch(url).use(logger({ logger: pinoLogger, debug: true }));
```

The `logger` and `debug` constructor options are still accepted, and the plugin
adopts them when installed.

## UI timers

Observational phases for loading indicators: `idle → submitting → delayed → timeout`.

| Member | Result |
| --- | --- |
| `timer` | current phase |
| `loading` | `true` in submitting, delayed and timeout |
| `delayed` | `true` once `delayMs` elapsed |
| `timedOut` | `true` once `timeoutMs` elapsed |
| `timerInfo` | `{ state, loading, delayed, timedOut, elapsed }` |
| `onTimer(fn)` | subscribe to phase changes; returns an unsubscribe |
| `setTimers(delayMs, timeoutMs?)` | configure both; throws if `delayMs > timeoutMs` |

## Lifecycle

### `abort(reason?)`

Cancels in-flight requests and pending retry delays. The builder stays usable —
the next execution starts a fresh abort generation. Does not abort a
caller-supplied controller.

### `aborted`

`true` when the current request was aborted or timed out. Resets when the next
request starts.

### `clone()`

An independent builder with the same URL, headers, body and configuration.
Fresh abort state; a caller-supplied `signal` is not carried over.

### `poll(delay?, controller?)`

An async generator that repeats the request. A failed poll **yields** the error
instead of throwing, so the loop continues. `delay` defaults to `300` ms and is
used exactly — it is not clamped by `maxRetryDelay`.

Without a `controller`, the poll owns a fresh stop signal; `abort()` still stops
a running poll, but a poll started after an `abort()` works normally. Pass your
own controller when the poll's lifetime differs from the request's. See
[Polling](polling.md).

```ts
for await (const result of api.request("/jobs/1").poll(1000, controller)) {
	if (result instanceof Error) continue;
	const job = await result.json();
	if (job.done) break;
}
```

## Tagged template entry point

`@westtrade/fch/literal` exports a template tag. Same class, same options, only
the spelling differs; the returned call is a `FchCall`, so it is both awaitable
and a request builder.

```ts
import fch, { raw } from "@westtrade/fch/literal";

await fch`https://api.example.com/users/1`;          // [body, Response]
fch`https://api.example.com/users/1`.request;         // the Fch instance
fch`https://api.example.com/users/${raw("1/posts")}`; // skip encoding

// one tag per method; body first for methods that carry one
fch.get`https://api.example.com/users/1`;
fch.delete`https://api.example.com/users/1`;
fch.post({ name: "Ann" })`https://api.example.com/users`;
```

Interpolated values are URL-encoded. See [Tagged template](literal.md).

## Types

```ts
import type {
	FchApi,               // ReturnType<typeof create>
	FchBody,              // BodyInit | FormLike | null
	FchBodyInput,         // + Record | unknown[] (shortcut bodies)
	FchCall,              // the thenable returned by shortcut methods
	FchFactory,           // the default export's type
	FetchRequestOptions,  // options for a builder
	FchInstanceOptions,   // options for create() (adds baseUrl)
	FormLike,             // structural form/event shape
	HttpMethod,
	Logger,
} from "@westtrade/fch";
```

`FchCall<T>` is a `Promise<[T, Response]>` with `json`, `text`, `blob`, `send`
and `request` attached.

## Errors you may see

| Error | When |
| --- | --- |
| `TypeError: Fch requires an absolute URL` | Relative path without a `baseUrl` |
| `TypeError: Fch requires an absolute \`baseUrl\`` | Relative base passed to `create()` |
| `TypeError: Unsupported HTTP method: X` | Unknown method via any entry point |
| `TypeError: Cannot retry requests with ReadableStream body` | Stream body plus `retries > 0` |
| `TypeError: setFormData() expects FormData, a <form> element, or a submit event` | Not form-like |
| `Error: Invalid retries: N` | Negative or non-integer |
| `Error: Invalid timeout: N` | Negative or non-finite |
| `DOMException` / `TimeoutError` | Per-attempt timeout elapsed |
| `DOMException` / `AbortError` | `abort()` or your signal |
| `SyntaxError` | `.json()` on a non-JSON body |

## A complete example

```ts
import { fch, type Logger } from "@westtrade/fch";

const logger: Logger = {
	info: (...a) => console.info("[api]", ...a),
	warn: (...a) => console.warn("[api]", ...a),
	error: (...a) => console.error("[api]", ...a),
	debug: (...a) => console.debug("[api]", ...a),
};

const api = fch.create({
	baseUrl: "https://api.example.com",
	timeout: 5_000,
	retries: 2,
	retryDelay: 300,
	maxRetryDelay: 5_000,
	dedupe: true,
	logger,
	headers: { Accept: "application/json" },
	retryOn: (response, error, attempt) => {
		if (response) return response.status === 429 || response.status >= 500;
		return attempt < 3;
	},
});

// Deduped GET, strict about HTTP errors
const httpError = (res: Response) => {
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res;
};

const [house] = await api
	.request("/houses/1")
	.setAuthToken(process.env.API_TOKEN!)
	.after(httpError)
	.json<House>();

// Write with a stable idempotency key and retries
await api
	.request("/houses", { method: "POST", dedupeKey: () => crypto.randomUUID() })
	.setJsonBody({ name: "Cottage" })
	.send();
```
