import { describe, expect, test } from "vitest";
import { Fch } from "../src/Fch";

// `Fch` is thenable. A request hook written as a concise arrow that returns a
// chaining call (`(req) => req.setHeader(...)`) returns the instance itself, and
// awaiting that would start another request — recursively. These tests pin the
// guard that awaits only genuine promises.
type Any = (request: Fch) => unknown;
const B = "https://api.example.com";

function stub(cap: number) {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		if (calls > cap) throw new Error("CAP_REACHED");
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	}) as unknown as typeof fetch;
	return () => calls;
}

describe("request hooks are not awaited as thenables", () => {
	test("a hook returning the instance does not start a second request", async () => {
		const calls = stub(5);
		const req = new Fch(`${B}/a`);
		req.before(((r: Fch) => r.setHeader("X-A", "1")) as Any);

		await req.makeRequest();

		expect(calls()).toBe(1);
		expect(req.getHeader("X-A")).toBe("1");
	});

	test("an async hook is awaited before the request is sent", async () => {
		const calls = stub(5);
		let settled = false;
		const req = new Fch(`${B}/b`);
		req.before((async (r: Fch) => {
			r.setHeader("X-B", "1");
			settled = true;
		}) as Any);

		await req.makeRequest();

		expect(calls()).toBe(1);
		expect(settled).toBe(true);
	});

	test("a rejected hook propagates instead of being swallowed", async () => {
		stub(5);
		const req = new Fch(`${B}/d`);
		req.before((() => Promise.reject(new Error("hook failed"))) as Any);

		await expect(req.makeRequest()).rejects.toThrow("hook failed");
	});

	test("a synchronously throwing hook propagates too", async () => {
		stub(5);
		const req = new Fch(`${B}/e`);
		req.before((() => {
			throw new Error("boom");
		}) as Any);

		await expect(req.makeRequest()).rejects.toThrow("boom");
	});
});
