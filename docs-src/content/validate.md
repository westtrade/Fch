# Validation

Validate either side of the request:

- **`'formData'`** — the request body, checked **before** it is sent. An invalid
  form never reaches the network.
- **`'response'`** — the parsed reply, checked after it arrives. A request can
  succeed on the wire and still return the wrong shape.

Both turn a mismatch into a normal rejection, so it reaches `.catch()`, every
`onError` hook, and the [Nano Stores](nanostores.md) plugin — the same path as a
network error.

```ts
validate(rules)                     // formData — the default
use(validate('formData', rules));   // explicit, same thing
use(validate('response', rules));   // the reply, after it arrives
```

**The default is `'formData'`**, because validating a form before it is sent is
the more common case: it stops bad data at the network boundary.

> **Careful with a JSON body.** `'formData'` has nothing to check on a JSON or
> binary payload, so it **skips** rather than fails. With the
> [logger](logging.md) attached, that skip is printed:
>
> ```text
> [WARN] validate('formData') skipped: no form body on https://api.example.com/x
> ```
>
> If you meant to validate a reply, say so: `validate('response', rules)`.

Need both? Attach both. Each target registers as a separate plugin
(`validate:formData`, `validate:response`), so two `use()` calls coexist.

```ts
const req = new Fch("https://api.example.com/houses", { method: "POST" })
	.use(validate("formData", { schema: formRules }))
	.use(validate("response", { schema: houseSchema }));
```

A bare `validate(rules)` means `'formData'`. Pass the target explicitly whenever
the intent is not obvious, especially for `'response'`.

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

## Validating FormData

The body is checked in `onRequest`, which runs before the first attempt — so an
invalid form never reaches the network, and a retry cannot slip past it.

```ts
const [created] = await new Fch("https://api.example.com/houses", { method: "POST" })
	.use(
		validate("formData", {
			schema: {
				type: "object",
				required: ["name", "rooms"],
				properties: {
					name: { type: "string", minLength: 1, maxLength: 80 },
					rooms: { type: "string", pattern: "^[0-9]+$" },
				},
			},
		}),
	)
	.setFormData("#new-house")
	.json<House>();
```

Browser form values are **strings**, even for `<input type="number">`, so use
`pattern` or convert in a custom validator rather than `type: "number"`:

```ts
validate("formData", {
	validate: (fields) => {
		const rooms = Number(fields.rooms);
		if (!Number.isInteger(rooms) || rooms < 1) {
			throw new TypeError("rooms: expected a positive integer");
		}
	},
});
```

### What a validator receives

`FormData` is flattened into a plain object:

| Field | Value |
| --- | --- |
| text input, `<select>`, checkbox | `string` |
| repeated names | the **last** value wins |
| file input | `{ name, size, type }` — metadata, not bytes |

Files are described rather than passed, because a schema cannot meaningfully
compare bytes. Check `name`/`size`/`type` to assert that a file was attached.

The failure differs from a response failure in one way:

```ts
error.target;   // 'formData'
error.response; // undefined — nothing was sent, so there is no response
error.body;     // { rooms: 'abc' }
error.message;  // 'FormData validation failed — city: is required'
```

A request **without** a form body (a JSON or binary payload) is skipped, not
failed: there is nothing to check field by field.

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
| `message` | `FormData validation failed — path: reason` or `Response …` |
| `issues` | `{ path, message }[]`, path is dotted (`items.0.id`) |
| `target` | `'formData'` or `'response'` |
| `response` | the `Response`; `undefined` for a form failure |
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
