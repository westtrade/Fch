# Fch — URL and fetch, combined

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`Fch` is not a wrapper around `fetch`. It **extends the native `URL` class**, so a single object is
both a real, fully mutable URL and the request that targets it. You build the URL with the standard
platform API, then execute it — with retries, timeouts, deduplication and typed body helpers on top.

```ts
import { Fch } from "fch";

const req = new Fch("https://api.example.com/v1/search");

// 1. It IS a URL — the standard API works, mutations affect the request.
req.pathname = "/v2/search";
req.searchParams.set("q", "hello");
req.hash = "results";

// 2. It is also the request — await it, or use a typed helper.
const [data, response] = await req.json<{ items: string[] }>();
```

Because the URL and the client are one object, there is no separate "build a URL, then pass it to a
client" step. `req instanceof URL` is `true`.

## Features

- **URL-first**: inherits `URL` — `pathname`, `host`, `origin`, `searchParams`, `hash`, `toString()`.
- **Retries**: configurable attempts with exponential backoff and jitter.
- **Timeouts**: per-request timeout, independent of the retry loop.
- **Interceptors**: run before every attempt (requests) and before returning (responses).
- **Logging**: pluggable logger; `error`/`warn` always emit, `info`/`debug` are opt-in.
- **Body formats**: JSON, FormData, URL-encoded, text, Blob, ArrayBuffer, ReadableStream.
- **Dedupe**: collapse concurrent identical in-flight requests, with `Idempotency-Key` support.
- **Abort**: cancel in-flight work and pending retry delays; the builder stays reusable.
- **Awaitable**: the instance is thenable (`await req`), and also exposes `send()`, `.json()`, `.text()`, `.blob()`.

## Installation

```bash
npm install fch
# or
yarn add fch
```

## Usage

### The URL is the request

```ts
import { Fch } from "fch";

const req = new Fch("https://api.example.com/v1/items?page=1");

req.searchParams.set("page", "2");        // standard URLSearchParams
req.searchParams.append("tag", "new");
req.pathname = "/v2/items";               // standard URL property

console.log(req.toString());              // https://api.example.com/v2/items?page=2&tag=new
await req.send();                         // one request, to exactly that URL
```

### Await the object directly

```ts
const response = await new Fch("https://api.example.com/data", { timeout: 3000 });
```

### Typed bodies

```ts
const [user] = await new Fch("https://api.example.com/users")
	.setJsonBody({ name: "Alice", role: "admin" })
	.json<{ id: number; name: string }>();
```

### Retries, timeout and interceptors

```ts
const api = new Fch("https://api.example.com/orders", {
	retries: 3,          // 1 initial attempt + 3 retries
	retryDelay: 500,     // base delay; exponential backoff with jitter
	maxRetryDelay: 10_000,
	timeout: 5_000,
	debug: true,
})
	.setAuthToken(process.env.TOKEN!)
	.addRequestInterceptor((req) => {
		// runs before EVERY attempt, so a refreshed token is picked up
		req.setHeader("X-Request-Id", crypto.randomUUID());
	})
	.addResponseInterceptor(async (res) => {
		if (res.status === 401) throw new Error("Unauthorized");
		return res;
	})
	// decide what is worth retrying; without this only network errors retry
	.setRetryOn((response, error, attempt) => {
		if (response) return response.status === 429 || response.status >= 500;
		return attempt < 3;
	});

try {
	const [order] = await api.json();
} catch (error) {
	console.error("Request failed after retries:", error);
}
```

### Deduplication

```ts
const req = new Fch("https://api.example.com/profile", { dedupe: true });

// Both share one in-flight request; each caller gets its own readable response.
const [a, b] = await Promise.all([req.json(), req.json()]);
```

### Cancelling

```ts
const req = new Fch("https://api.example.com/slow", { retries: 5 });
const pending = req.send();

req.abort();               // cancels the request and any pending retry delay
await pending.catch(() => {});

await req.send();          // the builder is still usable afterwards
```

## API overview

| Area | Members |
| --- | --- |
| URL (inherited) | `pathname`, `host`, `origin`, `searchParams`, `hash`, `toString()` |
| Execute | `send()`, `json()`, `text()`, `blob()`, `makeRequest()`, `then()`, `catch()`, `finally()` |
| URL helpers | `setSearchParams()`, `appendSearchParams()` |
| Bodies | `setJsonBody()`, `setFormData()`, `appendToFormData()`, `setFormUrlEncodedBody()`, `setBody()` |
| Headers | `setHeader()`, `setHeaders()`, `getHeader()`, `deleteHeader()`, `setAuthToken()`, `setBasicAuth()` |
| Request config | `setMethod()`, `setTimeout()`, `setRetries()`, `setRetryDelay()`, `setMaxRetryDelay()`, `setRetryOn()`, `setFetchOptions()`, `setCORS()`, `disableCache()` |
| Dedupe | `setDedupeKey()`, `setIdempotencyKey()` (deprecated alias) |
| Interceptors | `addRequestInterceptor()`, `addResponseInterceptor()` |
| Logging | `getLogger()`, `setLogger()`, `enableLogging()`, `disableLogging()` |
| Lifecycle | `abort()`, `aborted`, `clone()` |
| Polling | `poll(delay?)` — async generator of repeated responses |

## License

MIT
