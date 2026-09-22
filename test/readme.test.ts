import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Fch } from "../src/Fch";

// Executes the exact snippets from Readme.md against a stubbed fetch, so the
// README cannot drift away from the real API.

let realFetch: typeof fetch;
let calls: { url: string; init: RequestInit }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	calls = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ items: ["a"], id: 1, name: "Alice" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("Readme examples", () => {
	test("'The URL is the request' snippet", async () => {
		const req = new Fch("https://api.example.com/v1/items?page=1");

		req.searchParams.set("page", "2");
		req.searchParams.append("tag", "new");
		req.pathname = "/v2/items";

		expect(req.toString()).toBe(
			"https://api.example.com/v2/items?page=2&tag=new"
		);
		await req.send();
		expect(calls[0].url).toBe("https://api.example.com/v2/items?page=2&tag=new");
	});

	test("'Await the object directly' snippet", async () => {
		const response = await new Fch("https://api.example.com/data", { timeout: 3000 });
		expect(response).toBeInstanceOf(Response);
	});

	test("'Typed bodies' snippet", async () => {
		const [user] = await new Fch("https://api.example.com/users")
			.setJsonBody({ name: "Alice", role: "admin" })
			.json<{ id: number; name: string }>();

		expect(user.name).toBe("Alice");
		expect(calls[0].init.method).toBe("GET");
		expect(calls[0].init.body).toBe(JSON.stringify({ name: "Alice", role: "admin" }));
	});

	test("'Retries, timeout and interceptors' snippet wires up", async () => {
		const api = new Fch("https://api.example.com/orders", {
			retries: 3,
			retryDelay: 500,
			maxRetryDelay: 10_000,
			timeout: 5_000,
			debug: false,
		})
			.setAuthToken("t")
			.addRequestInterceptor((req) => {
				req.setHeader("X-Request-Id", "abc");
			})
			.addResponseInterceptor(async (res) => res)
			.setRetryOn((response, error, attempt) => {
				if (response) return response.status === 429 || response.status >= 500;
				return attempt < 3;
			});

		const [order] = await api.json<{ id: number }>();
		expect(order.id).toBe(1);
		expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer t");
		expect(new Headers(calls[0].init.headers).get("X-Request-Id")).toBe("abc");
	});

	test("'Deduplication' snippet reuses one request", async () => {
		const req = new Fch("https://api.example.com/profile", { dedupe: true });
		const [a, b] = await Promise.all([req.json(), req.json()]);
		expect(calls).toHaveLength(1);
		expect(a).toEqual(b);
	});

	test("'Cancelling' snippet keeps the builder usable", async () => {
		// A response that only settles when aborted, so the abort path is real.
		let abortedAtLeastOnce = false;
		globalThis.fetch = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					abortedAtLeastOnce = true;
					reject(new DOMException("User aborted", "AbortError"));
				});
			})) as unknown as typeof fetch;

		const req = new Fch("https://api.example.com/slow", { retries: 5 });
		const pending = req.send();

		req.abort();
		await pending.catch(() => {});
		expect(abortedAtLeastOnce).toBe(true);
		expect(req.aborted).toBe(true);

		// The builder is still usable after abort().
		globalThis.fetch = (async () =>
			new Response("ok", { status: 200 })) as unknown as typeof fetch;
		const res = await req.send();
		expect(await res.text()).toBe("ok");
	});

	test("every member in the API overview table exists", () => {
		const req = new Fch("https://api.example.com/x");
		const members = [
			"send", "json", "text", "blob", "makeRequest", "then", "catch", "finally",
			"setSearchParams", "appendSearchParams",
			"setJsonBody", "setFormData", "appendToFormData", "setFormUrlEncodedBody", "setBody",
			"setHeader", "setHeaders", "getHeader", "deleteHeader", "setAuthToken", "setBasicAuth",
			"setMethod", "setTimeout", "setRetries", "setRetryDelay", "setMaxRetryDelay",
			"setRetryOn", "setFetchOptions", "setCORS", "disableCache",
			"setDedupeKey", "setIdempotencyKey",
			"addRequestInterceptor", "addResponseInterceptor",
			"getLogger", "setLogger", "enableLogging", "disableLogging",
			"abort", "clone",
		];
		for (const m of members) {
			expect(typeof (req as never as Record<string, unknown>)[m], m).toBe("function");
		}
		expect(req).toBeInstanceOf(URL);
		expect("aborted" in req).toBe(true);
	});
});
