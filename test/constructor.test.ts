// Fch.test.ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { setupServer } from "msw/node";
import Fch, { type Logger, type FetchRequestOptions } from "../src/Fch";

const server = setupServer();

describe("Fch Constructor", () => {
	test("should initialize with default options", () => {
		const url = "https://api.example.com";
		const fch = new Fch(url);

		expect(fch).toBeInstanceOf(URL);
		expect(fch.toString()).toBe(`${url}/`);
		expect(fch.method).toBe("GET");
		expect(fch.retries).toBe(1);
		expect(fch.timeout).toBe(5000);
		expect(fch.headers.get("Content-Type")).toBeNull();
	});

	test("should merge provided options with defaults", () => {
		const options: FetchRequestOptions = {
			retries: 3,
			timeout: 10000,
			method: "POST",
			headers: { "X-Custom": "test" },
		};

		const fch = new Fch("https://api.example.com", options);

		expect(fch.retries).toBe(3);
		expect(fch.timeout).toBe(10000);
		expect(fch.method).toBe("POST");
		expect(fch.headers.get("X-Custom")).toBe("test");
	});

	test("should handle custom abort controller", () => {
		const controller = new AbortController();
		const fch = new Fch("https://api.example.com", {
			abortController: controller,
		});

		expect(fch.controller).toBe(controller);
		expect(fch.fetchOptions.signal).toBe(controller.signal);
	});

	test("should adapt different logger implementations", () => {
		const customLogger = {
			info: () => {},
			warn: () => {},
			error: () => {},
		};

		// Test valid logger
		const fch1 = new Fch("https://api.example.com", {
			logger: customLogger,
		});
		expect(fch1.getLogger()).toBe(customLogger);

		// Test invalid logger (fallback to default)
		const fch2 = new Fch("https://api.example.com", {
			logger: {} as Logger,
		});
		expect(fch2.getLogger().info).toBeInstanceOf(Function);
	});

	test("should handle request parameters in constructor", async () => {
		const fch = new Fch("https://api.example.com/test?foo=bar", {
			method: "GET",
		});
		fch.appendSearchParams({ baz: "qux" });

		const response = (await fch.makeRequest()) as Response;
		expect(response).not.toBeUndefined();
		const [data] = await response.json();
		expect(data.query).toBe("foo=bar&baz=qux");
	});

	test("should initialize with proper signal chain", () => {
		const controller = new AbortController();
		const fch = new Fch("https://api.example.com", {
			abortController: controller,
			signal: new AbortController().signal, // Should be overridden
		});

		expect(fch.fetchOptions.signal).toBe(controller.signal);
	});

	test("should handle different URL types", () => {
		const url1 = new URL("https://api.example.com");
		const fch1 = new Fch(url1);
		expect(fch1.toString()).toBe(url1.toString());

		const fch2 = new Fch("https://test.com/path");
		expect(fch2.pathname).toBe("/path");
	});
});
