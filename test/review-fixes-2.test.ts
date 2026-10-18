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

	test("the failure is reported to the logger exactly once", async () => {
		const logger = useLogger();
		stubFetch(() => {
			throw new Error("network down");
		});
		const req = new Fch(`${B}/x`, { logger });

		const caught = await req.catch((e) => (e as Error).message);

		expect(caught).toBe("network down");

		// The retry loop logs the failure; catch() must not add a second [ERROR]
		// line for the same error (it used to). One failed call, one error line.
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(String(logger.error.mock.calls[0][0])).toContain("Request failed");
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

// ---------------------------------------------------------------- B13

describe("B13 — poll() uses the caller's interval, not a retry backoff", () => {
	test("the poll delay is not clamped to maxRetryDelay", async () => {
		globalThis.fetch = vi.fn(async () => ok()) as unknown as typeof fetch;

		// timeout: 0 disables the per-request timer, so every setTimeout is the poll sleep.
		const req = new Fch(`${B}/x`, { maxRetryDelay: 1000, timeout: 0 });
		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			delays.push(ms);
			return realSetTimeout(fn, 0);
		}) as unknown as typeof setTimeout;

		try {
			const iterator = req.poll(60_000);
			await iterator.next();
			await Promise.race([iterator.next(), new Promise((r) => realSetTimeout(r, 20))]);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}

		expect(delays[0]).toBe(60_000);
	});
});

// ---------------------------------------------------------------- B14

describe("B14 — retry backoff still honours maxRetryDelay", () => {
	test("the backoff sleep stays within the cap plus jitter", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("down");
		}) as unknown as typeof fetch;

		const req = new Fch(`${B}/x`, {
			maxRetryDelay: 50,
			timeout: 0,
			retries: 3,
			retryDelay: 100_000,
		});

		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			delays.push(ms);
			return realSetTimeout(fn, 0);
		}) as unknown as typeof setTimeout;

		try {
			await req.send().catch(() => {});
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}

		// 50ms cap + at most 20% jitter.
		expect(Math.max(...delays)).toBeLessThanOrEqual(60);
	});
});

// ---------------------------------------------------------------- B15

describe("B15 — the fallback signal wiring releases its listeners", () => {
	test("a pre-aborted signal leaves nothing hooked on the master", async () => {
		const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
		// Force the hand-wired branch that runtimes without AbortSignal.any use.
		delete (AbortSignal as unknown as { any?: unknown }).any;

		try {
			globalThis.fetch = vi.fn(async () => ok()) as unknown as typeof fetch;
			const external = new AbortController();
			external.abort();

			const req = new Fch(`${B}/x`, { signal: external.signal });
			for (let i = 0; i < 20; i++) await req.send().catch(() => {});

			const master = (req as unknown as { masterController: AbortController }).masterController;
			const eventsSymbol = Object.getOwnPropertySymbols(master.signal).find(
				(symbol) => String(symbol) === "Symbol(kEvents)"
			);
			const events = eventsSymbol
				? (master.signal as unknown as Record<symbol, Map<string, Set<unknown>>>)[eventsSymbol]
				: undefined;

			expect(events?.get("abort")?.size ?? 0).toBe(0);
		} finally {
			if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
		}
	});
});

// ---------------------------------------------------------------- B16

describe("B16 — concurrent requests keep separate timeout state", () => {
	test("a later healthy request does not erase an earlier request's timeout", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(((_url: string, init: RequestInit) => {
			calls += 1;
			if (calls === 1) {
				// Starts first, finishes last: this is the request that times out.
				return new Promise((_resolve, reject) =>
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("Request timeout", "TimeoutError"))
					)
				);
			}
			// Starts second, succeeds and clears only its own timeout state.
			return new Promise((resolve) => setTimeout(() => resolve(ok()), 60));
		}) as unknown as typeof fetch);

		const req = new Fch(`${B}/x`, { timeout: 30, retries: 0 });
		const failing = req.send().catch((error) => error);
		const healthy = req.send().catch((error) => error);

		await Promise.all([failing, healthy]);
		// The healthy request settles AFTER the timeout fired. A single shared
		// boolean would be reset to false here and hide the timeout entirely.
		expect(req.aborted).toBe(true);
	});

	test("aborted is true once a lone request has timed out", async () => {
		globalThis.fetch = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) =>
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("Request timeout", "TimeoutError"))
					)
				)
		) as unknown as typeof fetch;

		const req = new Fch(`${B}/slow`, { timeout: 20, retries: 0 });
		await req.send().catch(() => {});

		expect(req.aborted).toBe(true);
	});
});

// ---------------------------------------------------------------- B17

describe("B17 — a relative baseUrl fails with a useful message", () => {
	test("names the problem instead of an opaque Invalid URL", () => {
		expect(() => create({ baseUrl: "/api" }).get("/x")).toThrow(/absolute `baseUrl`/);
	});

	test("an absolute baseUrl keeps working", () => {
		expect(create({ baseUrl: B }).request("/x").toString()).toBe(`${B}/x`);
	});
});

// ---------------------------------------------------------------- B18

describe("B18 — setSearchParams replaces the query", () => {
	test("previous params are cleared", () => {
		const req = new Fch(`${B}/x?a=1&b=2`).setSearchParams({ page: 2 });

		expect(req.search).toBe("?page=2");
	});

	test("appendSearchParams still appends repeated values", () => {
		const req = new Fch(`${B}/x?a=1`).appendSearchParams({ tag: ["x", "y"] });

		expect(req.searchParams.getAll("tag")).toEqual(["x", "y"]);
	});
});

// ---------------------------------------------------------------- B19

describe("B19 — method validation is the same in the constructor and setMethod", () => {
	test("both reject an unsupported method", () => {
		expect(() => new Fch(B, { method: "FOO" })).toThrow(/Unsupported HTTP method/);
		expect(() => new Fch(B).setMethod("FOO")).toThrow(/Unsupported HTTP method/);
		expect(() => {
			new Fch(B).method = "FOO";
		}).toThrow(/Unsupported HTTP method/);
	});

	test("a lowercase method is still normalised", () => {
		expect(new Fch(B, { method: "post" }).method).toBe("POST");
	});
});

// ---------------------------------------------------------------- B20

describe("B20 — setFetchOptions validates the method too", () => {
	test("rejects an unsupported method instead of smuggling it through", () => {
		const req = new Fch(B);

		expect(() => req.setFetchOptions({ method: "FOO" })).toThrow(/Unsupported HTTP method/);
		expect(req.setFetchOptions({ method: "patch" }).method).toBe("PATCH");
	});
});

// ---------------------------------------------------------------- B21

describe("B21 — a form passed to get/head/delete lands in the query string", () => {
	function form(fields: Record<string, string>): FormData {
		const data = new FormData();
		for (const [key, value] of Object.entries(fields)) data.append(key, value);
		return data;
	}

	test("get(url, form) serialises the fields into the query", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return ok();
		}) as unknown as typeof fetch;

		await create({ baseUrl: B }).get("/x", form({ a: "1", b: "2" })).send();

		expect(seen[0].url).toBe(`${B}/x?a=1&b=2`);
		// The form's own properties must not leak into the fetch init object.
		expect(Object.keys(seen[0].init)).not.toContain("nodeType");
		expect(seen[0].init.body ?? null).toBeNull();
	});

	test("head(url, form) does the same", async () => {
		const seen: { url: string }[] = [];
		globalThis.fetch = vi.fn(async (url: string) => {
			seen.push({ url });
			return ok();
		}) as unknown as typeof fetch;

		await create({ baseUrl: B }).head("/x", form({ q: "z" })).send();

		expect(seen[0].url).toBe(`${B}/x?q=z`);
	});

	test("delete(url, form) keeps the DELETE method and uses the query", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return ok();
		}) as unknown as typeof fetch;

		await create({ baseUrl: B }).delete("/x", form({ id: "7" })).send();

		expect(seen[0].url).toBe(`${B}/x?id=7`);
		expect(seen[0].init.method).toBe("DELETE");
	});

	test("get(url, options) still treats the second argument as options", async () => {
		globalThis.fetch = vi.fn(async () => ok()) as unknown as typeof fetch;

		const request = create({ baseUrl: B }).get("/x", { timeout: 42 }).request;

		expect(request.timeout).toBe(42);
		expect(request.toString()).toBe(`${B}/x`);
	});
});

// ---------------------------------------------------------------- B22

describe("B22 — makeRequest takes no positional overrides", () => {
	test("the retry configuration comes from the instance", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls += 1;
			throw new Error("down");
		}) as unknown as typeof fetch;

		await new Fch(`${B}/x`, { retries: 2, retryDelay: 0 }).makeRequest().catch(() => {});

		expect(calls).toBe(3);
	});

	test("the signature has no parameters", () => {
		expect(Fch.prototype.makeRequest.length).toBe(0);
	});
});

// ---------------------------------------------------------------- B23

describe("B23 — clone() does not inherit the caller's abort signal", () => {
	test("aborting the original controller leaves the clone running", async () => {
		let sawAbort = false;
		globalThis.fetch = vi.fn(((_url: string, init: RequestInit) => {
			return new Promise((resolve) => {
				init.signal?.addEventListener("abort", () => {
					sawAbort = true;
				});
				setTimeout(() => resolve(ok()), 30);
			});
		}) as unknown as typeof fetch);

		const controller = new AbortController();
		const original = new Fch(`${B}/x`).setFetchOptions({ signal: controller.signal });
		const clone = original.clone();

		const pending = clone.send();
		controller.abort();

		await expect(pending).resolves.toBeInstanceOf(Response);
		expect(sawAbort).toBe(false);
	});

	test("other fetch options are still copied", () => {
		const original = new Fch(B).setFetchOptions({ credentials: "include", cache: "no-store" });
		const clone = original.clone();

		expect((clone.fetchOptions as RequestInit).credentials).toBe("include");
		expect((clone.fetchOptions as RequestInit).signal).toBeUndefined();
	});
});

// ---------------------------------------------------------------- B24

describe("B24 — the baseURL alias keeps working from one place", () => {
	const api = () => create({ baseURL: B, timeout: 7 });

	test("create({ baseURL }) applies to shortcuts", async () => {
		const seen: string[] = [];
		globalThis.fetch = vi.fn(async (url: string) => {
			seen.push(url);
			return ok();
		}) as unknown as typeof fetch;

		await api().get("/x").send();

		expect(seen[0]).toBe(`${B}/x`);
	});

	test("create({ baseURL }) applies to request()", () => {
		expect(api().request("/y").toString()).toBe(`${B}/y`);
	});

	test("a per-call baseURL overrides the shared base", () => {
		expect(
			create({ baseUrl: B }).request("/z", { baseURL: "https://other.test" }).toString()
		).toBe("https://other.test/z");
	});

	test("baseUrl wins when both spellings are given", () => {
		const mixed = create({ baseUrl: "https://a.test", baseURL: "https://b.test" });

		expect(mixed.request("/p").toString()).toBe("https://a.test/p");
	});

	test("neither key leaks into the fetch init", async () => {
		const seen: RequestInit[] = [];
		globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			seen.push(init);
			return ok();
		}) as unknown as typeof fetch;

		await create({ baseURL: B, timeout: 5 }).get("/x").send();

		expect(Object.keys(seen[0])).not.toContain("baseURL");
		expect(Object.keys(seen[0])).not.toContain("baseUrl");
	});
});
