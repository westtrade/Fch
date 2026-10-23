import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Fch, fch } from "../src/Fch";
import { logger } from "../src/plugins/logger";

// Two changes: a non-standard HTTP method is a warning, not an error, and a
// shortcut body can declare how it is encoded.

let realFetch: typeof fetch;
let sent: { url: string; init: RequestInit }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	sent = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		sent.push({ url: String(url), init });
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const spyLogger = () => {
	const lines: string[] = [];
	return {
		lines,
		logger: {
			info: () => {},
			error: () => {},
			debug: () => {},
			warn: (...args: unknown[]) => lines.push(args.join(" ")),
		},
	};
};

describe("non-standard HTTP methods", () => {
	test("setMethod accepts one and the request goes out", async () => {
		const req = new Fch("https://api.example.com/x").setMethod("FETCH");

		expect(req.method).toBe("FETCH");
		await req.send();
		expect(sent[0].init.method).toBe("FETCH");
	});

	test("it is reported as a warning, not thrown", async () => {
		const { lines, logger: spy } = spyLogger();
		const req = new Fch("https://api.example.com/x").use(logger({ logger: spy }));

		expect(() => req.setMethod("PURGE")).not.toThrow();

		await req.send();
		expect(lines.join(" ")).toContain("Non-standard HTTP method");
	});

	test("the constructor warns on first use", async () => {
		const { lines, logger: spy } = spyLogger();
		const req = new Fch("https://api.example.com/x", { method: "PROPFIND" }).use(
			logger({ logger: spy }),
		);

		await req.send();

		expect(req.method).toBe("PROPFIND");
		expect(sent[0].init.method).toBe("PROPFIND");
		expect(lines.join(" ")).toContain("PROPFIND");
	});

	test("standard methods stay quiet", async () => {
		const { lines, logger: spy } = spyLogger();
		const req = new Fch("https://api.example.com/x").use(logger({ logger: spy }));

		req.setMethod("post");
		await req.send();

		expect(lines).toEqual([]);
	});

	test("methods the platform forbids still fail, with the real reason", () => {
		for (const method of ["CONNECT", "TRACE", "TRACK"]) {
			expect(() => new Fch("https://api.example.com/x").setMethod(method), method).toThrow(
				/platform forbids it/,
			);
		}
	});

	test("a method that is not a valid token fails", () => {
		for (const method of ["GE T", "", "PO\nST"]) {
			expect(() => new Fch("https://api.example.com/x").setMethod(method)).toThrow(
				/Invalid HTTP method/,
			);
		}
	});

	test("known behaviour for the retry-safe sets is unchanged", () => {
		// GET stays safe, POST stays mutating: dedupe keys depend on it.
		const get = new Fch("https://api.example.com/x");
		const post = new Fch("https://api.example.com/x", { method: "POST", dedupe: true });

		expect(get.method).toBe("GET");
		expect(post.method).toBe("POST");
	});
});

describe("shortcut body encoding", () => {
	const api = fch.create({ baseUrl: "https://api.example.com" });

	const bodyOf = () => sent[0].init.body;
	const typeOf = () => new Headers(sent[0].init.headers).get("content-type");

	test("defaults to JSON", async () => {
		await api.post("/houses", { name: "Cottage", rooms: 3 });

		expect(typeOf()).toBe("application/json");
		expect(String(bodyOf())).toBe('{"name":"Cottage","rooms":3}');
	});

	test("an explicit 'json' changes nothing", async () => {
		await api.post("/houses", { name: "Cottage" }, "json");

		expect(typeOf()).toBe("application/json");
	});

	test("'urlencoded' sends a form-urlencoded body", async () => {
		await api.post("/houses", { name: "Cottage", rooms: 3 }, "urlencoded");

		expect(typeOf()).toBe("application/x-www-form-urlencoded");
		expect(String(bodyOf())).toBe("name=Cottage&rooms=3");
	});

	test("the MIME name works as well as the short name", async () => {
		await api.post("/houses", { name: "Cottage" }, "application/x-www-form-urlencoded");

		expect(typeOf()).toBe("application/x-www-form-urlencoded");
		expect(String(bodyOf())).toBe("name=Cottage");
	});

	test("repeated keys are appended, not collapsed", async () => {
		await api.post("/houses", { tag: ["a", "b"] }, "urlencoded");

		expect(String(bodyOf())).toBe("tag=a&tag=b");
	});

	test("'form' sends multipart FormData", async () => {
		await api.post("/houses", { name: "Cottage", rooms: 3 }, "form");

		expect(bodyOf()).toBeInstanceOf(FormData);
		expect((bodyOf() as FormData).get("name")).toBe("Cottage");
		// The boundary is added by fetch, so no manual content type is set.
		expect(typeOf()).toBeNull();
	});

	test("'text' sends a text/plain body", async () => {
		await api.post("/houses", "hello", "text");

		expect(typeOf()).toBe("text/plain");
		expect(String(bodyOf())).toBe("hello");
	});

	test("an encoding can be combined with options", async () => {
		await api.post("/houses", { a: 1 }, { retries: 2, encode: "urlencoded" });

		expect(typeOf()).toBe("application/x-www-form-urlencoded");
	});

	test("`encode` in options and the string shorthand agree", async () => {
		await api.post("/houses", { a: 1, b: 2 }, "urlencoded");
		const viaString = String(bodyOf());

		await api.post("/houses", { a: 1, b: 2 }, { encode: "urlencoded" });
		expect(String(bodyOf())).toBe(viaString);
	});

	test("`encode` never reaches the fetch init", async () => {
		await api.post("/houses", { a: 1 }, { encode: "urlencoded", retries: 2 });

		const init = sent[0].init as Record<string, unknown>;
		expect(init.encode).toBeUndefined();
		// The other shortcut-only key must stay stripped too.
		expect(init.baseUrl).toBeUndefined();
	});

	test("options still work without an encoding", async () => {
		const call = api.post("/houses", { a: 1 }, { retries: 2 });
		expect(call).toBeDefined();
		await call;

		expect(typeOf()).toBe("application/json");
	});

	test("an unknown encoding fails fast, at the call site", () => {
		// Thrown synchronously like every other builder error, so a typo cannot
		// silently become a request with the wrong wire format.
		expect(() => api.post("/houses", { a: 1 }, "xml" as never)).toThrow(
			/Unsupported body encoding.*'json', 'urlencoded', 'form', 'text' or 'raw'/,
		);
	});

	test("a form element still wins over the encoding argument", async () => {
		// A real form body is already FormData; the encoding cannot re-encode it.
		const data = new FormData();
		data.append("from", "form");
		await api.post("/houses", data, "json");

		expect(bodyOf()).toBe(data);
	});
});
