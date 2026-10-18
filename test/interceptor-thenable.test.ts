import { describe, expect, test } from "vitest";
import { Fch } from "../src/Fch";

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

describe("safe-await probe", () => {
	test("S1_sync_concise", async () => {
		const calls = stub(5);
		const req = new Fch(`${B}/a`);
		req.before(((r: Fch) => r.setHeader("X-A", "1")) as Any);
		await req.makeRequest();
		expect(calls()).toBe(1);
		expect(req.getHeader("X-A")).toBe("1");
	});
	test("S2_async_concise", async () => {
		const calls = stub(5);
		let settled = false;
		const req = new Fch(`${B}/b`);
		req.before((async (r: Fch) => { r.setHeader("X-B", "1"); settled = true; }) as Any);
		await req.makeRequest();
		expect(calls()).toBe(1);
		expect(settled).toBe(true);
	});
	test("S4_rejected_hook_propagates", async () => {
		stub(5);
		const req = new Fch(`${B}/d`);
		req.before((() => Promise.reject(new Error("hook failed"))) as Any);
		await expect(req.makeRequest()).rejects.toThrow("hook failed");
	});
	test("S5_sync_throw_propagates", async () => {
		stub(5);
		const req = new Fch(`${B}/e`);
		req.before((() => { throw new Error("boom"); }) as Any);
		await expect(req.makeRequest()).rejects.toThrow("boom");
	});
});
