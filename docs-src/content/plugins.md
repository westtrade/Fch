# Plugins

A plugin attaches behaviour to a request without patching the class. It receives
the instance, may register hooks and mutate it, and is identified by a name so
attaching it twice is a no-op.

```ts
import { Fch } from "@westtrade/fch";
import { nanostores } from "@westtrade/fch/plugins/nanostores";

const req = new Fch("https://api.example.com/houses/1").use(nanostores());

await req.json(); // the plugin has been fed the lifecycle already
```

`use()` returns `this`, so it chains with everything else.

## The contract

A plugin is a plain object with a `name` and an `install` function:

```ts
interface Plugin {
	name: string;
	install(api: PluginApi): void;
}

interface PluginApi {
	request: Fch;
	state: Map<string, unknown>;
	onRequest(fn: (request: Fch) => void): void;
	onSuccess(fn: (body: unknown, response: Response) => void): void;
	onError(fn: (error: unknown) => void): void;
}
```

| Hook | When it runs | Receives |
| --- | --- | --- |
| `onRequest` | once per execution, before the first attempt | the request |
| `onSuccess` | after the body is parsed | the parsed body, the `Response` |
| `onError` | when the execution rejects | the error |

"Execution" means one caller: `await req`, `req.send()`, `req.json()`,
`req.text()`, `req.blob()`, a shortcut call like `api.get()`, or a tagged
template. Retries happen **inside** one execution, so `onRequest` fires once for
`retries: 3`, not four times.

## A first plugin: console timing

```ts
import type { Plugin } from "@westtrade/fch";

export function logging(): Plugin {
	return {
		name: "logging",
		install({ onRequest, onSuccess, onError, state }) {
			onRequest((request) => {
				state.set("started", performance.now());
				console.log("→", request.method, request.toString());
			});

			onSuccess((_body, response) => {
				const ms = performance.now() - (state.get("started") as number);
				console.log("←", response.status, `${ms.toFixed(0)}ms`);
			});

			onError((error) => {
				console.error("✗", error instanceof Error ? error.message : error);
			});
		},
	};
}

new Fch("https://api.example.com/x").use(logging()).send();
```

`state` is a `Map` scoped to one instance, so two requests on the same instance
do not share a start time by accident — set it in `onRequest`, read it in
`onSuccess`.

## Plugins that change the request

`onRequest` receives the instance, so a plugin can set headers, raise a timeout,
or change the URL before the request goes out:

```ts
export function requestId(): Plugin {
	return {
		name: "request-id",
		install({ onRequest }) {
			onRequest((request) => {
				if (!request.getHeader("X-Request-Id")) {
					request.setHeader("X-Request-Id", crypto.randomUUID());
				}
			});
		},
	};
}
```

Because it runs per execution, each request on a reused instance gets a fresh
id.

## Attaching to a whole client

`fch.create()` returns builders; attach there to cover every call:

```ts
const api = fch.create({ baseUrl: "https://api.example.com" });

const withPlugins = (path: string) =>
	api.request(path).use(requestId()).use(logging());

await withPlugins("/houses").json();
```

There is no client-wide `plugins` option yet: a plugin holds state, and sharing
one instance's state across many requests needs its own design. Wrap the builder
as above, or call `use()` explicitly.

## First-party plugins

| Plugin | What it does |
| --- | --- |
| [Nano Stores](nanostores.md) | the request becomes a store, any framework |
| [Validation](validate.md) | reject a body that breaks the contract |
| [Logger](logging.md) | console, pino or your own; quiet unless asked |
| [Compat](api.md#deprecated-aliases) | the four deprecated method aliases |

`compat()` is also the smallest real example of the pattern: it takes over names
the core no longer has, and adds nothing else.

```ts
import { compat } from "@westtrade/fch/plugins/compat";

new Fch(url).use(compat()).setRetryTimeout(500);
```

## Rules

- **Be idempotent by name.** `use()` skips a plugin whose `name` is already
  attached, but a wrapper called per request should still avoid re-adding
  listeners.
- **Do not consume the response body.** `onSuccess` receives a parsed body and
  the `Response`; the response you are given is the caller's, and its body is
  untouched. If you must read it, use the parsed `body` argument.
- **Keep hooks cheap.** They run on the request path; `onSuccess` already cost
  one clone and one parse to produce the body.
- **Do not throw from a hook.** A throwing `onSuccess` would turn a successful
  request into a failure. Catch inside the plugin.

## What plugins are for

| Need | Plugin? |
| --- | --- |
| Mirror state into a store | yes — [Nano Stores](nanostores.md) |
| Add a header to every request | yes |
| Log timings | yes |
| Retry policy | no — `setRetryOn()` |
| Response validation | yes — a hooked plugin, see [Validation](validate.md) |

Interceptors are the built-in mechanism for request/response mutation; plugins
are for behaviour that needs its own state or that should be reusable across
projects. Start with an interceptor, and reach for a plugin when you find
yourself copying the same `before`/`after` pair and a `WeakMap` into every app.
