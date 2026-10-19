import { describe, expect, test, beforeEach, afterEach } from "vitest";
import fch, { raw } from "../src/Fch.literal";
import { Fch } from "../src/Fch";

// The tagged-template entry point: one value that is both the request and a
// promise for [parsedBody, response].

let realFetch: typeof fetch;
let calls: { url: string; init: RequestInit }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	calls = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ id: 1, name: "Alice" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("fch tagged template", () => {
	test("awaits to [parsedBody, response]", async () => {
		const [user, response] = await fch`https://api.example.com/users/1`;

		expect(user).toEqual({ id: 1, name: "Alice" });
		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.example.com/users/1");
	});

	test("is also the request builder", async () => {
		const request = fch`https://api.example.com/users/1`;

		expect(request.request).toBeInstanceOf(Fch);
		expect(typeof request.json).toBe("function");
		expect(typeof request.text).toBe("function");
		expect(typeof request.blob).toBe("function");
		expect(typeof request.send).toBe("function");

		// The request already started, so the helpers reuse it.
		const [user] = await request.json();
		expect(user.name).toBe("Alice");
		expect(calls).toHaveLength(1);
	});

	test("the request has already started, so later setters cannot affect it", async () => {
		const request = fch`https://api.example.com/users/1`;

		// Documented consequence of eager start: the snapshot is taken when the
		// call is created, so a header set afterwards does not reach the wire.
		request.request.setHeader("X-Test", "1");
		await request;

		expect(new Headers(calls[0].init.headers).get("X-Test")).toBeNull();
		expect(typeof request.request.abort).toBe("function");
	});

	test("starts the request immediately (fire and forget)", async () => {
		fch`https://api.example.com/events`;
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toHaveLength(1);
	});

	test("interpolates numbers and encodes them", async () => {
		const id = 42;
		await fch`https://api.example.com/users/${id}`;

		expect(calls[0].url).toBe("https://api.example.com/users/42");
	});

	test("URL-encodes interpolated values by default", async () => {
		const hostile = "42/../admin?x=1&y=2";
		await fch`https://api.example.com/users/${hostile}`;

		// The value stays inside its path segment: no traversal, no injected query.
		expect(calls[0].url).toBe(
			"https://api.example.com/users/42%2F..%2Fadmin%3Fx%3D1%26y%3D2"
		);
		expect(new URL(calls[0].url).search).toBe("");
	});

	test("encodes spaces and unicode rather than dropping them", async () => {
		await fch`https://api.example.com/search/${"Tom & Jerry"}`;
		expect(calls[0].url).toBe("https://api.example.com/search/Tom%20%26%20Jerry");

		await fch`https://api.example.com/users/${"Иван"}`;
		expect(calls.at(-1)!.url).toBe(
			"https://api.example.com/users/%D0%98%D0%B2%D0%B0%D0%BD"
		);
	});

	test("raw() opts out of encoding", async () => {
		await fch`https://api.example.com/${raw("users/42")}`;
		expect(calls[0].url).toBe("https://api.example.com/users/42");
	});

	test("null and undefined interpolate as empty, not the literal word", async () => {
		await fch`https://api.example.com/users/${null}/posts/${undefined}`;
		expect(calls[0].url).toBe("https://api.example.com/users//posts/");
	});

	test("a non-absolute URL fails with the constructor's message", () => {
		expect(() => fch`/users/1`).toThrow(/requires an absolute URL/);
	});

	test("exposes the class for instanceof checks", () => {
		const request = fch`https://api.example.com/x`;
		expect(request.request instanceof fch.Fch).toBe(true);
		expect(fch.Fch).toBe(Fch);
	});

	test("typed generic flows through", async () => {
		const [user] = await fch<{ id: number; name: string }>`https://api.example.com/users/1`;
		expect(user.name).toBe("Alice");
	});
});
