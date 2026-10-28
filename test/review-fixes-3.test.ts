import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { Fch, fch, toCall } from "../src/Fch";
import { compat } from "../src/plugins/compat";
import { logger } from "../src/plugins/logger";

// Regression tests for the full-review fixes (hooks, clone, encode, legacy form).

const B = "https://api.test";
let realFetch: typeof fetch;
let sent: { url: string; init: RequestInit }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	sent = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		sent.push({ url: String(url), init });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const hookCounter = () => {
	const counts = { request: 0, success: 0, error: 0 };
	const plugin = {
		name: "counter",
		install(api: { onRequest: (fn: () => void) => void; onSuccess: (fn: () => void) => void; onError: (fn: () => void) => void }) {
			api.onRequest(() => counts.request++);
			api.onSuccess(() => counts.success++);
			api.onError(() => counts.error++);
		},
	};
	return { counts, plugin };
};

describe("plugin hooks run once per request", () => {
	test("a shortcut call fires hooks once", async () => {
		const { counts, plugin } = hookCounter();
		const req = new Fch(`${B}/a`).use(plugin);
		await toCall(req);
		expect(counts).toMatchObject({ request: 1, success: 1 });
		expect(sent).toHaveLength(1);
	});

	test("start() then await fires hooks once", async () => {
		const { counts, plugin } = hookCounter();
		const req = new Fch(`${B}/b`).use(plugin).start();
		await req;
		expect(counts).toMatchObject({ request: 1, success: 1 });
		expect(sent).toHaveLength(1);
	});

	test("a plain send fires hooks once", async () => {
		const { counts, plugin } = hookCounter();
		await new Fch(`${B}/c`).use(plugin).send();
		expect(counts).toMatchObject({ request: 1, success: 1 });
	});

	test("poll() runs hooks on every iteration", async () => {
		const { counts, plugin } = hookCounter();
		const req = new Fch(`${B}/p`).use(plugin);
		const it = req.poll(0);
		for (let i = 0; i < 3; i++) await it.next();
		await it.return(undefined);
		expect(counts.request).toBe(3);
		expect(counts.success).toBe(3);
	});
});

describe("clone() keeps plugins, fetch and timers", () => {
	test("plugins are attached again with their own hooks", async () => {
		const { counts, plugin } = hookCounter();
		const original = new Fch(`${B}/x`).use(plugin);
		const copy = original.clone();
		expect(copy.plugins).toEqual(["counter"]);
		await copy.send();
		expect(counts.request).toBe(1);
	});

	test("a custom fetch is carried over", async () => {
		const custom = vi.fn(async () => new Response("{}"));
		const copy = new Fch(`${B}/y`, { fetch: custom as unknown as typeof fetch }).clone();
		await copy.send();
		expect(custom).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(0);
	});

	test("UI timer settings are carried over", async () => {
		// delayMs 0 moves to "delayed" on the next tick; the clone must inherit that.
		// The fetch must stay in flight past the delay, or "delayed" never happens.
		const slow = (async () => {
			await new Promise((r) => setTimeout(r, 30));
			return new Response("{}");
		}) as unknown as typeof fetch;
		const copy = new Fch(`${B}/z`, { delayMs: 5, timeoutMs: 1000, fetch: slow }).clone();
		const seen: string[] = [];
		copy.onTimer((state) => seen.push(state));
		await copy.send();
		expect(seen).toContain("delayed");
	});

	test("debug set by enableLogging survives clone()", () => {
		const original = new Fch(`${B}/d`).use(logger());
		(original as unknown as { enableLogging(): Fch }).enableLogging();
		expect(original.debug).toBe(true);
		expect(original.clone().debug).toBe(true);
	});
});

describe("create() `encode` default", () => {
	test("encode from create() applies to shortcut bodies", async () => {
		const api = fch.create({ baseUrl: B, encode: "urlencoded" });
		await api.post("/h", { a: 1, b: 2 });
		expect(String(sent[0].init.body)).toBe("a=1&b=2");
	});

	test("encode from create() never reaches fetch()", async () => {
		const api = fch.create({ baseUrl: B, encode: "urlencoded", retries: 0 });
		await api.post("/h", { a: 1 });
		expect(sent[0].init).not.toHaveProperty("encode");
		expect(sent[0].init).not.toHaveProperty("baseUrl");
	});

	test("a per-call encode overrides the create() default", async () => {
		const api = fch.create({ baseUrl: B, encode: "urlencoded" });
		await api.post("/h", { a: 1 }, { encode: "json" });
		expect(sent[0].init.headers).toBeDefined();
		expect(String(sent[0].init.body)).toBe('{"a":1}');
	});

	test("request() with create() defaults does not leak encode", () => {
		const api = fch.create({ baseUrl: B, encode: "urlencoded" });
		const req = api.request("/r");
		expect(req.fetchOptions).not.toHaveProperty("encode");
	});
});

describe("shortcut options", () => {
	test("the legacy four-argument form is rejected, not silently dropped", () => {
		const api = fch.create({ baseUrl: B });
		expect(() =>
			(api.post as (...a: unknown[]) => unknown)("/h", { a: 1 }, "urlencoded", { retries: 2 }),
		).toThrow(/at most 3 arguments/);
	});

	test("null in the options slot does not throw", async () => {
		const api = fch.create({ baseUrl: B });
		await expect(api.post("/h", { a: 1 }, null as unknown as object)).resolves.toBeDefined();
	});
});

describe("abort() and timeouts", () => {
	test("setTimeout rejects negative and NaN values", () => {
		const req = new Fch(`${B}/t`);
		expect(() => req.setTimeout(-1)).toThrow(/Invalid timeout/);
		expect(() => req.setTimeout(Number.NaN)).toThrow(/Invalid timeout/);
		expect(() => new Fch(`${B}/t`, { timeout: -5 })).toThrow(/Invalid timeout/);
	});

	test("abort() does not poison the instance", async () => {
		const req = new Fch(`${B}/ab`);
		req.abort();
		await req.send();
		expect(sent).toHaveLength(1);
	});
});
