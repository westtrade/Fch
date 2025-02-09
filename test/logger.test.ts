import { describe, expect, test, vi, beforeEach } from "vitest";
import Fch, { type Logger } from "../src/Fch";

describe("Fch Logger", () => {
	let mockLogger: Logger;

	beforeEach(() => {
		mockLogger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	test("should use default logger when none provided", () => {
		const fch = new Fch("https://api.example.com");

		fch.getLogger().info("test info");
		fch.getLogger().warn("test warn");
		fch.getLogger().error("test error");

		expect(console.log).toHaveBeenCalledWith("[INFO] test info");
		expect(console.warn).toHaveBeenCalledWith("[WARN] test warn");
		expect(console.error).toHaveBeenCalledWith("[ERROR] test error");
	});

	test("should use custom logger when provided", () => {
		const fch = new Fch("https://api.example.com", { logger: mockLogger });

		fch.getLogger().info("custom info");
		fch.getLogger().warn("custom warn");
		fch.getLogger().error("custom error");

		expect(mockLogger.info).toHaveBeenCalledWith("custom info");
		expect(mockLogger.warn).toHaveBeenCalledWith("custom warn");
		expect(mockLogger.error).toHaveBeenCalledWith("custom error");
	});

	test("should fallback to default logger for invalid logger implementations", () => {
		const invalidLogger = { info: "not-a-function" } as unknown as Logger;
		const fch = new Fch("https://api.example.com", {
			logger: invalidLogger,
		});

		fch.getLogger().info("fallback test");

		expect(console.log).toHaveBeenCalledWith("[INFO] fallback test");
	});

	test("should respect logging enable/disable state", () => {
		const fch = new Fch("https://api.example.com", { logger: mockLogger });

		fch.disableLogging().getLogger().info("disabled log");
		fch.enableLogging().getLogger().warn("enabled log");

		expect(mockLogger.info).not.toHaveBeenCalled();
		expect(mockLogger.warn).toHaveBeenCalledWith("enabled log");
	});

	test("should log request lifecycle events", async () => {
		const fch = new Fch("https://api.example.com/status/200", {
			logger: mockLogger,
			debug: true,
		});

		await fch.makeRequest();

		expect(mockLogger.info).toHaveBeenCalledWith(
			"Making request to https://api.example.com/status/200 with method GET"
		);
		expect(mockLogger.info).toHaveBeenCalledWith(
			"Received response with status 200"
		);
	});

	test("should log errors and retries", async () => {
		const fch = new Fch("https://api.example.com/status/500", {
			logger: mockLogger,
			retries: 2,
			debug: true,
		});

		await expect(fch.makeRequest()).resolves.toHaveProperty("status", 500);

		expect(mockLogger.info).toHaveBeenCalledTimes(2); // Initial request
	});

	test("should log interceptors activity", async () => {
		const fch = new Fch("https://api.example.com/header/x-test", {
			logger: mockLogger,
			debug: true,
		});

		fch.addRequestInterceptor((req) => {
			req.setHeaders({ "X-Test": "true" });
		}).addResponseInterceptor((res) => {
			res.headers.set("X-Processed", "true");
			return res;
		});

		await fch.makeRequest();

		expect(mockLogger.info).toHaveBeenCalledWith(
			expect.stringContaining("Making request")
		);
		expect(mockLogger.info).toHaveBeenCalledWith(
			"Received response with status 200"
		);
	});
});
