// @vitest-environment jsdom
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Fch } from "../src/Fch";
import { validate, ValidationError } from "../src/plugins/validate";

// Validating the request body must stop the request before it is sent, and the
// failure must behave like any other rejection.

let realFetch: typeof fetch;
let sent: number;

beforeEach(() => {
	realFetch = globalThis.fetch;
	sent = 0;
	globalThis.fetch = (async () => {
		sent++;
		return new Response('{"ok":true}', {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;

	document.body.innerHTML =
		'<form id="good" method="post"><input name="city" value="Berlin"><input name="rooms" value="3"></form>' +
		'<form id="bad" method="post"><input name="rooms" value="abc"></form>';
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const schema = {
	type: "object",
	required: ["city", "rooms"],
	properties: {
		city: { type: "string", minLength: 2 },
		rooms: { type: "string", pattern: "^[0-9]+$" },
	},
} as const;

describe("validate('formData')", () => {
	test("a valid form is sent normally", async () => {
		const req = new Fch("https://api.example.com/x").use(validate("formData", { schema }));

		await req.setFormData("#good").send();

		expect(sent).toBe(1);
	});

	test("an invalid form is blocked before the request is sent", async () => {
		const req = new Fch("https://api.example.com/x").use(validate("formData", { schema }));

		const error = await req
			.setFormData("#bad")
			.send()
			.catch((e: unknown) => e);

		expect(sent, "no request must go out").toBe(0);
		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).target).toBe("formData");
	});

	test("the error names the field and says FormData, not Response", async () => {
		const req = new Fch("https://api.example.com/x").use(validate("formData", { schema }));

		const error = (await req
			.setFormData("#bad")
			.send()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.message).toContain("FormData validation failed");
		expect(error.message).toContain("city: is required");
		expect(error.issues).toEqual(
			expect.arrayContaining([
				{ path: "city", message: "is required" },
				{ path: "rooms", message: "does not match /^[0-9]+$/" },
			]),
		);
	});

	test("there is no response on a form failure", async () => {
		const req = new Fch("https://api.example.com/x").use(validate("formData", { schema }));

		const error = (await req
			.setFormData("#bad")
			.send()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.response).toBeUndefined();
	});

	test("the failing fields are on the error body", async () => {
		const req = new Fch("https://api.example.com/x").use(validate("formData", { schema }));

		const error = (await req
			.setFormData("#bad")
			.send()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.body).toEqual({ rooms: "abc" });
	});

	test("a request without a form body is skipped, not failed", async () => {
		// A JSON body is not FormData; the plugin must not reject it.
		const req = new Fch("https://api.example.com/x", { method: "POST" })
			.use(validate("formData", { schema }))
			.setJsonBody({ anything: true });

		await req.send();
		expect(sent).toBe(1);
	});

	test("a custom validator sees plain fields, and files as metadata", async () => {
		document.body.innerHTML =
			'<form id="upload" method="post" enctype="multipart/form-data">' +
			'<input name="title" value="Cottage"><input type="file" name="photo"></form>';

		let seen: Record<string, unknown> = {};
		const req = new Fch("https://api.example.com/x").use(
			validate("formData", {
				validate: (value) => {
					seen = value as Record<string, unknown>;
				},
			}),
		);

		await req.setFormData("#upload").send();

		expect(seen.title).toBe("Cottage");
		// A File is described rather than passed as bytes.
		expect(seen.photo).toMatchObject({ name: expect.any(String), size: expect.any(Number) });
	});

	test("both targets can be attached with two use() calls", async () => {
		const req = new Fch("https://api.example.com/x")
			.use(validate("formData", { schema }))
			.use(validate("response", { schema: { type: "object", required: ["ok"] } }));

		expect(req.plugins).toEqual(["validate:formData", "validate:response"]);

		const [body] = await req.setFormData("#good").json<{ ok: boolean }>();
		expect(body.ok).toBe(true);
		expect(sent).toBe(1);
	});

	test("the form failure reaches onError and resets the timers", async () => {
		let seen: unknown = null;
		const probe = {
			name: "probe",
			install({ onError }: { onError: (fn: (e: unknown) => void) => void }) {
				onError((e) => (seen = e));
			},
		};

		const req = new Fch("https://api.example.com/x")
			.use(probe as never)
			.use(validate("formData", { schema }));

		await req.setFormData("#bad").send().catch(() => {});

		expect(seen).toBeInstanceOf(ValidationError);
		// The timer must not be left in `submitting` by a rejected request hook.
		expect(req.timer).toBe("idle");
	});

	test("keepBody: false omits the fields", async () => {
		const req = new Fch("https://api.example.com/x").use(
			validate("formData", { schema, keepBody: false }),
		);

		const error = (await req
			.setFormData("#bad")
			.send()
			.catch((e: unknown) => e)) as ValidationError;

		expect(error.body).toBeUndefined();
	});
});
