import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { Fch } from "../src/Fch";
import { compat, DEPRECATED_MEMBERS } from "../src/plugins/compat";

// The deprecated aliases moved out of the core. They must still behave exactly
// as before for anyone who opts in with the compat plugin.

let realFetch: typeof fetch;
let calls: { url: string; init: RequestInit }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	calls = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response('{"ok":true}', {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("compat plugin", () => {
	test("adds every deprecated member", () => {
		const req = new Fch("https://api.example.com/x").use(compat()) as never as Record<
			string,
			unknown
		>;

		for (const name of DEPRECATED_MEMBERS) {
			expect(typeof req[name], name).toBe("function");
		}
		expect(DEPRECATED_MEMBERS).toHaveLength(4);
	});

	test("the core does not expose them", () => {
		const req = new Fch("https://api.example.com/x") as never as Record<string, unknown>;
		for (const name of DEPRECATED_MEMBERS) {
			expect(req[name], name).toBeUndefined();
		}
	});

	test("are idempotent: attaching twice keeps one registration", () => {
		const plugin = compat();
		const req = new Fch("https://api.example.com/x").use(plugin).use(plugin);

		expect(req.plugins).toEqual(["compat"]);
	});

	test("setRetryTimeout delegates to setRetryDelay", () => {
		const req = new Fch("https://api.example.com/x").use(compat());

		expect(req.setRetryTimeout(1500)).toBe(req);
		expect(req.retryDelay).toBe(1500);
	});

	test("setIdempotencyKey delegates to setDedupeKey, including a factory", () => {
		const req = new Fch("https://api.example.com/x").use(compat());
		const factory = () => "generated";

		req.setIdempotencyKey(factory);
		const configured = new Fch("https://api.example.com/x", {
			dedupe: true,
			dedupeKey: factory,
		});

		// Both land in the same slot.
		expect(typeof configured.dedupeKey).toBe("function");
	});

	test("addRequestInterceptor delegates to before, and runs on the request", async () => {
		const req = new Fch("https://api.example.com/x").use(compat());

		req.addRequestInterceptor((r) => r.setHeader("X-Compat", "1"));
		await req.send();

		expect(new Headers(calls[0].init.headers).get("X-Compat")).toBe("1");
	});

	test("addResponseInterceptor delegates to after, and can throw", async () => {
		const req = new Fch("https://api.example.com/x").use(compat());

		req.addResponseInterceptor((res) => {
			if (!res.ok) throw new Error("not ok");
			return res;
		});

		await expect(req.send()).resolves.toBeInstanceOf(Response);
	});

	test("does not shadow a method that the core already provides", async () => {
		// A future core method with the same name must win over the alias.
		const req = new Fch("https://api.example.com/x");
		const own = vi.fn(() => req);
		(req as never as Record<string, unknown>).setRetryTimeout = own;

		req.use(compat());

		expect((req as never as Record<string, unknown>).setRetryTimeout).toBe(own);
	});

	test("the aliases are chainable", async () => {
		const req = new Fch("https://api.example.com/x").use(compat());

		const result = req
			.setRetryTimeout(100)
			.setIdempotencyKey("k")
			.addRequestInterceptor(() => {})
			.addResponseInterceptor((r) => r);

		expect(result).toBe(req);
	});
});
