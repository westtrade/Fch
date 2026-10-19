import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Fch } from "../src/Fch";
import { validate, checkSchema, ValidationError } from "../src/plugins/validate";

// Response validation: an invalid body must reject like any other failure,
// reach `onError`, and never look like a successful request.

let realFetch: typeof fetch;

const json = (body: unknown, status = 200) =>
	(async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const houseSchema = {
	type: "object",
	required: ["id", "name"],
	properties: {
		id: { type: "integer" },
		name: { type: "string", minLength: 1 },
	},
	additionalProperties: false,
} as const;

describe("validate plugin", () => {
	test("a valid body passes and is returned untouched", async () => {
		globalThis.fetch = json({ id: 1, name: "Ann" });

		const [house] = await new Fch("https://api.example.com/x")
			.use(validate('response', { schema: houseSchema }))
			.json<{ id: number; name: string }>();

		expect(house).toEqual({ id: 1, name: "Ann" });
	});

	test("an invalid body rejects with ValidationError and issues", async () => {
		globalThis.fetch = json({ id: "nope", extra: true });

		const error = await new Fch("https://api.example.com/x")
			.use(validate('response', { schema: houseSchema }))
			.json()
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ValidationError);
		// Extends TypeError, so existing type checks keep working.
		expect(error).toBeInstanceOf(TypeError);
		expect((error as ValidationError).issues).toEqual(
			expect.arrayContaining([
				{ path: "name", message: "is required" },
				{ path: "id", message: "expected integer, got string" },
				{ path: "extra", message: "is not allowed" },
			]),
		);
	});

	test("the message names the first problem", async () => {
		globalThis.fetch = json({});
		const error = (await new Fch("https://api.example.com/x")
			.use(validate('response', { schema: houseSchema }))
			.json()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.message).toContain("Response validation failed");
		// The body is `{}`, so both required keys are missing; the message names
		// the first issue in schema order.
		expect(error.message).toMatch(/first: (id|name): is required/);
	});

	test("the raw response and body are on the error", async () => {
		globalThis.fetch = json({ id: 1 });
		const error = (await new Fch("https://api.example.com/x")
			.use(validate('response', { schema: houseSchema }))
			.json()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.response.status).toBe(200);
		expect(error.body).toEqual({ id: 1 });
	});

	test("keepBody: false omits the body from the error", async () => {
		globalThis.fetch = json({ id: 1 });
		const error = (await new Fch("https://api.example.com/x")
			.use(validate('response', { schema: houseSchema, keepBody: false }))
			.json()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.body).toBeUndefined();
	});

	test("a validation failure reaches onError", async () => {
		globalThis.fetch = json({ id: "x" });

		let seen: unknown = null;
		const probe = {
			name: "probe",
			install({ onError }: { onError: (fn: (e: unknown) => void) => void }) {
				onError((e) => (seen = e));
			},
		};

		await new Fch("https://api.example.com/x")
			.use(probe as never)
			.use(validate('response', { schema: houseSchema }))
			.json()
			.catch(() => {});

		expect(seen).toBeInstanceOf(ValidationError);
	});

	test("a throwing validator surfaces its own error unchanged", async () => {
		globalThis.fetch = json({ id: 1, name: "Ann" });

		class ZodLike extends Error {}

		const error = await new Fch("https://api.example.com/x")
			.use(
				validate('response', {
					validate: () => {
						throw new ZodLike("name: Required");
					},
				}),
			)
			.json()
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ZodLike);
		expect((error as Error).message).toBe("name: Required");
	});

	test("a validator returning an issue list becomes a ValidationError", async () => {
		globalThis.fetch = json({ id: 1 });

		// AJV-shaped: `ajv.validate(schema, body) || ajv.errors`.
		const error = await new Fch("https://api.example.com/x")
			.use(
				validate('response', {
					validate: () => [
						{ instancePath: "/name", message: "must have required property 'name'" },
					],
				}),
			)
			.json()
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).issues[0]).toEqual({
			path: "name",
			message: "must have required property 'name'",
		});
	});

	test("a validator returning undefined/true means valid", async () => {
		globalThis.fetch = json({ id: 1, name: "Ann" });

		for (const valid of [undefined, true, null, []]) {
			const [house] = await new Fch("https://api.example.com/x")
				.use(validate('response', { validate: () => valid }))
				.json<{ id: number }>();
			expect(house.id).toBe(1);
		}
	});

	test("a validator returning false reports a generic issue", async () => {
		globalThis.fetch = json({ id: 1 });

		const error = (await new Fch("https://api.example.com/x")
			.use(validate('response', { validate: () => false }))
			.json()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.issues).toEqual([{ path: "", message: "validator returned false" }]);
	});

	test("when() skips validation for matching responses", async () => {
		globalThis.fetch = json({ nope: true });

		// Skip everything: nothing should throw.
		const [body] = await new Fch("https://api.example.com/x")
			.use(validate('response', { schema: houseSchema, when: () => false }))
			.json<{ nope: boolean }>();

		expect(body.nope).toBe(true);
	});

	test("schema and validate() together: the custom one wins", async () => {
		globalThis.fetch = json({ anything: true });

		let called = false;
		const [body] = await new Fch("https://api.example.com/x")
			.use(
				validate('response', {
					schema: houseSchema, // would fail
					validate: () => {
						called = true;
					},
				}),
			)
			.json<{ anything: boolean }>();

		expect(called).toBe(true);
		expect(body.anything).toBe(true);
	});

	test("requires a schema or a validate function", () => {
		expect(() => validate('response', {})).toThrow(/needs a `schema`.*or a `validate\(value, response\?\)`/);
		expect(() => validate("formData", {})).toThrow(/validate\('formData'/);
	});

	test("rejects an unknown target", () => {
		expect(() => validate("nope" as never, { schema: {} })).toThrow(
			/target must be 'formData' or 'response'/,
		);
	});

	test("the target defaults to response (back-compatible call)", async () => {
		globalThis.fetch = json({ id: 1 });

		const req = new Fch("https://api.example.com/x").use(validate('response', { schema: houseSchema }));
		expect(req.plugins).toEqual(["validate:response"]);

		const error = (await req.json().catch((e: unknown) => e)) as ValidationError;
		expect(error).toBeInstanceOf(ValidationError);
		expect(error.target).toBe("response");
	});
});

describe("checkSchema", () => {
	test("type checks, including integer vs number", () => {
		expect(checkSchema(1, { type: "integer" }, "")).toEqual([]);
		expect(checkSchema(1.5, { type: "integer" }, "")).toHaveLength(1);
		expect(checkSchema("x", { type: "number" }, "")).toHaveLength(1);
		expect(checkSchema([], { type: "array" }, "")).toEqual([]);
		expect(checkSchema({}, { type: "object" }, "")).toEqual([]);
		expect(checkSchema([], { type: "object" }, "")).toHaveLength(1);
	});

	test("nullable and null type", () => {
		expect(checkSchema(null, { type: "string", nullable: true }, "")).toEqual([]);
		expect(checkSchema(null, { type: "null" }, "")).toEqual([]);
		expect(checkSchema(null, { type: "string" }, "")).toHaveLength(1);
	});

	test("nested paths are dotted", () => {
		const issues = checkSchema(
			{ items: [{ id: "x" }] },
			{
				type: "object",
				properties: {
					items: { type: "array", items: { type: "object", properties: { id: { type: "number" } } } },
				},
			},
			"",
		);

		expect(issues).toEqual([{ path: "items.0.id", message: "expected number, got string" }]);
	});

	test("string and number bounds", () => {
		expect(checkSchema("ab", { type: "string", minLength: 3 }, "")).toHaveLength(1);
		expect(checkSchema("abc", { type: "string", maxLength: 2 }, "")).toHaveLength(1);
		expect(checkSchema("abc", { type: "string", pattern: "^a" }, "")).toEqual([]);
		expect(checkSchema(1, { type: "number", minimum: 2 }, "")).toHaveLength(1);
		expect(checkSchema(5, { type: "number", maximum: 4 }, "")).toHaveLength(1);
	});

	test("array bounds", () => {
		expect(checkSchema([1], { type: "array", minItems: 2 }, "")).toHaveLength(1);
		expect(checkSchema([1, 2], { type: "array", maxItems: 1 }, "")).toHaveLength(1);
	});

	test("enum", () => {
		expect(checkSchema("a", { enum: ["a", "b"] }, "")).toEqual([]);
		expect(checkSchema("c", { enum: ["a", "b"] }, "")).toHaveLength(1);
	});

	test("required and additionalProperties", () => {
		const schema = {
			type: "object",
			required: ["a"],
			properties: { a: { type: "number" } },
			additionalProperties: false,
		} as const;

		expect(checkSchema({ a: 1 }, schema, "")).toEqual([]);
		expect(checkSchema({ a: 1, b: 2 }, schema, "")).toEqual([
			{ path: "b", message: "is not allowed" },
		]);
		expect(checkSchema({}, schema, "")).toEqual([{ path: "a", message: "is required" }]);
	});

	test("a union type accepts either", () => {
		expect(checkSchema("x", { type: ["string", "number"] }, "")).toEqual([]);
		expect(checkSchema(1, { type: ["string", "number"] }, "")).toEqual([]);
		expect(checkSchema(true, { type: ["string", "number"] }, "")).toHaveLength(1);
	});
});
