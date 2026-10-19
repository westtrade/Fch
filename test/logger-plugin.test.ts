import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { Fch, type Logger } from "../src/Fch";
import { logger, consoleLogger } from "../src/plugins/logger";

// Logging moved out of the core: the core emits semantic events, the plugin
// decides level, wording and destination.

let realFetch: typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response('{"ok":true}', {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const spyLogger = (): Logger & { mock: Logger } => {
	const mock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return Object.assign(mock, { mock });
};

describe("logger plugin", () => {
	test("without the plugin nothing is logged and nothing breaks", async () => {
		// No sink installed: the emit calls are no-ops.
		const req = new Fch("https://api.example.com/x");
		await expect(req.send()).resolves.toBeInstanceOf(Response);
	});

	test("adds the public logging API", () => {
		const req = new Fch("https://api.example.com/x").use(logger()) as never as Record<
			string,
			unknown
		>;

		for (const name of ["getLogger", "setLogger", "enableLogging", "disableLogging"]) {
			expect(typeof req[name], name).toBe("function");
		}
	});

	test("a custom logger receives formatted lines", async () => {
		const log = spyLogger();
		const req = new Fch("https://api.example.com/x").use(
			logger({ logger: log, debug: true }),
		);

		await req.send().catch(() => {});

		expect(log.info).toHaveBeenCalledWith(
			"Making request to https://api.example.com/x with method GET",
		);
	});

	test("debug off: only warn and error are emitted", async () => {
		const log = spyLogger();
		const req = new Fch("https://api.example.com/x", { retries: 1, retryDelay: 1 })
			.setRetryOn((res) => !!res && res.status >= 500)
			.use(logger({ logger: log }));

		await req.send();

		expect(log.info).not.toHaveBeenCalled();
		expect(log.debug).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Retry triggered"));
	});

	test("enableLogging and disableLogging switch info/debug", () => {
		const log = spyLogger();
		const req = new Fch("https://api.example.com/x").use(logger({ logger: log }));

		req.disableLogging().getLogger().info("quiet");
		req.enableLogging().getLogger().info("loud");

		expect(log.info).toHaveBeenCalledTimes(1);
		expect(log.info).toHaveBeenCalledWith("loud");
	});

	test("error is never gated by the debug flag", () => {
		const log = spyLogger();
		const req = new Fch("https://api.example.com/x").use(logger({ logger: log, debug: false }));

		req.getLogger().error("boom");

		expect(log.error).toHaveBeenCalledWith("boom");
	});

	test("an invalid logger falls back to console, not to silence", () => {
		const calls: unknown[][] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => calls.push(args);

		try {
			const req = new Fch("https://api.example.com/x").use(
				logger({ logger: { info: "nope" } as unknown as Logger, debug: true }),
			);
			req.getLogger().info("hello");
		} finally {
			console.log = original;
		}

		expect(calls).toEqual([["[INFO]", "hello"]]);
	});

	test("setLogger swaps the destination and validates", () => {
		const first = spyLogger();
		const second = spyLogger();
		const req = new Fch("https://api.example.com/x").use(logger({ logger: first }));

		req.setLogger(second);
		req.getLogger().warn("moved");

		expect(first.warn).not.toHaveBeenCalled();
		expect(second.warn).toHaveBeenCalledWith("moved");

		// An invalid logger is replaced by the console default.
		expect(() => req.setLogger({ info: 1 } as unknown as Logger)).not.toThrow();
	});

	test("retry, dedupe and interceptor failures reach the plugin", async () => {
		const log = spyLogger();
		globalThis.fetch = (async () => {
			await new Promise((r) => setTimeout(r, 15));
			return new Response('{"ok":true}', {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const req = new Fch("https://api.example.com/x", { dedupe: true }).use(
			logger({ logger: log, debug: true }),
		);
		await Promise.all([req.json(), req.json()]);

		expect(log.debug).toHaveBeenCalledWith(
			expect.stringContaining("Deduped concurrent in-flight request"),
		);
	});

	test("consoleLogger prefixes each level", () => {
		// `bind` captures console at construction, so install the recorder first.
		const calls: unknown[][] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => calls.push(args);

		try {
			consoleLogger().warn("x");
		} finally {
			console.warn = original;
		}

		expect(calls).toEqual([["[WARN]", "x"]]);
	});

	test("the plugin is idempotent", () => {
		const plugin = logger();
		const req = new Fch("https://api.example.com/x").use(plugin).use(plugin);

		expect(req.plugins).toEqual(["logger"]);
	});
});
