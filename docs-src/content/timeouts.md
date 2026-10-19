# Timeouts

`fetch` has no timeout option. It waits until the connection fails, which on a
stalled socket can be never. `Fch` gives you one, per attempt.

## The short version

```tabs
=== class
const [data] = await new Fch("https://api.example.com/slow", { timeout: 5000 }).json();
=== function
const api = fch.create({ baseUrl: "https://api.example.com", timeout: 5000 });

const [data] = await api.get("/slow");
=== literal
// a literal starts immediately with the default timeout (30 s); to change it,
// build from the class or pass it to a client
const [data] = await new Fch("https://api.example.com/slow", { timeout: 5000 }).json();
```

If the attempt does not produce a response within 5 seconds, it is aborted with
a `DOMException` named `TimeoutError`:

```ts
try {
	await new Fch("https://api.example.com/slow", { timeout: 5000 }).send();
} catch (error) {
	if (error instanceof DOMException && error.name === "TimeoutError") {
		// the attempt timed out
	}
}
```

## Per attempt, not per request

The timeout applies to **each attempt**, independently of the retry loop. With
`retries: 2` and `timeout: 1000`, you get up to three attempts of up to one
second each — not a single one-second budget for all of them:

```ts
new Fch(url, { timeout: 1000, retries: 2, retryDelay: 100 });
// worst case: ~1s + 100ms + 1s + 200ms + 1s
```

That is the behaviour you want: a slow attempt is exactly the transient failure
retries exist for. If you need a total budget, see "A total deadline" below.

A timeout **is** retried (unlike a user abort), because the request never
completed. See [Retries & backoff](retries.md).

## The default

```ts
new Fch(url).timeout; // 30000 — 30 seconds
```

30 seconds is the default because it is long enough for a slow legitimate
request and short enough that a hung socket does not pin a connection forever.

To disable it entirely:

```ts
new Fch(url, { timeout: 0 }).timeout; // 0 means "no timeout"
```

`setTimeout(0)` does the same thing. Negative or non-finite values throw:

```ts
new Fch(url).setTimeout(-1);       // Error: Invalid timeout: -1
new Fch(url).setTimeout(Infinity); // Error: Invalid timeout: Infinity
```

## Combining with your own signal

Your `AbortSignal` and the internal timeout are combined, so either one aborts
the attempt:

```ts
const controller = new AbortController();
button.onclick = () => controller.abort();

const [data] = await new Fch(url, {
	timeout: 5000,
	signal: controller.signal,
}).json();
```

`Fch` uses `AbortSignal.any()` where available and wires the signals by hand
otherwise, unhooking the listeners once the attempt settles so a long-lived
client does not accumulate them.

Two rules that follow from this:

- Aborting your controller aborts the request **and** any pending retry delay.
- `req.abort()` does **not** abort your controller — it is yours to own.

## Distinguishing a timeout from an abort

Both surface as a `DOMException`, but the names differ:

| Cause | `error.name` |
| --- | --- |
| `{ timeout: n }` elapsed | `TimeoutError` |
| `req.abort()` | `AbortError` |
| your `signal` aborted | `AbortError` (with your reason) |

```ts
try {
	await req.send();
} catch (error) {
	if (error instanceof DOMException) {
		if (error.name === "TimeoutError") return retryLater();
		if (error.name === "AbortError") return; // user navigated away
	}
	throw error;
}
```

The instance also exposes `req.aborted`, which is `true` if the current request
was aborted by you **or** timed out:

```ts
const req = new Fch(url, { timeout: 100 });

await req.send().catch(() => {});
req.aborted; // true

// The flag is reset when the next request starts:
await req.setTimeout(5000).send();
req.aborted; // false
```

## A total deadline

`Fch` has no "total budget across retries" option, because that is one line with
an abort signal:

```ts
const deadline = AbortSignal.timeout(8000); // total budget

const [data] = await new Fch(url, {
	timeout: 3000,     // per attempt
	retries: 3,
	signal: deadline,  // stops everything after 8s
}).json();
```

When the deadline fires, the whole request rejects — including a pending retry
delay, which is aborted rather than slept through.

`AbortSignal.timeout` is available in all modern runtimes. If you need to
support an older one, the equivalent is:

```ts
const controller = new AbortController();
const id = setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), 8000);
try {
	// ...
} finally {
	clearTimeout(id);
}
```

## Timeouts and streams

The timeout covers **getting the response**, which for a streamed response means
the response headers. Reading the body afterwards is not bounded by it:

```ts
const response = await new Fch(url, { timeout: 1000 }).send();
// headers arrived in time; reading the body can still be slow
await response.text();
```

That is the same boundary `fetch` draws. To bound the read, race it yourself or
use the response's own signal support where available.

## Timeouts and uploads

A large upload on a slow connection can legitimately take longer than the
timeout. Raise it for that request rather than disabling it globally:

```ts
await new Fch("/upload", { timeout: 120_000 }).setBody(file).send();
```

## Recipes

### Interactive UI: fail fast, retry a little

```ts
const api = fch.create({
	baseUrl: "https://api.example.com",
	timeout: 3000,
	retries: 1,
	retryDelay: 200,
});
```

### Background sync: patient

```ts
const sync = fch.create({
	baseUrl: "https://api.example.com",
	timeout: 30_000,
	retries: 4,
	retryDelay: 1000,
	maxRetryDelay: 30_000,
});
```

### Health check: short, no retries

```ts
new Fch("https://api.example.com/health", { timeout: 500, retries: 0 });
```

### Never hang a page load

```ts
const [config] = await new Fch("/config.json", {
	timeout: 2000,
	retries: 0,
}).json<Config>();
```
