import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Packaging guarantees for the `@westtrade/fch/literal` entry point. These are
// the failures that only show up after publishing, so they are asserted here:
// the tarball must contain both entries, and both must resolve as ESM and CJS.

const root = resolve(__dirname, "..");

/** Run a node script in `cwd`, returning stdout. */
const run = (cwd: string, args: string[]) =>
	execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: "pipe" });

describe("published package", () => {
	let tarball: string;
	let workdir: string;

	beforeAll(() => {
		workdir = mkdtempSync(join(tmpdir(), "fch-pack-"));
		const out = execFileSync("npm", ["pack", "--pack-destination", workdir, "--silent"], {
			cwd: root,
			encoding: "utf8",
			stdio: "pipe",
			env: { ...process.env, npm_config_cache: join(workdir, ".cache") },
		}).trim();
		tarball = resolve(workdir, out.split("\n").pop()!.trim());

		// Install it into a scratch project so resolution goes through the real
		// `exports` map rather than the source tree.
		const app = join(workdir, "app");
		execFileSync("mkdir", ["-p", app]);
		writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true, version: "1.0.0" }));
		execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", tarball], {
			cwd: app,
			encoding: "utf8",
			stdio: "pipe",
			env: { ...process.env, npm_config_cache: join(workdir, ".cache") },
		});
	}, 180_000);

	afterAll(() => {
		if (workdir) rmSync(workdir, { recursive: true, force: true });
	});

	test("ships both entry points, with ESM wrappers", () => {
		const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
			.split("\n")
			.map((f) => f.replace(/^package\//, ""))
			.filter(Boolean);

		for (const expected of [
			"dist/Fch.js",
			"dist/Fch.d.ts",
			"dist/Fch.mjs",
			"dist/Fch.literal.js",
			"dist/Fch.literal.d.ts",
			"dist/Fch.literal.mjs",
			"package.json",
		]) {
			expect(files, `missing ${expected}`).toContain(expected);
		}
	});

	test("exports map points at files that exist", () => {
		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		const entries = Object.values(pkg.exports as Record<string, Record<string, string>>)
			.flatMap((v) => Object.values(v))
			.filter((p) => typeof p === "string" && p.startsWith("./"));

		for (const rel of entries) {
			expect(readFileSync(resolve(root, rel)), `${rel} missing`).toBeTruthy();
		}
	});

	test("ESM: default import is the callable factory, and literal works", () => {
		const app = join(workdir, "app");
		const script = join(app, "esm.mjs");
		writeFileSync(
			script,
			`
			import fch from "@westtrade/fch/literal";
			import { raw } from "@westtrade/fch/literal";
			import mainDefault, { Fch } from "@westtrade/fch";

			globalThis.fetch = async (url) =>
				new Response(JSON.stringify({ url: String(url) }), {
					headers: { "Content-Type": "application/json" },
				});

			const out = {};
			out.mainType = typeof mainDefault;

			const [body, response] = await fch\`https://x.test/users/1\`;
			out.awaited = body.url;
			out.status = response.status;

			const request = fch\`https://x.test/users/1\`;
			out.isFch = request.request instanceof Fch;
			out.hasJson = typeof request.json === "function";

			out.encoded = fch\`https://x.test/a/\${"b/../c"}\`.request.toString();
			out.raw = fch\`https://x.test/\${raw("a/b")}\`.request.toString();
			console.log(JSON.stringify(out));
			`,
		);

		const out = JSON.parse(run(app, [script]).trim().split("\n").pop()!);
		expect(out.mainType).toBe("function");
		expect(out.awaited).toBe("https://x.test/users/1");
		expect(out.status).toBe(200);
		expect(out.isFch).toBe(true);
		expect(out.hasJson).toBe(true);
		expect(out.encoded).toBe("https://x.test/a/b%2F..%2Fc");
		expect(out.raw).toBe("https://x.test/a/b");
	});

	test("the nanostores plugin resolves as a subpath with an ESM default", async () => {
		const app = join(workdir, "app");
		const script = join(app, "plugin.mjs");
		writeFileSync(
			script,
			`
			import plugin, { nanostores } from "@westtrade/fch/plugins/nanostores";
			import { Fch } from "@westtrade/fch";

			const out = { same: plugin === nanostores, type: typeof nanostores };

			const req = new Fch("https://x.test/y").use(nanostores());
			out.hasGet = typeof req.get === "function";
			out.hasListen = typeof req.listen === "function";
			out.initial = req.get().loading;
			out.plugins = req.plugins;
			console.log(JSON.stringify(out));
			`,
		);

		const out = JSON.parse(run(app, [script]).trim().split("\n").pop()!);
		expect(out.same).toBe(true);
		expect(out.type).toBe("function");
		expect(out.hasGet).toBe(true);
		expect(out.hasListen).toBe(true);
		expect(out.initial).toBe(false);
		expect(out.plugins).toEqual(["nanostores"]);
	});

	test("CJS: require() of both entries works", () => {
		const app = join(workdir, "app");
		const script = join(app, "cjs.cjs");
		writeFileSync(
			script,
			`
			const literal = require("@westtrade/fch/literal");
			const main = require("@westtrade/fch");

			globalThis.fetch = async () => new Response("{}", { headers: { "Content-Type": "application/json" } });

			const call = literal.default\`https://x.test/x\`;
			console.log(JSON.stringify({
				literalDefault: typeof literal.default,
				raw: typeof literal.raw,
				fch: typeof main.Fch,
				create: typeof main.create,
				callJson: typeof call.json,
				request: call.request.constructor.name,
			}));
			`,
		);

		const out = JSON.parse(run(app, [script]).trim().split("\n").pop()!);
		expect(out).toEqual({
			literalDefault: "function",
			raw: "function",
			fch: "function",
			create: "function",
			callJson: "function",
			request: "Fch",
		});
	});
});
