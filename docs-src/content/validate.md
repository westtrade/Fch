# Response validation

A request can succeed on the wire and still return the wrong shape. Validation
turns that into a normal rejection, so it reaches `.catch()`, every `onError`
hook, and the [Nano Stores](nanostores.md) plugin — the same path as a network
error.

```ts
import { Fch } from "@westtrade/fch";
import { validate } from "@westtrade/fch/plugins/validate";

const [house] = await new Fch("https://api.example.com/houses/1")
	.use(
		validate({
			type: "object",
			required: ["id", "name"],
			properties: { id: { type: "integer" }, name: { type: "string" } },
		}),
	)
	.json<House>();
```

When the body does not match:

```ts
try {
	await req.json();
} catch (error) {
	if (error instanceof ValidationError) {
		error.issues; // [{ path: "id", message: "expected integer, got string" }]
		error.response; // the 200 Response that carried the bad body
	}
}
```

## Two ways to validate

### 1. A schema, no dependency

`validate({ schema })` checks a small JSON-Schema subset. That covers the common
case — "these fields, these types" — without shipping a validator.

Supported keywords: `type` (including unions and `integer`), `required`,
`properties`, `items`, `additionalProperties: false`, `enum`, `nullable`,
`minLength` / `maxLength`, `pattern`, `minimum` / `maximum`, `minItems` /
`maxItems`.

```ts
validate({
	schema: {
		type: "array",
		minItems: 1,
		items: {
			type: "object",
			required: ["id", "title"],
			properties: {
				id: { type: "integer" },
				title: { type: "string", minLength: 1 },
				tags: { type: "array", items: { type: "string" } },
			},
			additionalProperties: false,
		},
	},
});
```

Not supported on purpose: `$ref`, `oneOf`/`anyOf`/`allOf`, `dependentSchemas`,
`if`/`then`, format assertions. Those are where a hand-written subset becomes a
bug farm — use a real validator for them.

### 2. Your own validator

Pass `validate(body, response)`. It works with AJV, Zod, Valibot, or a
hand-written check.

**AJV** — return its error array; `validate()` formats AJV's `instancePath` into
a dotted path for you:

```ts
import Ajv from "ajv";
import { validate } from "@westtrade/fch/plugins/validate";

const ajv = new Ajv({ allErrors: true });
const schema = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };

const ajvValidate = validate({
	validate: (body) => ajv.validate(schema, body) || ajv.errors,
});

const [house] = await new Fch(url).use(ajvValidate).json<House>();
```

**Zod** — a throwing validator keeps its own error untouched, so `ZodError`
issues and messages survive:

```ts
import { z } from "zod";

const House = z.object({ id: z.number(), name: z.string() });

// `parse` returns the typed value or throws a ZodError, which reaches `.catch()`
// exactly as thrown — the plugin does not wrap it.
const zodValidate = validate({ validate: (body) => void House.parse(body) });

const [house] = await new Fch(url).use(zodValidate).json<z.infer<typeof House>>();
```

A returned value is interpreted as:

| Returned | Meaning |
| --- | --- |
| `undefined`, `true`, `null`, `[]` | valid |
| `false` | invalid, generic issue |
| an `Error` | invalid, its message is the issue |
| an array of issues | invalid, formatted into `issues` |
| an object of issues | invalid, `message` taken from each entry |
| a thrown error | rethrown as-is (Zod, Valibot) |

## The error

`ValidationError extends TypeError`, so a `catch` that checks for a type error
keeps working.

| Member | Value |
| --- | --- |
| `message` | `Response validation failed — path: reason` |
| `issues` | `{ path, message }[]`, path is dotted (`items.0.id`) |
| `response` | the `Response` that carried the invalid body |
| `body` | the parsed body (unless `keepBody: false`) |

`keepBody: false` keeps large bodies out of your logs.

## Skipping some responses

```ts
validate({
	schema,
	// A 204 has no body, so there is nothing to validate.
	when: (response) => response.status !== 204,
});
```

An empty body parses to `null`, so a `schema` with `required` rejects it. Use
`when` for statuses that legitimately carry nothing.

## What it costs

One extra clone and parse per request, because the plugin needs the parsed body.
That is the same work `.json()` already does, which is why validation is a plugin
and not always-on: a caller that only streams bytes should not pay for it.

## Validation vs `.after()`

An `.after()` interceptor can also reject an invalid body, and for a one-off rule
that is fine. A plugin is better when:

- the schema is reused across many requests;
- you want the parsed body, not the raw `Response` (`.after()` gets the response
  and would have to clone and parse it itself);
- several plugins must compose — validation failures then reach the store and the
  error hooks for free.

Use `.after()` when the rule is a single `if` on the status, and `validate()` when
it is about the shape of the payload.
