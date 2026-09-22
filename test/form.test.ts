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
