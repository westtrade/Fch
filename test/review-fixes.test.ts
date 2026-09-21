import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { server } from "./msw/server";
import { Fch, type Logger } from "../src/Fch";

const B = "https://api.example.com";

// `stubFetch` replaces the global fetch; restore whatever MSW installed before
// each test so a stub can never leak into the next one.
let installedFetch: typeof fetch;
beforeEach(() => {
	installedFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = installedFetch;
});

/** Replace global fetch with a controllable stub. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	}) as unknown as typeof fetch;
	return calls;
}

const ok = () => new Response("{}", { status: 200 });

describe("B1 — idempotency/dedupe key is resolved once per request", () => {
	test("factory is invoked once and header equals the dedupe identity", async () => {
		let calls = 0;

		const req = new Fch(`${B}/pay`, {
			method: "POST",
			dedupe: true,
			dedupeKey: () => `key-${++calls}`,
		});

		// Our dedupe identity and the wire header must be the same value.
		let seenHeader: string | null = null;
		server.use(
			http.post(`${B}/pay`, ({ request }) => {
				seenHeader = request.headers.get("Idempotency-Key");
				return HttpResponse.json({ ok: true });
			})
		);

		await req.makeRequest();

		expect(calls).toBe(1);
		expect(seenHeader).toBe("key-1");
	});

	test("surviving a retry reuses the same key", async () => {
		let factoryCalls = 0;
		const headers: (string | null)[] = [];

		server.use(
			http.post(`${B}/retry-pay`, ({ request }) => {
				headers.push(request.headers.get("Idempotency-Key"));
				return HttpResponse.json({ ok: false }, { status: 500 });
			})
		);

		const req = new Fch(`${B}/retry-pay`, {
			method: "POST",
			retries: 2,
			retryDelay: 0,
			dedupeKey: () => `k-${++factoryCalls}`,
		});
		req.setRetryOn((response) => response?.status === 500);

		await req.makeRequest();

		expect(factoryCalls).toBe(1);
		expect(headers).toEqual(["k-1", "k-1", "k-1"]);
	});
});

describe("B2 — setFetchOptions headers reach the wire", () => {
	test("headers passed to setFetchOptions are sent", async () => {
		let seen: string | null = null;
		server.use(
			http.get(`${B}/hdr`, ({ request }) => {
				seen = request.headers.get("X-From-Options");
				return HttpResponse.text("ok");
			})
		);

		const req = new Fch(`${B}/hdr`);
		req.setFetchOptions({ headers: { "X-From-Options": "yes" } });
		await req.makeRequest();

		expect(seen).toBe("yes");
	});

	test("non-header options still merge as before", async () => {
		const calls = stubFetch(() => ok());
		const req = new Fch(`${B}/hdr`);
		req.setFetchOptions({ credentials: "include" });
		await req.makeRequest();

		expect(calls[0].init.credentials).toBe("include");
	});
});

describe("B3 — package.json types entry points at a real file", () => {
	test('"types" resolves to the emitted declaration file', () => {
		const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
		expect(pkg.types).toBe("dist/Fch.d.ts");
		expect(pkg.main).toBe("dist/Fch.js");
	});
});

describe("H1 — abort() does not brick the instance", () => {
	test("a request after abort() succeeds", async () => {
		server.use(http.get(`${B}/after-abort`, () => HttpResponse.text("ok")));

		const req = new Fch(`${B}/after-abort`);
		req.abort();
		expect(req.aborted).toBe(true);

		const res = await req.makeRequest();
		expect(res.status).toBe(200);
		await expect(res.text()).resolves.toBe("ok");
	});

	test("abort() still cancels an in-flight request", async () => {
		server.use(
			http.get(`${B}/slow-abort`, async () => {
				await new Promise((r) => setTimeout(r, 3000));
				return HttpResponse.text("late");
			})
		);

		const req = new Fch(`${B}/slow-abort`);
		const pending = req.makeRequest();
		req.abort();

		await expect(pending).rejects.toBeDefined();
	});

	test("a caller-supplied AbortController is not aborted by abort()", () => {
		const controller = new AbortController();
		const req = new Fch(`${B}/x`, { abortController: controller });
		req.abort();
		expect(controller.signal.aborted).toBe(false);
	});

	test("the deprecated controller can still cancel a request", async () => {
		server.use(
			http.get(`${B}/slow-ext`, async () => {
				await new Promise((r) => setTimeout(r, 3000));
				return HttpResponse.text("late");
			})
		);

		const controller = new AbortController();
		const req = new Fch(`${B}/slow-ext`, { abortController: controller });
		const pending = req.makeRequest();
		controller.abort();

		await expect(pending).rejects.toBeDefined();
	});
});

describe("H2 — aborted reflects a timeout", () => {
	test("aborted is true after the timeout fires", async () => {
		stubFetch(
			(_url, init) =>
				new Promise((_res, rej) => {
					init.signal?.addEventListener("abort", () =>
						rej(new DOMException("Request timeout", "TimeoutError"))
					);
				})
		);

		const req = new Fch(`${B}/never`, { timeout: 20, retries: 0 });
		await req.makeRequest().catch(() => {});

		expect(req.aborted).toBe(true);
	});

	test("aborted is false after a successful request", async () => {
		stubFetch(() => ok());
		const req = new Fch(`${B}/ok`, { timeout: 1000 });
		await req.makeRequest();
		expect(req.aborted).toBe(false);
	});
});

describe("H3 — request interceptors run before every attempt", () => {
	test("interceptor runs once per attempt", async () => {
		let interceptorRuns = 0;
		let fetchCalls = 0;

		stubFetch(() => {
			fetchCalls += 1;
			throw new Error("network down");
		});

		const req = new Fch(`${B}/flaky`, { retries: 2, retryDelay: 0 });
		req.addRequestInterceptor(() => {
			interceptorRuns += 1;
		});

		await req.makeRequest().catch(() => {});

		expect(fetchCalls).toBe(3);
		expect(interceptorRuns).toBe(3);
	});

	test("interceptor can refresh a per-attempt header", async () => {
		let n = 0;
		const seen: (string | null)[] = [];
		let attempt = 0;

		server.use(
			http.get(`${B}/token`, ({ request }) => {
				seen.push(request.headers.get("X-Attempt"));
				attempt += 1;
				return attempt < 3
					? HttpResponse.json({}, { status: 500 })
					: HttpResponse.json({ ok: true });
			})
		);

		const req = new Fch(`${B}/token`, { retries: 2, retryDelay: 0 });
		req.setRetryOn((response) => response?.status === 500);
		req.addRequestInterceptor((r) => {
			n += 1;
			r.setHeader("X-Attempt", String(n));
		});

		await req.makeRequest();
		expect(seen).toEqual(["1", "2", "3"]);
	});
});

describe("H4 — invalid logger falls back instead of swallowing logs", () => {
	test("a malformed logger is replaced by the default logger", () => {
		const logs: unknown[][] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a);
		});

		const req = new Fch(`${B}/x`, {
			debug: true,
			logger: { info: "not-a-function" } as unknown as Logger,
		});
		req.getLogger().info("hello");

		spy.mockRestore();
		expect(logs).toEqual([["[INFO]", "hello"]]);
	});

	test("a valid logger is used as-is", () => {
		const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const req = new Fch(`${B}/x`, { debug: true, logger });
		req.getLogger().info("kept");
		expect(logger.info).toHaveBeenCalledWith("kept");
	});

	test("setLogger validates too", () => {
		const logs: unknown[][] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a);
		});

		const req = new Fch(`${B}/x`, { debug: true });
		req.setLogger({ info: "broken" } as unknown as Logger);
		req.getLogger().info("via default");

		spy.mockRestore();
		expect(logs).toEqual([["[INFO]", "via default"]]);
	});
});

describe("H5 — error/warn logging is not gated by the debug flag", () => {
	test("logger.error emits with debug disabled", () => {
		const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const req = new Fch(`${B}/x`, { logger, debug: false });

		req.getLogger().error("boom");

		expect(logger.error).toHaveBeenCalledWith("boom");
	});

	test("logger.warn emits with debug disabled, info stays quiet", () => {
		const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const req = new Fch(`${B}/x`, { logger, debug: false });

		req.getLogger().warn("careful");
		req.getLogger().info("chatty");

		expect(logger.warn).toHaveBeenCalledWith("careful");
		expect(logger.info).not.toHaveBeenCalled();
	});

	test("a failed request logs an error even without debug", async () => {
		const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		stubFetch(() => {
			throw new Error("network down");
		});

		const req = new Fch(`${B}/boom`, { logger, retries: 0 });
		await req.makeRequest().catch(() => {});

		expect(logger.error).toHaveBeenCalled();
	});
});

describe("H6 — HTTP method is normalized regardless of how it is set", () => {
	test('lowercase method in options behaves as mutating', async () => {
		let seen: string | null = null;
		server.use(
			http.post(`${B}/norm`, ({ request }) => {
				seen = request.headers.get("Idempotency-Key");
				return HttpResponse.json({ ok: true });
			})
		);

		const req = new Fch(`${B}/norm`, { method: "post", dedupeKey: "k-1" });
		await req.makeRequest();

		expect(req.method).toBe("POST");
		expect(seen).toBe("k-1");
	});

	test("setMethod still validates and normalizes", () => {
		const req = new Fch(`${B}/x`);
		expect(req.setMethod("patch").method).toBe("PATCH");
		expect(() => req.setMethod("TRACE")).toThrow(TypeError);
	});
});

describe("H7 — dedupe never races body reads", () => {
	test("two concurrent identical requests both parse their body", async () => {
		let hits = 0;
		server.use(
			http.get(`${B}/shared`, () => {
				hits += 1;
				return HttpResponse.json({ hit: hits });
			})
		);

		const req = new Fch(`${B}/shared`, { dedupe: true });

		const [a, b] = await Promise.all([
			req.makeRequest().then((r) => r.json() as Promise<{ hit: number }>),
			req.makeRequest().then((r) => r.json() as Promise<{ hit: number }>),
		]);

		expect(hits).toBe(1);
		expect(a).toEqual({ hit: 1 });
		expect(b).toEqual({ hit: 1 });
	});

	test("dedupe still allows a fresh request after completion", async () => {
		let hits = 0;
		server.use(
			http.get(`${B}/sequential`, () => {
				hits += 1;
				return HttpResponse.json({ hit: hits });
			})
		);

		const req = new Fch(`${B}/sequential`, { dedupe: true });
		await (await req.makeRequest()).json();
		await (await req.makeRequest()).json();

		expect(hits).toBe(2);
	});
});

describe("regression guard — previously working behaviour", () => {
	test("retries=0 performs exactly one attempt", async () => {
		let n = 0;
		stubFetch(() => {
			n += 1;
			return ok();
		});
		const req = new Fch(`${B}/once`, { retries: 0 });
		await req.makeRequest();
		expect(n).toBe(1);
	});

	test("retries=2 performs 3 attempts on network errors", async () => {
		let n = 0;
		stubFetch(() => {
			n += 1;
			throw new Error("down");
		});
		const req = new Fch(`${B}/thrice`, { retries: 2, retryDelay: 0 });
		await req.makeRequest().catch(() => {});
		expect(n).toBe(3);
	});

	test("negative retries are rejected instead of silently doing nothing", async () => {
		stubFetch(() => ok());
		const req = new Fch(`${B}/bad`);
		await expect(req.makeRequest(-1)).rejects.toThrow(/Invalid retries/);
	});

	test("a resolved request returns a readable response", async () => {
		server.use(http.get(`${B}/json`, () => HttpResponse.json({ hello: "world" })));
		const req = new Fch(`${B}/json`);
		const [data] = await req.json<{ hello: string }>();
		expect(data).toEqual({ hello: "world" });
	});
});
