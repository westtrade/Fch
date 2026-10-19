# Interceptors

Interceptors are the two seams around the request: one before every attempt,
one after the response arrives. They are plain functions, registered on the
builder, and they run in registration order.

## `before()` — request interceptors

Runs **before every attempt**, including retries. That timing is the point: a
retried request can pick up a refreshed token, a new request id, or an updated
timestamp.

```ts
const req = new Fch("https://api.example.com/orders", { retries: 3 })
	.before((request) => {
		// runs before attempt 1, 2, 3 and 4
		request.setHeader("X-Request-Id", crypto.randomUUID());
	});
```

The hook receives the `Fch` instance and may mutate it freely — headers, URL,
body, timeout, method.

```ts
api.before((req) => {
	req.searchParams.set("ts", String(Date.now()));
	req.setHeader("X-Trace-Id", crypto.randomUUID());
});
```

### Async hooks

Hooks may be async, for example to fetch a token first:

```ts
api.before(async (req) => {
	const token = await getFreshToken(); // cached, refreshes when stale
	req.setAuthToken(token);
});
```

A word of caution on the return value: `Fch` is thenable, so a concise arrow
that *returns* a chaining call will resolve the instance and start another
request. Use a block body:

```ts
api.before((req) => req.setHeader("X-A", "1"));   // starts a request recursively
api.before((req) => { req.setHeader("X-A", "1"); }); // correct
```

`Fch` guards against this specific case (it never awaits the instance itself),
but a block body is the clearer habit.

### Several hooks

They run in registration order, each on the result of the previous one:

```ts
api.before(addTraceId).before(addTenant).before(addAuth);
```

## `after()` — response interceptors

Runs after a response arrives, before it is returned to you. It receives a
`Response` and must return one:

```ts
api.after(async (response) => {
	if (response.status === 401) {
		await refreshSession();
		throw new Error("Unauthorized");
	}
	return response;
});
```

Several hooks chain: each receives the previous hook's return value.

### Do not consume the body

A `Response` body can be read once. If your hook needs to inspect it, clone
first:

```ts
api.after(async (response) => {
	const body = await response.clone().json();
	if (body.error) throw new Error(body.error);
	return response;
});
```

Returning `response` after reading `response.clone()` leaves the original
readable for your code and for `.json()`/`.text()`.

### Throwing stops everything

An interceptor that throws is treated as a **logic error**, not a transport
error:

- the interceptor error itself is **never retried** — otherwise a throwing
  `after()` on a `POST` would replay the write on every attempt;
- the error propagates to your `await`;
- the error is logged at `error` level.

`retryOn` is evaluated **before** response interceptors run, so a status the
predicate wants retried is retried first, and only the final response reaches
`after()`. The two mechanisms do not fight: `retryOn` decides about transport,
`after()` decides about the response that survived.

That is why `after()` is the recommended place for HTTP error policies:

```ts
const httpError = (response: Response) => {
	if (!response.ok) throw new HttpError(response.status, response.statusText, response);
	return response;
};

const [user] = await api.request("/users/1").after(httpError).json<User>();
```

See [Reading responses](reading-responses.md) for the full pattern.

## What hooks see

| | `before` | `after` |
| --- | --- | --- |
| Receives | the `Fch` instance | the `Response` |
| Runs | before each attempt | once, after a successful response |
| Can mutate | URL, headers, body, method, timeout | the response (return a new one) |
| Runs on retry | yes, every attempt | no, only for the response that is returned |
| Runs on network error | n/a | no |

`after()` does not run for network errors or timeouts, because there is no
response. Use `retryOn` to observe those, or catch the error.

## Per-attempt state is isolated

Between the interceptor run and the actual `fetch`, `Fch` snapshots the request
(method, URL, headers, body). So a mutation made by a hook is used for that
attempt and does not leak into the next one, and concurrent requests on the same
instance cannot corrupt each other.

```ts
api.before((req) => {
	req.setHeader("X-Attempt", String(++counter)); // each attempt gets its own value
});
```

## Interceptors vs `setFetchOptions`

Not everything belongs in a hook. A rule of thumb:

| Need | Use |
| --- | --- |
| Static header, method, timeout | `setHeader`, `setMethod`, `setTimeout` |
| Value that changes per attempt | `before()` |
| Refresh a token on 401 | `after()` |
| Throw on non-2xx | `after()` |
| Retry decision | `setRetryOn()` |
| Log every request | `setLogger()` / `debug: true` |

## Deprecated aliases

The original API used longer names. They moved out of the core into the
[compat plugin](plugins.md), so they cost nothing unless you ask for them:

```ts
import { compat } from "@westtrade/fch/plugins/compat";

const req = new Fch(url).use(compat());

req.addRequestInterceptor(fn);  // same as before(fn)
req.addResponseInterceptor(fn); // same as after(fn)
```

Prefer `before()` / `after()` in new code.

## Recipes

### A request id on every attempt

```ts
const api = fch.create({ baseUrl: "https://api.example.com", retries: 2 })
	.request("/orders");

api.before((req) => {
	req.setHeader("X-Request-Id", crypto.randomUUID());
});
```

### Refresh once, then retry by hand

An `after()` hook cannot retry, so refresh-and-replay belongs one level up:

```ts
async function authed<T>(run: (req: Fch) => Promise<[T, Response]>): Promise<[T, Response]> {
	try {
		return await run(api.request("/me").setAuthToken(getToken()));
	} catch (error) {
		if (!(error instanceof HttpError) || error.status !== 401) throw error;
		await refreshSession();
		return await run(api.request("/me").setAuthToken(getToken()));
	}
}
```

### Strip a response envelope once

```ts
api.after(async (response) => {
	const body = await response.clone().json();
	if (!("data" in body)) return response;

	return new Response(JSON.stringify(body.data), {
		status: response.status,
		headers: response.headers,
	});
});
```

> Rewriting bodies is fine, but it costs an extra parse and serialise per
> response. For most apps, unwrapping in the caller is cheaper and clearer.

### Time a request

`after()` receives only the `Response`, not the request, so a hook cannot pair a
start time with an end time on its own. Measure around the call:

```ts
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		return await run();
	} finally {
		console.log(label, (performance.now() - start).toFixed(0) + "ms");
	}
}

await timed("orders", () => api.get("/orders"));
```

There is no per-instance timing hook: `before()` sees the request and `after()`
sees the response, so neither can pair the two on its own. Wrap the call, as
above, when you need the number.

For most cases, `debug: true` already logs each attempt and each retry — enough
to spot a slow endpoint.
