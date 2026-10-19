# Polling

`poll()` repeats a request on an interval and yields each result. It is an async
generator, so you consume it with `for await` and stop it by aborting:

```ts
const controller = new AbortController();

for await (const result of api.request("/jobs/42").poll(1000, controller)) {
	if (result instanceof Error) continue; // a failed poll is yielded, not thrown

	const job = await result.json();
	if (job.done) break;

	// stop from anywhere: controller.abort();
}
```

Two arguments: the interval in ms (default `300`) and a controller.

## Which controller stops what

`poll()` **owns its own stop signal** when you omit the controller. `abort()`
still stops a running poll — it is wired to the instance's current abort
generation — but a poll started *after* an `abort()` runs normally, because the
builder stays usable.

That distinction matters because `abort()` is permanent for the request in
flight:

```ts
req.abort();                       // stops whatever is running now
await req.poll(1000);              // still works: a fresh stop signal
```

Pass your own controller when the poll's lifetime is not the request's — a
component unmount, a route change, a deadline:

```ts
const controller = new AbortController();
onUnmount(() => controller.abort());

for await (const result of req.poll(2000, controller)) { … }
```

Prefer an explicit controller whenever the instance might also send other
requests: `req.abort()` cancels **everything on that instance**, so a shared
instance means a shared cancel.

> **Earlier behaviour:** poll defaulted to `this.controller`, which `abort()`
> aborts permanently. A poll started after an `abort()` then produced an empty
> generator with no error — it looked like "no results yet" forever. Fixed;
> a poll now always owns its stop signal unless you pass one.

## Every iteration is a new request

A `Fch` instance is a builder, and polling is the clearest case: each iteration
calls `fetch` again. `poll()` deliberately ignores the eager request that
`start()` and the shortcut API memoise — otherwise every iteration would resolve
to the same response forever.

That also means each iteration is a **full execution**: plugin hooks, the UI
timers and the [Nano Stores](nanostores.md) plugin all see every poll.

```ts
const req = new Fch("https://api.example.com/jobs/42").use(nanostores());

req.subscribe((state) => render(state)); // updates on every poll

for await (const response of req.poll(2000, controller)) {
	if (state.done) break;
}
```

## Failures are yielded, not thrown

A thrown error would end the loop. Instead, a failed attempt is yielded as an
`Error`, so one bad poll does not kill a long-running loop:

```ts
for await (const result of req.poll(1000, controller)) {
	if (result instanceof Error) {
		// network down, timeout, or validation failure — keep going or break
		continue;
	}
	handle(await result.json());
}
```

Retries still apply **inside** one iteration: with `retries: 2`, a failing poll
makes up to three attempts before yielding the error.

## The interval is exact

The poll delay is not the retry backoff, so it is not clamped by
`maxRetryDelay`:

```ts
// sleeps 60 s between polls, even though maxRetryDelay is 1 s
new Fch(url, { maxRetryDelay: 1000 }).poll(60_000);
```

Aborting during the sleep ends the generator cleanly — a rejected sleep is a
deliberate stop, not a failure.

## When not to use it

`poll()` is for "ask again later" endpoints. It is **not**:

- **Server-Sent Events.** Use `EventSource`; a polled request cannot stream.
- **Pagination.** Polling repeats the same request; paging moves through
  results.
- **A substitute for a real-time channel.** Polling at 200 ms is worse for both
  the server and the client than a websocket or SSE.

It is right for job status, deployment progress, cache warm-up, and anything
where the server has no way to push.

## Recipes

### Wait for a job to finish

```ts
const controller = new AbortController();

for await (const result of api.request(`/jobs/${id}`).poll(1500, controller)) {
	if (result instanceof Error) continue;

	const job = await result.json<{ status: string }>();
	if (job.status === "done" || job.status === "failed") {
		controller.abort();
		return job;
	}
}
```

### Stop after a timeout

```ts
const deadline = AbortSignal.timeout(60_000);
const controller = new AbortController();
deadline.addEventListener("abort", () => controller.abort());

for await (const result of api.request("/deploy/42").poll(2000, controller)) {
	if (result instanceof Error) continue;
	if ((await result.clone().json()).ready) break;
}
```

### Poll while a component is mounted

```ts
onMount(() => {
	const controller = new AbortController();

	(async () => {
		for await (const result of api.request("/feed").poll(5000, controller)) {
			if (result instanceof Error) continue;
			render(await result.json());
		}
	})();

	return () => controller.abort();
});
```
