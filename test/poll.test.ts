import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Fch } from "../src/Fch";
import { nanostores } from "../src/plugins/nanostores";

// poll() is a full execution per iteration: plugins, timers and the store must
// see every poll, but each iteration is a NEW request (never the eager memo).

let realFetch: typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Run `count` polls, then abort. */
async function take(req: Fch, count: number, delay = 5): Promise<unknown[]> {
	const controller = new AbortController();
	const seen: unknown[] = [];
	for await (const result of req.poll(delay, controller)) {
		seen.push(result);
		if (seen.length >= count) controller.abort();
	}
	return seen;
}

describe("poll", () => {
	test("yields a Response per iteration", async () => {
		let n = 0;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ n: ++n }), {
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;

		const results = await take(new Fch("https://api.example.com/jobs/1"), 3);

		expect(results).toHaveLength(3);
		expect(results.every((r) => r instanceof Response)).toBe(true);
	});

	test("each iteration is a separate request", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await take(new Fch("https://api.example.com/x", { retries: 0 }), 3);

		expect(calls).toBe(3);
	});

	test("a failure is yielded, not thrown, so the loop continues", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls === 1) throw new TypeError("network down");
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const results = await take(new Fch("https://api.example.com/x", { retries: 0 }), 2);

		expect(results[0]).toBeInstanceOf(TypeError);
		expect(results[1]).toBeInstanceOf(Response);
	});

	test("plugin hooks fire for every poll", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

		let success = 0;
		let requests = 0;
		const probe = {
			name: "probe",
			install({ onSuccess, onRequest }: never) {
				(onSuccess as (fn: () => void) => void)(() => success++);
				(onRequest as (fn: () => void) => void)(() => requests++);
			},
		};

		await take(new Fch("https://api.example.com/x").use(probe as never), 3);

		expect(requests).toBe(3);
		expect(success).toBe(3);
	});

	test("the nanostores plugin updates on every poll", async () => {
		globalThis.fetch = (async () =>
			new Response('{"ok":true}', {
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;

		const req = new Fch("https://api.example.com/x").use(nanostores());
		const states: string[] = [];
		req.listen((state) => states.push(state.timer));

		await take(req, 3);

		expect(req.get().data).toEqual({ ok: true });
		expect(req.get().loading).toBe(false);
		// Three executions: submitting -> idle each time.
		expect(states.filter((s) => s === "submitting")).toHaveLength(3);
	});

	test("the caller's interval is used exactly, not clamped", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number,
		) => {
			delays.push(ms);
			return realSetTimeout(fn, 0);
		}) as unknown as typeof setTimeout;

		try {
			const controller = new AbortController();
			const iterator = new Fch("https://api.example.com/x", {
				maxRetryDelay: 10,
				timeout: 0,
				delayMs: false,
				timeoutMs: false,
			}).poll(30_000, controller);

			await iterator.next();
			await iterator.next();
			controller.abort();
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}

		// The 30 s poll sleep, not the 10 ms retry cap.
		expect(delays).toContain(30_000);
	});

	test("aborting during the interval stops cleanly", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

		const controller = new AbortController();
		const iterations: unknown[] = [];

		for await (const result of new Fch("https://api.example.com/x", {
			delayMs: false,
			timeoutMs: false,
		}).poll(50, controller)) {
			iterations.push(result);
			controller.abort();
		}

		// One result, then the generator ends without throwing.
		expect(iterations).toHaveLength(1);
	});

	test("an already-aborted controller yields nothing", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

		const controller = new AbortController();
		controller.abort();

		const iterations: unknown[] = [];
		for await (const result of new Fch("https://api.example.com/x").poll(5, controller)) {
			iterations.push(result);
		}

		expect(iterations).toHaveLength(0);
	});
});
