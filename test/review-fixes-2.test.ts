// Regression tests for the second-round review findings (B1–B7 + cleanup).
import { describe, expect, test, vi } from "vitest";
import { Fch, fch, create, type Logger } from "../src/Fch";

const B = "https://api.example.com";

const ok = (body = '{"ok":true}', status = 200) =>
	new Response(body, { status, headers: { "content-type": "application/json" } });

/** Replace `fetch` with a stub that records every call. */
function stubFetch(impl: () => Response | Promise<Response>) {
	const calls: string[] = [];
	globalThis.fetch = vi.fn(async (url: string) => {
		calls.push(String(url));
		return impl();
	}) as unknown as typeof fetch;
	return () => calls;
}

/** A custom logger so log output is observable without touching console. */
const useLogger = (): Logger & { mock: Logger } => {
	const mock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return Object.assign(mock, { mock });
};

// ---------------------------------------------------------------- B1

describe("B1 — catch() logs only on a real rejection", () => {
	test("no error line when the request succeeds", async () => {
		const logger = useLogger();
		stubFetch(() => ok());
		const req = new Fch(`${B}/x`, { logger });

		await req.catch(() => {});

		expect(logger.error).not.toHaveBeenCalled();
	});

	test("logs once when the request actually fails", async () => {
		const logger = useLogger();
		stubFetch(() => {
			throw new Error("network down");
		});
		const req = new Fch(`${B}/x`, { logger });

		const caught = await req.catch((e) => (e as Error).message);

		expect(caught).toBe("network down");

		// Exactly one of the error lines is the catch() one; the retry loop also
		// logs "Request failed", which is fine.
		const catchLogs = logger.error.mock.calls.filter(([msg]) =>
			String(msg).includes("Caught an error")
		);
		expect(catchLogs).toHaveLength(1);
	});
});

// ---------------------------------------------------------------- B2

describe("B2 — clone() keeps repeated search params", () => {
	test("tag=a&tag=b survives clone()", () => {
		const req = new Fch(`${B}/items?tag=a&tag=b`);
		const cloned = req.clone();

		expect(cloned.toString()).toBe(req.toString());
		expect(cloned.searchParams.getAll("tag")).toEqual(["a", "b"]);
	});

	test("config and headers survive clone()", () => {
		const req = new Fch(`${B}/x`, { retries: 3, timeout: 1234, method: "POST" })
			.setAuthToken("tok")
			.setSearchParams({ page: 2 });

		const cloned = req.clone();

		expect(cloned.retries).toBe(3);
		expect(cloned.timeout).toBe(1234);
		expect(cloned.method).toBe("POST");
		expect(cloned.getHeader("Authorization")).toBe("Bearer tok");
		expect(cloned.searchParams.get("page")).toBe("2");
	});
});

// ---------------------------------------------------------------- B3

describe("B3 — body helpers stay usable on a memoised request", () => {
	test("json() twice after start()", async () => {
		const calls = stubFetch(() => ok());
		const req = new Fch(`${B}/y`).start();

		const [a] = await req.json();
		const [b] = await req.json();

		expect(a).toEqual({ ok: true });
		expect(b).toEqual({ ok: true });
		expect(calls()).toHaveLength(1);
	});

	test("the returned response body is still readable", async () => {
		stubFetch(() => ok());
		const req = new Fch(`${B}/y`).start();

		const [, response] = await req.json();
		await expect(response.text()).resolves.toBe('{"ok":true}');
	});

	test("a shortcut call supports json() then text()", async () => {
		stubFetch(() => ok());
		const call = create({ baseUrl: B }).post("/p", { k: 1 });

		const [data] = await call.json();
		expect(data).toEqual({ ok: true });

		const [text] = await call.text();
		expect(text).toContain('"ok":true');
	});
});

// ---------------------------------------------------------------- B4

describe("B4 — poll() keeps polling on an already-started instance", () => {
	test("each iteration is a fresh request", async () => {
		const calls = stubFetch(() => ok());
		const req = new Fch(`${B}/z`).start();

		const seen = new Set<Response>();
		let iterations = 0;
		for await (const response of req.poll(5)) {
			seen.add(response as Response);
			if (++iterations === 3) break;
		}

		// 1 eager request + 3 poll iterations.
		expect(calls()).toHaveLength(4);
		expect(seen.size).toBe(3);
	});
});

// ---------------------------------------------------------------- B5

describe("B5 — a throwing after() hook is not retried", () => {
	test("one fetch attempt despite retries", async () => {
		const calls = stubFetch(() => ok());
		const req = new Fch(`${B}/i`, { retries: 2 }).after(() => {
			throw new Error("Unauthorized");
		});

		await expect(req.send()).rejects.toThrow("Unauthorized");
		expect(calls()).toHaveLength(1);
	});

	test("the failure is logged as an interceptor error", async () => {
		const logger = useLogger();
		stubFetch(() => ok());
		const req = new Fch(`${B}/i2`, { retries: 2, logger }).after(() => {
			throw new Error("Unauthorized");
		});

		await expect(req.send()).rejects.toThrow("Unauthorized");
		expect(logger.error).toHaveBeenCalledWith("Response interceptor failed:", "Unauthorized");
	});
});

// ---------------------------------------------------------------- B6

describe("B6 — setBasicAuth accepts non-Latin1 credentials", () => {
	test("unicode username and password", () => {
		const req = new Fch(`${B}/basic`).setBasicAuth("пользователь", "пароль");

		// Expected via Node's Buffer — an independent path from the library's
		// TextEncoder + btoa.
		const expected = Buffer.from("пользователь:пароль", "utf8").toString("base64");
		expect(req.getHeader("Authorization")).toBe(`Basic ${expected}`);
	});

	test("ascii credentials keep working", () => {
		const req = new Fch(`${B}/basic`).setBasicAuth("user", "pass");

		expect(req.getHeader("Authorization")).toBe("Basic dXNlcjpwYXNz");
	});
});

// ---------------------------------------------------------------- B7

describe("B7 — protocol-relative URLs", () => {
	test("resolved against baseUrl", () => {
		const api = create({ baseUrl: `${B}/api` });

		expect(api.get("//cdn.example/asset").request.toString()).toBe(
			"https://cdn.example/asset"
		);
	});

	test("without a base, the error names the problem", () => {
		expect(() => create({}).get("//cdn.example/asset")).toThrow(/protocol-relative/);
	});
});

// ---------------------------------------------------------------- cleanup

describe("factory exports", () => {
	test("fch() builds an Fch", () => {
		const req = fch(`${B}/x`, { retries: 1 });

		expect(req).toBeInstanceOf(Fch);
		expect(req.retries).toBe(1);
	});

	test("the named fch export exposes create() (typed)", () => {
		const api = fch.create({ baseUrl: B });

		expect(api.get("/x")).toBeDefined();
		expect(api.request("/x")).toBeInstanceOf(Fch);
	});
});

// ---------------------------------------------------------------- B8

describe("B8 — create() defaults apply to shortcut methods", () => {
	test("retries, timeout and headers reach get()/post()", async () => {
		const seen: { init: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (_u: string, init: RequestInit) => {
			seen.push({ init });
			return ok();
		}) as unknown as typeof fetch;

		const api = create({
			baseUrl: B,
			retries: 2,
			timeout: 500,
			headers: { "X-Api": "1" },
		});

		const request = api.get("/x").request;

		expect(request.retries).toBe(2);
		expect(request.timeout).toBe(500);
		expect(request.getHeader("X-Api")).toBe("1");

		await api.get("/x");

		expect(new Headers(seen[0].init.headers).get("X-Api")).toBe("1");
	});

	test("per-call options override defaults without dropping shared headers", () => {
		const api = create({ baseUrl: B, timeout: 500, headers: { "X-Api": "1" } });

		const request = api.get("/x", { timeout: 99, headers: { "X-Trace": "t" } }).request;

		expect(request.timeout).toBe(99);
		expect(request.getHeader("X-Api")).toBe("1");
		expect(request.getHeader("X-Trace")).toBe("t");
	});
});

// ---------------------------------------------------------------- B9

describe("B9 — a failed eager request does not poison the builder", () => {
	test("start() then a failed send() allows a fresh attempt", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls += 1;
			throw new Error(`down-${calls}`);
		}) as unknown as typeof fetch;

		const req = new Fch(`${B}/x`).start();

		await req.send().catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 10));
		await req.send().catch(() => {});

		expect(calls).toBe(2);
	});
});

// ---------------------------------------------------------------- B10

describe("B10 — clone() keeps the body and its Content-Type", () => {
	test("JSON body survives a clone as JSON", async () => {
		const seen: { init: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (_u: string, init: RequestInit) => {
			seen.push({ init });
			return ok();
		}) as unknown as typeof fetch;

		await new Fch(`${B}/x`, { method: "POST" }).setJsonBody({ a: 1 }).clone().send();

		expect(new Headers(seen[0].init.headers).get("Content-Type")).toBe("application/json");
		expect(seen[0].init.body).toBe('{"a":1}');
	});

	test("URLSearchParams body is copied, not silently dropped", async () => {
		const seen: { init: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (_u: string, init: RequestInit) => {
			seen.push({ init });
			return ok();
		}) as unknown as typeof fetch;

		await new Fch(`${B}/x`, { method: "POST" }).setFormUrlEncodedBody({ a: 1 }).clone().send();

		expect(seen[0].init.body).toBeInstanceOf(URLSearchParams);
		expect(new Headers(seen[0].init.headers).get("Content-Type")).toBe(
			"application/x-www-form-urlencoded"
		);
	});

	test("ArrayBuffer bytes are copied rather than shared", () => {
		const source = new Uint8Array([1, 2, 3]);
		const req = new Fch(`${B}/x`, { method: "POST" }).setBody(source, "application/octet-stream");

		expect(req.clone().fetchOptions.body).not.toBe(source);
	});
});

// ---------------------------------------------------------------- B11

describe("B11 — delete(url, options) does not serialise options as a body", () => {
	test("the second argument is options, and no body is sent", async () => {
		const seen: { init: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (_u: string, init: RequestInit) => {
			seen.push({ init });
			return ok();
		}) as unknown as typeof fetch;

		await create({ baseUrl: B }).delete("/houses/1", { timeout: 100 }).send();

		// `null`, not a serialised options object — fetch treats both as "no body".
		expect(seen[0].init.body).toBeNull();
		expect(seen[0].init.method).toBe("DELETE");
	});
});

// ---------------------------------------------------------------- B12

describe("B12 — shortcuts are generic", () => {
	test("get<T>() types the resolved body", async () => {
		globalThis.fetch = vi.fn(async () => ok('[{"id":7}]')) as unknown as typeof fetch;

		const [houses] = await create({ baseUrl: B }).get<{ id: number }[]>("/houses");

		expect(houses).toEqual([{ id: 7 }]);
	});
});
