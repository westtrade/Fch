# Reading responses

`Fch` deliberately does **not** decide that a `404` is an error. It gives you
three levels of strictness, and you pick per request.

## Level 1 — the raw `Response`

`send()` and `await req` give you exactly what `fetch` gives you:

```ts
const response = await new Fch("https://api.example.com/health").send();

response.ok;      // false for 404 and 500 — fetch semantics, unchanged
response.status;  // 404
await response.json();
```

Nothing is wrapped, nothing is inspected. If you already handle statuses
yourself, this is all you need.

## Level 2 — a parsed tuple

`.json()`, `.text()` and `.blob()` parse the body **and** return the response:

```tabs
=== class
const [data, response] = await new Fch("https://api.example.com/users/1").json<User>();
=== function
const api = fch.create({ baseUrl: "https://api.example.com" });

const [data, response] = await api.get<User>("/users/1");
=== literal
const [data, response] = await fch.get<User>`https://api.example.com/users/1`;
```

Whichever you use, the shape is the same:

```ts
data.name;        // typed as User
response.status;  // still available
response.headers.get("etag");
```

Why a tuple instead of just the body? Because the status and headers usually
matter, and throwing them away means either re-reading the response or
re-implementing the client. The body is read from a clone, so the `Response`
you receive is still readable:

```ts
const [data, response] = await req.json();
await response.text(); // works — the original body was never consumed
```

Types:

```ts
json<T = unknown>(): Promise<[T, Response]>
text(): Promise<[string, Response]>
blob(): Promise<[Blob, Response]>
```

`json()` throws a `SyntaxError` if the body is not valid JSON — the same error
`response.json()` would throw, not a custom wrapper.

## Level 3 — fail on HTTP errors

If you want axios-style behaviour ("reject on non-2xx"), add a response
interceptor. It runs once, and it is explicit:

```ts
const strict = (res: Response) => {
	if (!res.ok) throw new HttpError(res.status, res.statusText, res);
	return res;
};

const [user] = await new Fch("https://api.example.com/users/1")
	.after(strict)
	.json<User>();
```

Because `after()` is just a function, you can put the policy in one place and
reuse it:

```ts
class HttpError extends Error {
	constructor(public status: number, message: string, public response: Response) {
		super(`HTTP ${status}: ${message}`);
		this.name = "HttpError";
	}
}

const httpError = (res: Response) => {
	if (!res.ok) throw new HttpError(res.status, res.statusText, res);
	return res;
};

const api = fch.create({ baseUrl: "https://api.example.com" });
// apply to every builder the client hands out
const request = (path: string) => api.request(path).after(httpError);

await request("/users/1").json<User>();
```

> **Why not throw by default?** Because reading an error body is a normal thing
> to do: `{ error: "email_taken" }` on a `409` is data, not an exception. A
> library that throws forces you into `try/catch` to read it, which is the same
> amount of code pointing the other way. Opt in, and you get to choose the error
> type.

### Interceptor errors are never retried

If a response interceptor throws, `Fch` treats that as a logic error and stops
— it does not retry. Otherwise a throwing `after()` on a `POST` would replay the
write on every attempt.

## Reading the body twice

If you need both the parsed body and the raw bytes, use `response.clone()`
yourself on the raw path, or rely on the tuple:

```ts
const [data, response] = await req.json();

// The tuple already gives you both — no clone needed.
```

Internally `.json()`/`.text()`/`.blob()` read from a clone, so the response you
get back is untouched.

## Awaiting the object

The instance is thenable:

```ts
const response = await new Fch("https://api.example.com/data", { timeout: 3000 });
```

That is equivalent to `await req.send()`. Note the difference from the helpers:

| Expression | Resolves to |
| --- | --- |
| `await req` | `Response` |
| `await req.send()` | `Response` |
| `await req.json()` | `[parsed, Response]` |
| `await req.text()` | `[string, Response]` |
| `await req.blob()` | `[Blob, Response]` |

### Each execution is a new request

The builder is reusable, and every execution starts a fresh request:

```ts
const req = new Fch("https://api.example.com/health", { retries: 2 });

await req.send(); // request 1
await req.send(); // request 2
```

This is the opposite of a cached promise, and it is what you want for a
configured client. To share one request between readers, use `dedupe: true` or
`start()`:

```ts
const req = new Fch("https://api.example.com/profile", { dedupe: true });
const [a, b] = await Promise.all([req.json(), req.json()]); // one request on the wire
```

## Practical patterns

### Throw on error, once

```ts
const api = fch.create({ baseUrl: "https://api.example.com", timeout: 5000 });

const strict = <T>(path: string) => api.request(path).after(httpError).json<T>();

const [user] = await strict<User>("/users/1");
```

### Tolerate a 404

```ts
const [user, response] = await api.request("/users/1").json<User | null>();

if (response.status === 404) {
	return null; // a legitimate answer
}
```

### Inspect before parsing

```ts
const response = await api.request("/export").send();

if (response.headers.get("content-type")?.includes("json")) {
	return response.json();
}

return response.blob();
```

### Parse with a schema

`Fch` returns whatever `JSON.parse` produces. Validate at the boundary with your
schema library of choice:

```ts
const [raw] = await api.request("/users/1").json<unknown>();
const user = UserSchema.parse(raw); // zod, valibot, arktype, ...
```

`Fch` stays out of the validation business; there is no bundled schema
dependency.
