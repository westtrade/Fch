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

describe("fch method tags", () => {
	test("bodyless methods set the HTTP verb", async () => {
		await fch.get`https://api.example.com/u/1`;
		await fch.head`https://api.example.com/u/1`;
		await fch.options`https://api.example.com/u/1`;
		await fch.delete`https://api.example.com/u/1`;

		expect(calls.map((c) => c.init.method)).toEqual(["GET", "HEAD", "OPTIONS", "DELETE"]);
		for (const call of calls) expect(call.init.body ?? null).toBeNull();
	});

	test("del is an alias of delete", async () => {
		await fch.delete`https://api.example.com/u/1`;
		await fch.del`https://api.example.com/u/1`;

		expect(calls).toHaveLength(2);
		expect(calls[0].init.method).toBe("DELETE");
		expect(calls[1].init.method).toBe("DELETE");
		expect(calls[0].url).toBe(calls[1].url);
	});

	test("body-carrying methods take the body first, then the URL", async () => {
		await fch.post({ name: "Ann" })`https://api.example.com/users`;
		await fch.put({ name: "Ann" })`https://api.example.com/users/1`;
		await fch.patch({ name: "Ann" })`https://api.example.com/users/1`;

		expect(calls.map((c) => c.init.method)).toEqual(["POST", "PUT", "PATCH"]);
		for (const call of calls) {
			expect(call.init.body).toBe(JSON.stringify({ name: "Ann" }));
			expect(new Headers(call.init.headers).get("Content-Type")).toBe("application/json");
		}
	});

	test("arrays become JSON bodies too", async () => {
		await fch.post([{ id: 1 }, { id: 2 }])`https://api.example.com/batch`;
		expect(calls[0].init.body).toBe(JSON.stringify([{ id: 1 }, { id: 2 }]));
	});

	test("binary bodies are passed through untouched", async () => {
		const blob = new Blob(["png"], { type: "image/png" });
		await fch.put(blob)`https://api.example.com/upload`;

		expect(calls[0].init.body).toBe(blob);
		// No Content-Type is imposed: the Blob carries its own.
		expect(new Headers(calls[0].init.headers).get("Content-Type")).toBeNull();
	});

	test("string bodies are sent as-is without a JSON content type", async () => {
		await fch.patch("plain text")`https://api.example.com/raw`;
		expect(calls[0].init.body).toBe("plain text");
		expect(new Headers(calls[0].init.headers).get("Content-Type")).toBeNull();
	});

	test("method tags return the same call shape as the bare tag", async () => {
		const call = fch.get`https://api.example.com/u/1`;

		expect(call.request).toBeInstanceOf(Fch);
		expect(typeof call.json).toBe("function");
		expect(typeof call.send).toBe("function");

		const [body] = await call;
		expect(body).toEqual({ id: 1, name: "Alice" });
	});

	test("method tags still encode interpolations", async () => {
		await fch.get`https://api.example.com/u/${"a/b"}`;
		expect(calls[0].url).toBe("https://api.example.com/u/a%2Fb");

		await fch.post({})`https://api.example.com/u/${"a/b"}`;
		expect(calls[1].url).toBe("https://api.example.com/u/a%2Fb");
	});

	test("a method tag on a relative URL fails like the constructor", () => {
		expect(() => fch.post({})`/users`).toThrow(/requires an absolute URL/);
		expect(() => fch.get`/users`).toThrow(/requires an absolute URL/);
	});
});
