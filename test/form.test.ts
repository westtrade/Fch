// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";

// The library must work against a REAL DOM (form elements, submit events), so this
// file opts into the jsdom environment. The globals are taken from a JSDOM window
// so FormData/HTMLFormElement belong to the same realm as the parsed document.
let dom: JSDOM;
let realFetch: typeof fetch;
let sent: { url: string; method?: string; body: string; contentType: string | null }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	dom = new JSDOM(
		`<!doctype html><html><body>
			<form id="postForm" method="post" action="/houses">
				<input name="title" value="Cute Cottage">
				<input name="rooms" value="3">
				<input type="checkbox" name="pets" value="yes" checked>
				<input type="checkbox" name="garage" value="yes">
				<select name="city"><option value="berlin" selected>Berlin</option></select>
				<input type="file" name="photo">
				<button type="submit" name="action" value="save">Save</button>
				<button type="submit" name="action" value="draft">Draft</button>
			</form>
			<form id="getForm" method="get" action="/search">
				<input name="q" value="hello">
			</form>
		</body></html>`,
		{ url: "https://app.example.com/page" }
	);

	const { window } = dom;
	globalThis.FormData = window.FormData as unknown as typeof FormData;
	globalThis.HTMLFormElement = window.HTMLFormElement as unknown as typeof HTMLFormElement;

	sent = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		const body = init.body as FormData | null;
		let described = body ? "" : "<none>";
		if (body instanceof window.FormData) {
			described = JSON.stringify(Object.fromEntries([...body].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])));
		} else if (typeof body === "string") {
			described = body;
		}
		sent.push({
			url: String(url),
			method: init.method,
			body: described,
			contentType: new Headers(init.headers).get("content-type"),
		});
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	dom.window.close();
});

const form = () => dom.window.document.getElementById("postForm") as HTMLFormElement;
const getForm = () => dom.window.document.getElementById("getForm") as HTMLFormElement;

/** Fire a real submit event, exactly as a browser would. */
function submit(formEl: HTMLFormElement, submitter?: HTMLElement) {
	return new dom.window.SubmitEvent("submit", {
		bubbles: true,
		cancelable: true,
		submitter,
	});
}

describe("form/Event bodies — the four spellings", () => {
	test("new FormData(form)", async () => {
		const { Fch } = await import("../src/Fch");
		await new Fch("https://api.example.com/houses").setBody(new FormData(form())).send();

		expect(sent[0].body).toContain('"title":"Cute Cottage"');
		expect(sent[0].body).toContain('"pets":"yes"');
		expect(sent[0].body).not.toContain("garage"); // unchecked box is excluded
	});

	test("the event itself", async () => {
		const { Fch } = await import("../src/Fch");
		const el = form();
		let captured: Fch | null = null;
		el.addEventListener("submit", (e) => {
			e.preventDefault();
			captured = new Fch("https://api.example.com/houses").setBody(e as unknown as SubmitEvent);
		});
		el.dispatchEvent(submit(el));

		await captured!.send();
		expect(sent[0].body).toContain('"title":"Cute Cottage"');
	});

	test("event.target (the form)", async () => {
		const { Fch } = await import("../src/Fch");
		const el = form();
		let request: Fch | null = null;
		el.addEventListener("submit", (e) => {
			e.preventDefault();
			request = new Fch("https://api.example.com/houses").setBody(e.target as HTMLFormElement);
		});
		el.dispatchEvent(submit(el));

		await request!.send();
		expect(sent[0].body).toContain('"title":"Cute Cottage"');
	});

	test("the <form> element directly", async () => {
		const { Fch } = await import("../src/Fch");
		await new Fch("https://api.example.com/houses").setBody(form()).send();
		expect(sent[0].body).toContain('"title":"Cute Cottage"');
	});

	test("the clicked submit button's name/value is included (submitter)", async () => {
		const { Fch } = await import("../src/Fch");
		const el = form();
		const save = el.querySelector('button[value="save"]') as HTMLButtonElement;

		let request: Fch | null = null;
		el.addEventListener("submit", (e) => {
			e.preventDefault();
			request = new Fch("https://api.example.com/houses").setFormData(e as unknown as SubmitEvent);
		});
		el.dispatchEvent(submit(el, save));

		await request!.send();
		expect(sent[0].body).toContain('"action":"save"');
	});

	test("GET form fills the URL instead of the body", async () => {
		const { Fch } = await import("../src/Fch");
		const el = getForm();
		await new Fch("https://api.example.com/search").setFormData(el).send();

		// A form body must become query parameters for GET, never a request body.
		expect(sent[0].body).toBe("<none>");
		expect(sent[0].method).toBe("GET");
	});
});

describe("method inference from the form", () => {
	test("<form method=\"post\"> switches the request to POST", async () => {
		const { Fch } = await import("../src/Fch");
		await new Fch("https://api.example.com/houses").setFormData(form()).send();
		expect(sent[0].method).toBe("POST");
	});

	test("an explicit setMethod is not overridden by the form's default GET", async () => {
		const { Fch } = await import("../src/Fch");
		await new Fch("https://api.example.com/search")
			.setMethod("PUT")
			.setFormData(getForm())
			.send();
		expect(sent[0].method).toBe("PUT");
	});

	test("multipart Content-Type is left for fetch() to set (with boundary)", async () => {
		const { Fch } = await import("../src/Fch");
		await new Fch("https://api.example.com/houses").setFormData(form()).send();
		// We must NOT pin a boundary-less multipart type.
		expect(sent[0].contentType).toBeNull();
	});

	test("setFormData rejects non-form values with a clear error", async () => {
		const { Fch } = await import("../src/Fch");
		const req = new Fch("https://api.example.com/x");
		expect(() => req.setFormData({ nope: true } as never)).toThrow(/expects FormData/);
	});
});

describe("fch.create shortcuts — the README example", () => {
	test("api.post('/houses', new FormData(e.target))", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		form().addEventListener("submit", (e) => {
			e.preventDefault();
			api.post("/houses", new FormData(e.target as HTMLFormElement));
		});
		form().dispatchEvent(submit(form()));
		await vi.waitFor(() => expect(sent.length).toBe(1));

		expect(sent[0].url).toBe("https://app.example.com/houses");
		expect(sent[0].method).toBe("POST");
		expect(sent[0].body).toContain('"title":"Cute Cottage"');
	});

	test("api.post('/houses', e) — fire-and-forget, NOT awaited", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		form().addEventListener("submit", (e) => {
			e.preventDefault();
			api.post("/houses", e);
		});
		form().dispatchEvent(submit(form()));

		// The handler does not await the call: the request must still be sent.
		await vi.waitFor(() => expect(sent.length).toBe(1));
		expect(sent[0].body).toContain('"title":"Cute Cottage"');
	});

	test("api.post('/houses', e.target) and (form)", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		api.post("/houses", form());
		await vi.waitFor(() => expect(sent.length).toBe(1));
		expect(sent[0].body).toContain('"rooms":"3"');
	});

	test("the shortcut's method wins over the form's method attribute", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		// getForm declares method="get"; the caller explicitly asked for PUT.
		api.put("/search", getForm());
		await vi.waitFor(() => expect(sent.length).toBe(1));
		expect(sent[0].method).toBe("PUT");
	});

	test("plain objects are JSON-encoded", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });
		api.post("/houses", { id: 1, name: "Cute Cottage" });
		await vi.waitFor(() => expect(sent.length).toBe(1));

		expect(sent[0].body).toBe('{"id":1,"name":"Cute Cottage"}');
		expect(sent[0].contentType).toBe("application/json");
	});

	test("api.get has no body and carries query options", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });
		api.get("/houses", { method: "GET" });
		await vi.waitFor(() => expect(sent.length).toBe(1));

		expect(sent[0].method).toBe("GET");
		expect(sent[0].body).toBe("<none>");
	});

	test("api.get(url, form) serialises the fields into the query", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		// A real <form> element, whose own properties (nodeType, tagName, action)
		// must not reach fetch() as init keys, and whose fields must be sent.
		const call = api.get("/search", getForm());

		await vi.waitFor(() => expect(sent.length).toBe(1));

		expect(sent[0].url).toBe("https://app.example.com/search?q=hello");
		expect(sent[0].method).toBe("GET");
		expect(sent[0].body).toBe("<none>");

		// The form was consumed as a form, not mistaken for the options object.
		const request = call.request as unknown as { fetchOptions: Record<string, unknown> };
		for (const key of ["nodeType", "tagName", "action", "enctype", "submitter"]) {
			expect(request.fetchOptions, key).not.toHaveProperty(key);
		}
	});

	test("a single call resolves to the parsed body tuple", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });
		const [data, response] = await api.get<{ ok: boolean }>("/houses");
		expect(data).toEqual({ ok: true });
		expect(response.status).toBe(200);
	});

	test("the call is abortable through its request", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });
		globalThis.fetch = ((_u: string, init: RequestInit) =>
			new Promise((_r, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError"))
				);
			})) as unknown as typeof fetch;

		const call = api.get("/slow");
		call.request.abort();

		// The in-flight call itself rejects; the builder stays reusable (H1).
		await expect(call).rejects.toBeDefined();
		expect(call.request.aborted).toBe(true);
	});
});

describe("URL-first behaviour still holds", () => {
	test("create().request() returns a real Fch builder", async () => {
		const { create, Fch } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });
		const builder = api.request("/houses");

		expect(builder).toBeInstanceOf(Fch);
		expect(builder).toBeInstanceOf(URL);
		expect(builder.pathname).toBe("/houses");
	});

	test("a relative URL without baseUrl explains itself", async () => {
		const { Fch } = await import("../src/Fch");
		expect(() => new Fch("/houses")).toThrow(/absolute URL/);
	});

	test("a form-like object that is not a real element is rejected clearly", async () => {
		const { Fch } = await import("../src/Fch");
		const fake = { nodeType: 1, tagName: "FORM", method: "post" };
		expect(() => new Fch("https://api.example.com/x").setBody(fake as never)).toThrow(
			/not a real <form>/
		);
	});
});

describe("body handling regressions", () => {
	test("raw FormData with no form element still posts a body", async () => {
		const { Fch } = await import("../src/Fch");
		const captured: { method?: string; isForm: boolean }[] = [];
		globalThis.fetch = (async (_u: string, init: RequestInit) => {
			captured.push({
				method: init.method,
				isForm: init.body instanceof FormData,
			});
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const fd = new FormData();
		fd.append("a", "1");
		await new Fch("https://api.example.com/x").setFormData(fd).send();

		expect(captured[0].method).toBe("POST");
		expect(captured[0].isForm).toBe(true);
	});

	test("setBody(string) after setJsonBody clears the stale Content-Type", async () => {
		const { Fch } = await import("../src/Fch");
		let contentType: string | null = "unset";
		globalThis.fetch = (async (_u: string, init: RequestInit) => {
			contentType = new Headers(init.headers).get("content-type");
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await new Fch("https://api.example.com/x")
			.setJsonBody({ a: 1 })
			.setBody("plain text")
			.send();

		expect(contentType).toBeNull();
	});

	test("a stream body gets duplex: 'half' for Node", async () => {
		const { create } = await import("../src/Fch");
		let duplex: unknown;
		globalThis.fetch = (async (_u: string, init: RequestInit) => {
			duplex = (init as { duplex?: unknown }).duplex;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x"));
				controller.close();
			},
		});

		create({ baseUrl: "https://api.example.com" }).post("/upload", stream);
		await vi.waitFor(() => expect(duplex).toBe("half"));
	});
});

describe("form bodies are read once per submit", () => {
	test("post(url, form) builds the FormData a single time", async () => {
		const { create } = await import("../src/Fch");

		// Count constructions by wrapping the realm's FormData.
		const RealFormData = dom.window.FormData;
		let constructed = 0;
		class CountingFormData extends RealFormData {
			constructor(...args: ConstructorParameters<typeof RealFormData>) {
				constructed += 1;
				super(...args);
			}
		}
		const globalScope = globalThis as unknown as { FormData: unknown };
		const previous = globalScope.FormData;
		globalScope.FormData = CountingFormData;

		try {
			create({ baseUrl: "https://app.example.com" }).post("/houses", form());
			await vi.waitFor(() => expect(sent.length).toBe(1));
		} finally {
			globalScope.FormData = previous;
		}

		// Once for the body, never twice: the old code converted the form, then
		// handed the original element to setFormData, which converted it again.
		expect(constructed).toBe(1);
	});
});

// Documented in getting-started.md and shortcuts.md: a one-off override is the
// second argument of api.request(), not a chain of setters.
describe("api.request(url, options)", () => {
	test("per-call options override the client defaults", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com", timeout: 5000, retries: 0 });

		const req = api.request("/houses/1", { retries: 5 });

		expect(req.retries).toBe(5);
		// Untouched defaults still apply.
		expect(req.timeout).toBe(5000);
		expect(req.toString()).toBe("https://app.example.com/houses/1");
	});

	test("is a builder, so .json() still resolves the tuple", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		const [house, response] = await api.request("/houses/1", { retries: 5 }).json<{ ok: boolean }>();

		expect(house).toEqual({ ok: true });
		expect(response.status).toBe(200);
		expect(sent.at(-1)!.url).toBe("https://app.example.com/houses/1");
	});

	test("headers merge with the client's instead of replacing them", async () => {
		const { create } = await import("../src/Fch");
		const api = create({
			baseUrl: "https://app.example.com",
			headers: { Authorization: "Bearer t" },
		});

		// Inspect the builder: this file's fetch stub records only Content-Type.
		const req = api.request("/x", { headers: { "X-Trace": "1" } });
		expect(req.getHeader("Authorization")).toBe("Bearer t");
		expect(req.getHeader("X-Trace")).toBe("1");
	});

	test("a per-call baseUrl retargets only that request", async () => {
		const { create } = await import("../src/Fch");
		const api = create({ baseUrl: "https://app.example.com" });

		await api.request("/x", { baseUrl: "https://other.example" }).send();
		expect(sent.at(-1)!.url).toBe("https://other.example/x");

		await api.request("/x").send();
		expect(sent.at(-1)!.url).toBe("https://app.example.com/x");
	});
});

// setFormData accepts a CSS selector, so a form can be referenced without
// holding the element. A bare string is also a valid body, so the selector
// handling must NOT leak into setBody() or toFormData().
describe("setFormData(selector)", () => {
	let Fch: typeof import("../src/Fch").Fch;

	beforeEach(async () => {
		Fch = (await import("../src/Fch")).Fch;
	});

	test("resolves a selector to a form and serialises it", async () => {
		document.body.innerHTML = '<form id="postForm" method="post"><input name="title" value="x"></form>';

		const req = new Fch("https://app.example.com/houses").setFormData("#postForm");

		expect(req.method).toBe("POST");
		const body = req.fetchOptions.body as FormData;
		expect(body).toBeInstanceOf(window.FormData);
		expect([...body.keys()]).toContain("title");
	});

	test("accepts an attribute selector", async () => {
		// No `method` means GET in HTML, so declare POST to get a body.
		document.body.innerHTML =
			'<form name="named" method="post"><input name="city" value="Berlin"></form>';

		const req = new Fch("https://app.example.com/x").setFormData('form[name="named"]');
		expect([...(req.fetchOptions.body as FormData).keys()]).toEqual(["city"]);
	});

	test("a GET form serialises into the query string", async () => {
		document.body.innerHTML = '<form id="getForm" method="get"><input name="q" value="cottage"></form>';

		const req = new Fch("https://app.example.com/search").setFormData("#getForm");

		expect(req.toString()).toBe("https://app.example.com/search?q=cottage");
		expect(req.fetchOptions.body).toBeFalsy();
	});

	test("setFormFrom() is the same thing", async () => {
		document.body.innerHTML = '<form id="postForm" method="post"><input name="title" value="x"></form>';

		const req = new Fch("https://app.example.com/houses").setFormFrom("#postForm");
		expect(req.method).toBe("POST");
		expect(req.fetchOptions.body).toBeInstanceOf(window.FormData);
	});

	test("a missing selector names the selector in the error", async () => {
		expect(() => new Fch("https://app.example.com/x").setFormData("#nope")).toThrow(
			/found no <form> matching "#nope"/,
		);
	});

	test("a selector matching a non-form is rejected", async () => {
		document.body.innerHTML = '<div id="not-form"></div>';

		expect(() => new Fch("https://app.example.com/x").setFormData("#not-form")).toThrow(
			/found no <form> matching/,
		);
	});

	test("an invalid selector does not escape as a SyntaxError", async () => {
		expect(() => new Fch("https://app.example.com/x").setFormData("###")).toThrow(
			/found no <form> matching/,
		);
	});

	test("string bodies are still bodies, not selectors", async () => {
		document.body.innerHTML = '<form id="postForm"><input name="a" value="1"></form>';

		// The regression this guards: teaching toFormData about strings would
		// make `setBody("#checkout")` silently become a form submission.
		const req = new Fch("https://app.example.com/x").setBody("hello #world");
		expect(req.fetchOptions.body).toBe("hello #world");

		const looksLikeSelector = new Fch("https://app.example.com/x").setBody("#postForm");
		expect(looksLikeSelector.fetchOptions.body).toBe("#postForm");
	});
});
