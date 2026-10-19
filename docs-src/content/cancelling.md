# Cancelling

Cancelling is where most request layers leak. You abort a request, and the retry
loop keeps sleeping, the builder is poisoned, and the next call silently
resolves with the old abort.

`Fch` separates the two concerns: `abort()` cancels what is running now, and the
builder stays usable afterwards.

## Abort in-flight work

```ts
const req = new Fch("https://api.example.com/slow", { retries: 5 });
const pending = req.send();

req.abort();               // cancels the request AND any pending retry delay

await pending.catch(() => {});
```

Three things happen at once:

1. The in-flight `fetch` is aborted.
2. A pending retry backoff sleep is aborted — it does not wait out the delay.
3. The request rejects with an `AbortError`.

## The builder survives

After `abort()`, the same instance can start a new request:

```ts
const req = new Fch("https://api.example.com/data", { retries: 5 });

const first = req.send();
req.abort();
await first.catch(() => {});

await req.send(); // a genuinely new request, with a fresh abort generation
```

That is not the usual behaviour: many clients leave the internal controller
aborted forever, so every later call fails instantly. `Fch` creates a new abort
generation per request.

`req.aborted` reports whether the *current* request was aborted or timed out,
and resets when the next request starts:

```ts
req.aborted; // true, right after abort()
await req.send();
req.aborted; // false
```

## Your own controller

Pass a `signal` and abort it yourself. This is the standard pattern for
component unmounts and route changes:

```ts
const controller = new AbortController();

const [data] = await new Fch(url, {
	signal: controller.signal,
	timeout: 5000,
}).json();

// elsewhere:
controller.abort();
```

Rules:

- Aborting your signal aborts the request **and** pending retry delays.
- Your signal is combined with the internal timeout, so either can abort.
- `req.abort()` does **not** abort your controller — you own it.

### With `fetch`'s own `AbortSignal.timeout`

```ts
await new Fch(url, { signal: AbortSignal.timeout(8000) }).send();
```

That is a **total** budget across attempts, as opposed to the per-attempt
`timeout` option. Combining both is a common pattern:

```ts
new Fch(url, {
	timeout: 3000,                  // per attempt
	retries: 3,
	signal: AbortSignal.timeout(10_000), // overall
});
```

See [Timeouts](timeouts.md) for the details.

## Distinguishing abort from failure

An abort rejects; it is not a resolved error state. Catch it and check the name:

```ts
try {
	await req.send();
} catch (error) {
	if (error instanceof DOMException && error.name === "AbortError") {
		return; // expected: the user navigated away
	}
	throw error;
}
```

| Cause | `error.name` |
| --- | --- |
| `req.abort()` | `AbortError` |
| your `signal` aborted | `AbortError` (with your reason) |
| `{ timeout }` elapsed | `TimeoutError` |

You can pass a reason, which is forwarded as the abort reason:

```ts
req.abort(new Error("user closed the dialog"));
```

## Abort is never retried

A deliberate abort is not a transient failure. `Fch` distinguishes:

- **User abort** (`req.abort()` or your signal) — never retried.
- **Timeout** — retried, because a slow attempt is a transient failure.

Without that distinction, pressing "Cancel" would start three more requests.

## Aborting a deduped request

`req.abort()` cancels the shared request for **everyone** waiting on it. A clone
gets its own dedupe state, so it starts its own request and can be cancelled
independently — at the cost of a second request:

```ts
const shared = api.request("/profile", { dedupe: true });

const mine = shared.clone(); // own request
mine.abort();                // only this caller
```

A clone does not inherit the original's `signal`, precisely so aborting one does
not cascade. See [Deduplication](dedupe.md) for the trade-off in detail.

## `poll()` and cancellation

`poll()` is an async generator that repeats a request on an interval. It stops
when its controller aborts or the instance is aborted:

```ts
const controller = new AbortController();

for await (const response of api.request("/jobs/42").poll(1000, controller)) {
	if (response instanceof Error) continue; // a failed poll yields the error

	const job = await response.json();
	if (job.done) break;

	// stop from elsewhere: controller.abort();
}
```

Two details worth knowing:

- A failed poll **yields** the error rather than throwing, so one bad poll does
  not end the loop.
- The interval is used exactly as given — it is not clamped by
  `maxRetryDelay`, because it is a poll interval, not a retry backoff.

## Fire-and-forget with `start()`

Shortcut calls and `start()` begin the request immediately. That matters for
handlers that do not await:

```ts
form.onsubmit = (e) => {
	e.preventDefault();
	api.post("/houses", e).start(); // sends now, no await needed
};
```

`start()` memoises the request, so a later `.json()` or `.send()` observes the
same one instead of starting a second:

```ts
const req = new Fch(url).start();
await req.json(); // this request
await req.send(); // still this request
```

If that eager request fails, the memo is dropped so the next call starts fresh —
a failed fire-and-forget does not poison the builder.

## Patterns

### Cancel on unmount (React)

```tsx
useEffect(() => {
	const controller = new AbortController();

	new Fch("/api/feed", { signal: controller.signal })
		.json<Feed>()
		.then(([feed]) => setFeed(feed))
		.catch((error) => {
			if (error.name !== "AbortError") setError(error);
		});

	return () => controller.abort();
}, []);
```

### Cancel a search as the user types

```ts
let current: Fch | null = null;

async function search(query: string) {
	current?.abort();

	const req = new Fch("https://api.example.com/search", { timeout: 3000 });
	req.searchParams.set("q", query);
	current = req;

	const [results] = await req.json<Result[]>().catch(() => [[]]);
	return results;
}
```

### A timeout that does not kill the retry loop

```ts
new Fch(url, {
	timeout: 2000,  // each attempt
	retries: 3,     // ...gets its own 2 seconds
});
```

### Cancel everything on a page transition

```ts
const pageController = new AbortController();

const api = fch.create({
	baseUrl: "https://api.example.com",
	signal: pageController.signal,
});

router.beforeEach(() => pageController.abort());
```
