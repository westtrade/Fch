# Logging

Logging is a plugin. The core only emits semantic events, so a request without
the plugin pays nothing for logging and prints nothing.

```ts
import { logger } from "@westtrade/fch/plugins/logger";

const req = new Fch("https://api.example.com/orders", { retries: 2 })
	.use(logger({ debug: true }));
```

It is quiet by default: `warn` and `error` always emit, `info` and `debug` need
`debug: true`.

## Why a plugin

Twelve log calls sat inside the retry loop and cost every user ~1.1 kB of core
they never used. Now the core calls `emit('retry', status)` and the plugin
decides the level, the wording, and whether to print at all.

Without the plugin, logging is a no-op — no console noise, no crash.

## Configure

```ts
// a custom logger
req.use(logger({ logger: pinoLogger, debug: true }));

// or console with the default [LEVEL] prefixes
req.use(logger({ debug: true }));
```

The plugin adds the same four methods the core used to have, so existing call
sites keep working:

```ts
req.enableLogging();  // debug: true
req.disableLogging(); // debug: false
req.setLogger(pinoLogger);
req.getLogger().info("…");
```

`consoleLogger()` is exported for when you want the default implementation to
wrap yourself.

## What gets logged

| Level | When | Emitted |
| --- | --- | --- |
| `info` | before each attempt, and on a successful response | only with `debug: true` |
| `warn` | a retry was triggered | always |
| `error` | an attempt failed, a response interceptor threw | always |
| `debug` | a deduped request joined an in-flight one, a caught error | only with `debug: true` |

A retried request with `debug: true` looks like this:

```text
[INFO] Making request to https://api.example.com/orders with method GET
[WARN] Retry triggered for status 503
[INFO] Making request to https://api.example.com/orders with method GET
[INFO] Received response with status 200
```

`warn` and `error` are deliberately not gated by `debug`: diagnostics should not
depend on a flag being flipped. `info` and `debug` are chatty, so they are.

## The logger interface

```ts
interface Logger {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	debug?(...args: unknown[]): void; // optional
}
```

Pass your own:

```ts
const req = new Fch(url, {
	logger: {
		info: (...args) => console.info("[http]", ...args),
		warn: (...args) => console.warn("[http]", ...args),
		error: (...args) => console.error("[http]", ...args),
		debug: (...args) => console.debug("[http]", ...args),
	},
});
```

The logger is validated: an object missing `info`, `warn` or `error` falls back
to the default logger instead of silently swallowing every line.

`debug` is optional. If you omit it, debug lines are dropped — which is why
`debug: true` with a logger that has no `debug` method produces nothing at that
level.

### Swap it later

```ts
req.setLogger(myLogger);
req.getLogger(); // a logger proxy that routes through the instance
```

`getLogger()` returns a logger whose methods go through the instance's own
gating, so handing it to a child library keeps the same rules:

```ts
const log = req.getLogger();
log.debug("something"); // only prints when debug is enabled
```

## A structured logger

Because the interface is four functions, wiring a real logger is a few lines:

```ts
import pino from "pino";

const base = pino();

const req = new Fch(url, {
	logger: {
		info: (msg, ...rest) => base.info({ msg, rest }),
		warn: (msg, ...rest) => base.warn({ msg, rest }),
		error: (msg, ...rest) => base.error({ msg, rest }),
		debug: (msg, ...rest) => base.debug({ msg, rest }),
	},
});
```

For browser devtools, the default logger already uses `console.log`,
`console.warn`, `console.error` and `console.debug` with a level prefix, so
filtering by `[ERROR]` or `[WARN]` in the console works out of the box.

## Silence it

To keep `warn`/`error` but drop everything else, leave `debug` off:

```ts
new Fch(url, { retries: 3 }); // info/debug silent, retries still logged as warn
```

To silence everything, pass no-op functions:

```ts
const silent = { info() {}, warn() {}, error() {}, debug() {} };
new Fch(url, { logger: silent });
```

That is useful in tests, where a deliberate failure would otherwise print an
`[ERROR]` line per attempt.

## Tests

```ts
const lines: string[] = [];

const req = new Fch("https://api.example.com/x", {
	retries: 2,
	retryDelay: 1,
	logger: {
		info: (msg) => lines.push(String(msg)),
		warn: (msg) => lines.push(String(msg)),
		error: (msg) => lines.push(String(msg)),
		debug: () => {},
	},
});

await req.send();
expect(lines.some((l) => l.includes("Retry triggered"))).toBe(true);
```

## What is not logged

- **Headers and bodies.** `Fch` never logs either, so a token in an
  `Authorization` header cannot leak into your logs through the library.
  Request URLs are logged, so be careful with secrets in query strings.
- **Response bodies.** Only the status is logged.
- **Timing.** There is no built-in duration metric; a `before`/`after` pair
  gives you one in a few lines (see [Interceptors](hooks.md)).
