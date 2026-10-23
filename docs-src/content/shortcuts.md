# Shorthand API

`fch.create()` builds a small client with shared defaults and axios-style
shortcut methods. Unlike the builder, **shortcut calls start their request
immediately** — so they work in fire-and-forget handlers without `await`.

```ts
import { fch } from "@westtrade/fch";

const api = fch.create({
	baseUrl: "https://api.example.com",
	timeout: 5_000,
	retries: 2,
	headers: { Accept: "application/json" },
});

const [houses] = await api.get<House[]>("/houses");
```

## Methods

| Method | Second argument |
| --- | --- |
| `api.get(url, options?)` | options |
| `api.head(url, options?)` | options |
| `api.delete(url, options?)` | options |
| `api.post(url, body?, encoding?, options?)` | body, then optional encoding, then options |
| `api.put(url, body?, encoding?, options?)` | body, then optional encoding, then options |
| `api.patch(url, body?, encoding?, options?)` | body, then optional encoding, then options |
| `api.request(url, options?)` | returns a builder |

The asymmetry is deliberate: `get`, `head` and `delete` take **options** as
their second argument. A `DELETE` payload is rare, and treating the second
argument as a body would silently send `{"timeout":5000}` upstream. For a
`DELETE` body, use the builder:

```ts
api.request("/houses/1").setMethod("DELETE").setJsonBody({ reason: "duplicate" });
```

## Encoding the body

A plain object does not say which wire format it wants, so the third argument
picks one. **JSON is the default**, which is why most calls need nothing there.

```ts
api.post("/houses", { name: "Cottage" });                              // JSON
api.post("/houses", { name: "Cottage" }, "json");                      // same
api.post("/houses", { name: "Cottage" }, "urlencoded");                // a=1&b=2
api.post("/houses", { name: "Cottage", rooms: 3 }, "form");            // multipart
api.post("/login", "user=ann", "text");                                // text/plain
```

| Encoding | `Content-Type` | Body |
| --- | --- | --- |
| `'json'` (default) | `application/json` | `JSON.stringify(body)` |
| `'urlencoded'` | `application/x-www-form-urlencoded` | `URLSearchParams` |
| `'form'` | `multipart/form-data; boundary=…` | `FormData` |
| `'text'` | `text/plain` | `String(body)` |
| `'raw'` | none — you set it | body passed through untouched |

The MIME names work too, so you can reuse a header value you already have:

```ts
api.post("/houses", data, "application/x-www-form-urlencoded");
api.post("/houses", data, "multipart/form-data");
```

An array value repeats the key, which is what a form does:

```ts
api.post("/houses", { tag: ["a", "b"] }, "urlencoded"); // tag=a&tag=b
```

Options still go last, and still work without an encoding:

```ts
api.post("/houses", body, "urlencoded", { retries: 2 });
api.post("/houses", body, { retries: 2 });
```

A `<form>` element or `FormData` already declares its own encoding, so the
argument is ignored there — the form wins.


## Bodies are inferred

The shortcut inspects what you pass:

```ts
api.post("/houses", { name: "Cottage" });  // object  -> JSON + Content-Type: application/json
api.post("/houses", form);                  // <form>  -> FormData, boundary left to the browser
api.post("/houses", event);                 // Event   -> FormData via the form it targets
api.post("/houses", new FormData(form));    // FormData -> sent as-is
api.put("/houses/1", new Blob([png]));      // binary  -> untouched
api.post("/upload", stream);                // stream  -> duplex: "half" set for you
```

Arrays are JSON-encoded too:

```ts
api.post("/batch", [{ id: 1 }, { id: 2 }]); // JSON array
```

## Each call resolves to a tuple

```ts
const [houses, response] = await api.get<House[]>("/houses");

houses;            // House[]
response.status;   // 200
```

The body is parsed by content type: JSON when the server says
`application/json`, text otherwise. An empty JSON body parses to `null`; an
empty body without a JSON content type parses to `""`.

The returned value is also a promise with helpers attached, so you can pick a
different reader:

```ts
const call = api.get("/report.pdf");
const [blob] = await call.blob();
const [text] = await call.text();
const response = await call.send();
```

All of these read the **same** request — the call was started once, and the
helpers share it.

## Fire and forget

This is the reason shortcut calls start eagerly. No `await`, no floating
promise, no "the request never happened because nobody awaited the promise":

```ts
form.onsubmit = (e) => {
	e.preventDefault();
	api.post("/houses", e); // sends now
};
```

A failed call does not surface as an unhandled rejection; if you care about the
outcome, await it or attach a `.catch()`.

## Per-call options

Options passed to a call override the client defaults:

```ts
const api = fch.create({ baseUrl: "https://api.example.com", timeout: 5000 });

await api.get("/slow-report", { timeout: 60_000 }); // just this call
await api.post("/houses", house, { retries: 0 });  // just this call
```

Headers merge rather than replace, so shared headers survive:

```ts
const api = fch.create({
	baseUrl: "https://api.example.com",
	headers: { Authorization: `Bearer ${token}` },
});

await api.get("/me", { headers: { "X-Trace-Id": "abc" } });
// sends both
```

## Getting a builder back

`api.request(url, options?)` returns a builder with the same defaults. Pass the
options as the second argument rather than chaining, so a one-off override stays
one line:

```ts
const [house] = await api.request("/houses/1", { retries: 5 }).json<House>();
```

Setters are for what options cannot express — an interceptor, a `DELETE` body,
or `poll()`:

```ts
const req = api.request("/houses", { dedupeKey: () => crypto.randomUUID() })
	.after(httpError)
	.setJsonBody(house);

await req.send();
```

`api.request()` applies the same defaults, including `baseUrl`. Per-call options
merge over them, and headers merge rather than replace:

```ts
const api = fch.create({ baseUrl: "https://api.example.com", timeout: 5000 });

api.request("/slow", { timeout: 60_000 });          // this call only
api.request("/x", { headers: { "X-Trace": "1" } }); // shared auth header survives
```

## Base URL handling

```ts
const api = fch.create({ baseUrl: "https://api.example.com/v1" });

api.request("/houses").toString();  // "https://api.example.com/v1/houses"
api.request("houses").toString();   // "https://api.example.com/v1/houses"
api.request("https://other.example/x").toString(); // absolute wins
```

The base must be absolute. A relative one throws immediately with an
explanation, instead of failing later inside `new URL()`:

```ts
fch.create({ baseUrl: "/api" });
// TypeError: Fch requires an absolute `baseUrl`, got "/api".
//   Pass a full URL, e.g. fch.create({ baseUrl: 'https://api.example.com' })
```

`baseURL` (capital URL) is accepted as an alias, for axios familiarity.

## The factory without `create()`

The default export is a factory that makes one-off builders:

```ts
import fch, { Fch } from "@westtrade/fch";

const req = fch("https://api.example.com/users");     // same as new Fch(...)
const api = fch.create({ baseUrl: "https://api.example.com" });
```

`fch` and `Fch` are interchangeable for construction; the factory is just
shorter. The factory also carries `.create()`.

## Recipes

### A typed API wrapper

```ts
import { fch } from "@westtrade/fch";

const api = fch.create({
	baseUrl: "https://api.example.com",
	timeout: 5000,
	retries: 2,
	headers: { Accept: "application/json" },
});

const httpError = (res: Response) => {
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res;
};

export const getHouse = (id: number) =>
	api.request(`/houses/${id}`).after(httpError).json<House>();

export const createHouse = (input: HouseInput) =>
	api.post<House>("/houses", input);
```

### Login once, reuse the token

```ts
const api = fch.create({ baseUrl: "https://api.example.com" });

const [session] = await api.post<Session>("/login", credentials);
api.request("/me", { headers: { Authorization: `Bearer ${session.token}` } }).json<User>();
```

Since `create()` defaults are read per call, a token that changes needs to be
injected per request — pass it as a header, or wrap it in a helper:

```ts
const authed = <T>(path: string) =>
	api.request(path, { headers: { Authorization: `Bearer ${getToken()}` } }).json<T>();
```

### Fire-and-forget analytics

```ts
button.addEventListener("click", () => {
	api.post("/events", { type: "click", id: button.id }); // no await needed
});
```
