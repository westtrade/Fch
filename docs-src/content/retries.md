# Retries & backoff

Transient failures are normal: a dropped connection, a `503` from a load
balancer, a `429` from a rate limiter. `fetch` tries exactly once. `Fch` adds a
retry loop that is correct by default and configurable in one place.

## The short version

```tabs
=== class
const [orders] = await new Fch("https://api.example.com/orders", {
	retries: 3,        // 1 attempt + 3 retries = 4 total
	retryDelay: 500,   // base delay, ms
	maxRetryDelay: 10_000,
	retryOn: (response) => !!response && (response.status === 429 || response.status >= 500),
}).json<Order[]>();
=== function
const api = fch.create({
	baseUrl: "https://api.example.com",
	retries: 3,
	retryDelay: 500,
	maxRetryDelay: 10_000,
	retryOn: (response) => !!response && (response.status === 429 || response.status >= 500),
});

const [orders] = await api.get<Order[]>("/orders");
=== literal
// a literal starts immediately, so retry options set afterwards do not apply to
// it: build the request from the class when retries matter
const [orders] = await new Fch("https://api.example.com/orders", {
	retries: 3,
	retryDelay: 500,
	maxRetryDelay: 10_000,
	retryOn: (response) => !!response && (response.status === 429 || response.status >= 500),
}).json<Order[]>();
```

With those settings the delays before each retry are roughly:

| Retry | Delay (before jitter) |
| --- | --- |
| 1st | 500 ms |
| 2nd | 1000 ms |
| 3rd | 2000 ms |

Each delay is then jittered by ±20% and capped at `maxRetryDelay`.

## Counting attempts

`retries` counts retries, not attempts:

| `retries` | Total attempts |
| --- | --- |
| `0` (default) | 1 |
| `1` | 2 |
| `3` | 4 |

The default is `0`: **`Fch` never retries unless you ask.** Retrying by default
is how `POST` requests get duplicated.

## What gets retried by default

| Failure | Retried by default? |
| --- | --- |
| Network error (`TypeError: Failed to fetch`) | Yes, if `retries > 0` |
| Timeout (`TimeoutError`) | Yes, if `retries > 0` |
| HTTP 4xx / 5xx | **No** — a response is not an error to `fetch` |
| Your own `abort()` | Never |
| An external `AbortSignal` abort | Never |
| A throwing response interceptor | Never |
| A `ReadableStream` body with `retries > 0` | Throws a `TypeError` |

HTTP statuses need an explicit policy, because whether a `500` on a `POST` is
safe to retry is a business decision, not a library default.

## The `retryOn` predicate

One function decides for both responses and errors:

```ts
req.setRetryOn((response, error, attempt) => {
	// HTTP response: error is null
	if (response) {
		return response.status === 429 || response.status >= 500;
	}

	// Network or timeout error: response is null
	if (error instanceof DOMException && error.name === "AbortError") return false;

	return attempt < 3;
});
```

- `response` is the `Response` when an HTTP response arrived, otherwise `null`.
- `error` is the thrown value when the attempt failed, otherwise `null`.
- `attempt` is 1-based: `1` is the first attempt.

Return `true` to retry, `false` to stop. When you return `false`, the response
is returned (for HTTP) or the error is thrown (for network failures).

### Respect `Retry-After`

A server that says how long to wait should be obeyed:

```ts
req.setRetryOn((response, error, attempt) => {
	if (!response) return attempt < 3;
	if (response.status !== 429) return response.status >= 500;

	const after = Number(response.headers.get("Retry-After"));
	if (Number.isFinite(after)) {
		// Fch has no per-attempt delay override; schedule it yourself:
		// see "Custom delay" below.
	}
	return attempt < 3;
});
```

If you need the header to control the wait, use the async form below.

### Retry only idempotent methods

`retryOn` does not receive the method, so put the check where you build the
request:

```ts
const idempotent = (method: string) => ["GET", "HEAD", "PUT", "DELETE"].includes(method);

const req = new Fch(url, {
	retries: idempotent("POST") ? 0 : 3,
	retryOn: (response) => !!response && response.status >= 500,
});
```

## Custom delay

`retryDelay` is a number, and the backoff formula is fixed:
`min(maxRetryDelay, retryDelay * 2^(attempt-1))`, plus ±20% jitter.

If you need a different curve (respecting `Retry-After`, for example), retry
outside the library and let `Fch` handle one attempt:

```ts
async function withRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= attempts) throw error;
			const wait = 500 * 2 ** (attempt - 1);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
}

await withRetry(() => new Fch(url, { retries: 0 }).json());
```

The built-in loop covers the common case; this covers the rest without adding
configuration surface.

## Why jitter

Without jitter, every client that failed at the same moment retries at the same
moment — a thundering herd that turns a small outage into a big one. `Fch`
applies ±20% jitter around the capped exponential delay, so a fleet spreads out.

The cap applies **before** jitter, so an actual wait can exceed `maxRetryDelay`
by up to 20%. That is intentional: clamping after jitter would defeat the point.

## Aborts are never retried

```ts
const req = new Fch("https://api.example.com/slow", { retries: 5 });
const pending = req.send();

req.abort();

await pending.catch(() => {}); // AbortError, immediately — no retries
```

Three things are distinguished:

1. **`req.abort()`** — a user abort. Never retried.
2. **An external `signal`** you passed in — the caller's abort. Never retried.
3. **The per-attempt timeout** — not a user abort. It *is* retried, because a
   slow attempt is exactly the transient failure retries are for.

That distinction is why `Fch` combines your signal with its own timeout signal
rather than reusing one controller for both.

## Retries and dedupe together

Deduplication wraps the whole retry loop, not individual attempts. Two callers
sharing an in-flight request share its retries too — there is one logical
request on the wire, with its own backoff:

```ts
const req = new Fch("https://api.example.com/profile", {
	dedupe: true,
	retries: 3,
	retryDelay: 300,
});

// One request (and one retry sequence), two independent readable responses.
const [a, b] = await Promise.all([req.json(), req.json()]);
```

## Retries and `Idempotency-Key`

For writes, pair retries with an idempotency key so the server can deduplicate
too:

```ts
const req = new Fch("https://api.example.com/orders", {
	retries: 2,
	method: "POST",
	dedupeKey: () => crypto.randomUUID(), // sent as Idempotency-Key
}).setJsonBody(order);

await req.send();
```

The key is resolved **at most once per request**, so every retry of the same
logical request carries the same key — otherwise the server would see three
different writes.

## Logging what happened

```ts
const req = new Fch(url, { retries: 3, debug: true });
```

With debug logging on, each attempt logs its URL, each retry logs the status
that triggered it, and each failure logs the attempt number:

```text
[INFO] Making request to https://api.example.com/orders with method GET
[WARN] Retry triggered for status 503
[INFO] Making request to https://api.example.com/orders with method GET
[INFO] Received response with status 200
```

## Recipes

### Aggressive retry for a flaky upstream

```ts
new Fch(url, {
	retries: 5,
	retryDelay: 200,
	maxRetryDelay: 5_000,
	retryOn: (res) => !res || res.status >= 500 || res.status === 429,
});
```

### Never retry a payment

```ts
new Fch("/payments", { retries: 0 }).setMethod("POST").setJsonBody(payment);
```

### Retry only network failures

```ts
new Fch(url, { retries: 3 }); // no retryOn: only thrown errors retry
```

### Retry a rate limit, but give up fast

```ts
new Fch(url, {
	retries: 2,
	retryDelay: 1_000,
	retryOn: (res) => !!res && res.status === 429,
});
```
