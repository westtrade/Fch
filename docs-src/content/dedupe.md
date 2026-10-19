# Deduplication

Two components mount, both need the same user profile, both fire a request. The
browser sends two identical `GET`s, the server does the same work twice, and the
responses can even disagree if they straddle a write.

`Fch` can collapse concurrent identical requests into one:

```tabs
=== class
const req = new Fch("https://api.example.com/profile", { dedupe: true });

const [a, b] = await Promise.all([req.json(), req.json()]);
=== function
const api = fch.create({ baseUrl: "https://api.example.com", dedupe: true });

const [a, b] = await Promise.all([api.get("/profile"), api.get("/profile")]);
=== literal
// `dedupe` must be on; the literal entry has no options, so build from the class
const req = new Fch("https://api.example.com/profile", { dedupe: true });

const [a, b] = await Promise.all([req.json(), req.json()]);
```

Whichever spelling, one request goes out on the wire and both callers get their
own readable response.

That is the whole feature. The rest of this page is the rules it follows.

## Safe methods dedupe by default

With `dedupe: true`, safe methods are identified by **method + final URL**:

```ts
const req = new Fch("https://api.example.com/items?page=1", { dedupe: true });

req.json();                       // starts the request
req.json();                       // joins it
req.setSearchParams({ page: 2 });
req.json();                       // different URL -> a different request
```

Deduped: `GET`, `HEAD`, `OPTIONS`.

## Mutating methods need a key

`POST`, `PUT`, `PATCH` and `DELETE` are **never** deduped implicitly. Two
identical `POST`s are two intents, and collapsing them would silently drop a
write.

To dedupe a write, give it an identity:

```ts
const req = new Fch("https://api.example.com/orders", {
	method: "POST",
	dedupe: true,
	dedupeKey: "checkout-42",   // or a factory: () => crypto.randomUUID()
}).setJsonBody(order);

req.json();  // starts
req.json();  // joins — same key, same request
```

A factory is called **at most once per request**, so the key is stable across
retries and across callers joining the same request:

```ts
req.setDedupeKey(() => crypto.randomUUID());
```

## The key is also `Idempotency-Key`

For mutating methods, the dedupe key is sent as an `Idempotency-Key` header, so
your server can deduplicate too:

```ts
await new Fch("https://api.example.com/payments", {
	dedupe: true,
	dedupeKey: () => crypto.randomUUID(),
	method: "POST",
})
	.setJsonBody(payment)
	.send();

// POST /api/payments
// Idempotency-Key: 8f14e45f-ceea-467f-a4b4-3b1f9c2c9c1a
```

An `Idempotency-Key` you set yourself is respected and never overwritten:

```ts
req.setHeader("Idempotency-Key", existingKey);
```

The header is applied to the per-attempt snapshot, not to `this.headers`, so
reading `req.getHeader("Idempotency-Key")` afterwards still returns only what
you set explicitly.

## Each caller gets a readable response

This is the subtle part. A `Response` body can only be read once, so handing the
same object to two callers would make the second one throw
`TypeError: Body is unusable`.

`Fch` clones the response for every caller, and clones **as soon as the shared
request settles** — so a caller that joins late cannot race an earlier caller's
body read:

```ts
const req = new Fch(url, { dedupe: true });

const first = req.json();            // starts
const second = req.json();           // joins
const third = req.json();            // joins too

const [[a], [b], [c]] = await Promise.all([first, second, third]);
// all three parsed independently
```

## What is *not* deduped

- Different URLs. `?page=1` and `?page=2` are different requests.
- Different methods. A `GET` and a `HEAD` on the same URL are different.
- Sequential requests. Dedupe only applies to requests that are **in flight at
  the same time**. Once the first one settles, the next call starts a new
  request — `Fch` is not a cache.

```ts
const req = new Fch(url, { dedupe: true });

await req.json();  // request 1
await req.json();  // request 2 — the first already finished
```

If you need caching, cache the parsed result yourself:

```ts
let cached: User | null = null;

const getUser = async () => (cached ??= (await api.request("/me").json<User>())[0]);
```

## Retries are shared

Dedupe wraps the whole retry loop, not individual attempts. Everyone waiting on
an in-flight request shares its retries and its backoff:

```ts
const req = new Fch(url, {
	dedupe: true,
	retries: 3,
	retryDelay: 300,
	retryOn: (res) => !!res && res.status >= 500,
});

await Promise.all([req.json(), req.json()]); // one request, one retry sequence
```

## Aborting a shared request

`req.abort()` cancels the shared request for everyone waiting on it. That is
usually what you want — but if one component aborts, the others see the abort
too.

`clone()` does **not** join the original's in-flight request: it gets a fresh
instance with its own dedupe state, so it starts its own request. That makes it
the right tool when a caller needs independent cancellation, at the cost of a
second request:

```ts
// shared, long-lived
const shared = api.request("/profile", { dedupe: true });

// independent cancellation, own request
const mine = shared.clone();
mine.abort(); // only this caller
```

If you want both deduplication *and* independent cancellation, use one shared
instance and abort nothing — or let callers ignore the abort they did not
request:

```ts
const shared = new Fch(url, { dedupe: true });

const load = () => shared.json().catch((error) => {
	if (error.name === "AbortError") return null; // someone else cancelled
	throw error;
});
```

## Dedupe without `Fch` (what you would write)

For comparison, this is the equivalent hand-written layer:

```js
const inFlight = new Map();

function dedupe(key, run) {
	const existing = inFlight.get(key);
	if (existing) return existing.then((res) => res.clone());

	const promise = run();
	inFlight.set(key, promise);
	return promise.then(
		(res) => res.clone(),
		(err) => { throw err; },
	).finally(() => inFlight.delete(key));
}
```

Two things usually go wrong in that version: the entry is deleted before late
joiners can attach (so they miss the request), and the shared response body is
consumed by the first reader (so the second throws). `Fch` handles both.

## Recipes

### A client that dedupes everything safe

```ts
const api = fch.create({
	baseUrl: "https://api.example.com",
	dedupe: true,
	timeout: 5000,
	retries: 2,
});

// Both calls below share one request on the wire
await Promise.all([api.get("/me"), api.get("/me")]);
```

### Writes with server-side idempotency

```ts
const api = fch.create({
	baseUrl: "https://api.example.com",
	dedupe: true,
	dedupeKey: () => crypto.randomUUID(),
});

const [created] = await api.post<Order>("/orders", order);
```

### Retry-safe and dedupe-safe together

```ts
new Fch(url, {
	method: "POST",
	dedupe: true,
	dedupeKey: "import-2024-06",
	retries: 3,
	retryDelay: 500,
	retryOn: (res) => !res || res.status >= 500,
}).setJsonBody(batch);
```
