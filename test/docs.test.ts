import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { Fch, create } from "../src/Fch";

// Guards the documentation site against drift: every page must exist, every
// internal link must resolve, and the API reference must name real members.

const root = resolve(__dirname, "..");
const contentDir = resolve(root, "docs-src/content");

const pages = readdirSync(contentDir)
	.filter((f) => f.endsWith(".md"))
	.map((f) => ({ slug: f.replace(/\.md$/, ""), body: readFileSync(resolve(contentDir, f), "utf8") }));

describe("documentation site", () => {
	test("has the pages the navigation advertises", () => {
		const expected = [
			"getting-started", "vs-fetch", "vs-libraries", "url-first", "requests",
			"reading-responses", "retries", "timeouts", "dedupe", "cancelling",
			"forms", "shortcuts", "literal", "hooks", "logging", "api",
		];
		expect(pages.map((p) => p.slug).sort()).toEqual(expected.sort());
	});

	test("every page starts with a single H1", () => {
		for (const page of pages) {
			const h1s = page.body.match(/^#\s+.+$/gm) ?? [];
			expect(h1s, page.slug).toHaveLength(1);
		}
	});

	test("every internal markdown link points at a real page", () => {
		for (const page of pages) {
			const links = [...page.body.matchAll(/\]\(([^)]+)\)/g)]
				.map((m) => m[1])
				.filter((href) => !/^https?:/i.test(href) && !href.startsWith("#"));

			for (const href of links) {
				const target = href.split("#")[0];
				expect(existsSync(resolve(contentDir, target)), `${page.slug} -> ${href}`).toBe(true);
			}
		}
	});

	test("the API reference only names members that exist", () => {
		const apiPage = pages.find((p) => p.slug === "api")!.body;
		const members = [...apiPage.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)\(/g)].map((m) => m[1]);

		const req = new Fch("https://api.example.com/x") as never as Record<string, unknown>;
		const api = create({ baseUrl: "https://api.example.com" }) as never as Record<string, unknown>;

		// Names documented on the builder must exist on the builder; the rest are
		// create()-only or constructor-only and are checked against the client.
		const clientOnly = new Set(["get", "head", "post", "put", "patch", "delete", "request"]);

		for (const name of new Set(members)) {
			if (clientOnly.has(name)) {
				expect(typeof api[name], `client.${name}`).toBe("function");
				continue;
			}
			if (name === "fch" || name === "Fch" || name === "create") continue;
			expect(typeof req[name], `Fch.${name}`).toBe("function");
		}
	});

	test("documented defaults match the implementation", () => {
		const req = new Fch("https://api.example.com/x");
		// These numbers are stated in getting-started.md, retries.md, timeouts.md
		// and the options table in api.md. If a default changes, the docs must too.
		expect(req.retries).toBe(0);
		expect(req.timeout).toBe(30_000);
		expect(req.retryDelay).toBe(1_000);
	});

	test("the comparison page quotes the size the package actually ships", () => {
		const page = pages.find((p) => p.slug === "vs-libraries")!.body;
		// The Fch row claims ~5.5 kB gzipped. Measure the browser bundle the docs
		// site itself ships and require the claim to stay within 10% of it, so a
		// feature that doubles the bundle forces a docs update.
		const bundle = resolve(root, "docs-src/assets/fch.min.js");
		const gzip = gzipSync(readFileSync(bundle), { level: 9 }).length / 1024;

		const claimed = Number(page.match(/\*\*~([\d.]+) kB\*\*/)![1]);
		expect(Math.abs(gzip - claimed), `claimed ${claimed} kB, actual ${gzip.toFixed(2)} kB`)
			.toBeLessThan(claimed * 0.1);

		// The dependency column must agree with package.json.
		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		expect(page, "comparison table claims zero dependencies").toMatch(/\| Dependencies \| 0 \| \*\*0\*\*/);
		expect(Object.keys(pkg.dependencies ?? {}), "package has no runtime dependencies").toHaveLength(0);
	});

	test("the landing page links every top-level doc page", () => {
		const landing = readFileSync(resolve(root, "docs-src/index.html"), "utf8");
		for (const slug of ["getting-started", "vs-fetch", "vs-libraries", "api", "url-first", "retries"]) {
			expect(landing, slug).toContain(`docs/${slug}.html`);
		}
	});

	test("no page tells the reader to use a relative baseUrl", () => {
		// `create({ baseUrl: '/api' })` throws by design; a doc example suggesting
		// it would be wrong. The only allowed mention is the error demonstration,
		// which is recognised by the TypeError comment next to it.
		for (const page of pages) {
			const lines = page.body.split("\n");
			lines.forEach((line, i) => {
				if (!/baseUrl:\s*["'`]\/[^"'`]*["'`]/.test(line)) return;
				const nearby = lines.slice(Math.max(0, i - 3), i + 3).join("\n");
				if (/TypeError|requires an absolute|throws/.test(nearby)) return;
				expect.fail(`${page.slug}:${i + 1} suggests a relative baseUrl: ${line.trim()}`);
			});
		}
	});

	test("the package is scoped, and imports match the scoped name", () => {
		// The unscoped `fch` on npm is another author's library (v6.x). The
		// package must stay scoped, and every documented import must use it.
		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		expect(pkg.name).toBe("@westtrade/fch");

		const sources = [
			...pages.map((p) => ({ name: p.slug, body: p.body })),
			{ name: "index.html", body: readFileSync(resolve(root, "docs-src/index.html"), "utf8") },
			{ name: "Readme.md", body: readFileSync(resolve(root, "Readme.md"), "utf8") },
		];

		for (const { name, body } of sources) {
			// A bare `from "fch"` would not resolve: the installed directory is
			// node_modules/@westtrade/fch.
			const bareImport = body.match(/from\s+["']fch["']/);
			expect(bareImport, `${name} imports the bare name "fch"`).toBeNull();

			const badInstall = body.match(/^\s*(npm (?:install|i)|yarn add|pnpm add|bun add)\s+fch\s*$/m);
			expect(badInstall, `${name} tells the reader to install the unscoped npm package`).toBeNull();

			expect(body, `${name} links npmjs.com/package/fch`).not.toContain("npmjs.com/package/fch");
		}

		// And the documented install must be the repository one, imported by scope.
		const gettingStarted = pages.find((p) => p.slug === "getting-started")!.body;
		expect(gettingStarted).toContain("github:westtrade/Fch");
		expect(gettingStarted).toContain('from "@westtrade/fch"');
	});

	test("the documented install tag matches the released version", () => {
		// The install line pins a release tag. If the version is bumped by
		// semantic-release and the docs are not updated, readers pin a stale tag
		// that may predate fixes (v1.2.4 predates `prepare`, so it installs an
		// unimportable package). Keep the two in lockstep.
		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		const expected = `#v${pkg.version}`;

		const sources = [
			{ name: "getting-started", body: pages.find((p) => p.slug === "getting-started")!.body },
			{ name: "Readme.md", body: readFileSync(resolve(root, "Readme.md"), "utf8") },
		];

		for (const { name, body } of sources) {
			const pinned = [...body.matchAll(/#v(\d+\.\d+\.\d+)/g)].map((m) => m[0]);
			expect(pinned.length, `${name} has no pinned install tag`).toBeGreaterThan(0);
			for (const tag of new Set(pinned)) {
				expect(tag, `${name} pins ${tag}, but package.json is ${pkg.version}`).toBe(expected);
			}
		}
	});

	test("the docs header shows the package version", () => {
		// The header badge used to be hardcoded in the page template and drifted
		// to v1.2.3 while the package was at 1.3.0. It is now read from
		// package.json at build time, so assert the template does not hardcode a
		// version and that the built pages agree with package.json.
		const template = readFileSync(resolve(root, "scripts/build-site.mjs"), "utf8");
		expect(template, "build-site.mjs hardcodes a version badge").not.toMatch(/>v\d+\.\d+\.\d+</);
		expect(template, "build-site.mjs does not read the version").toContain("pkg.version");

		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		const built = resolve(root, "site/docs/api.html");
		if (!existsSync(built)) return; // site is generated; skip before `npm run site`

		const html = readFileSync(built, "utf8");
		expect(html, "built page shows a stale version").toContain(`v${pkg.version}`);
	});

	test("the package is buildable from a git install", () => {
		// A git install runs `prepare`, not `prepublishOnly`; without it the
		// installed package has no dist/ and cannot be imported. This is a
		// package.json invariant, so assert it rather than trusting the docs.
		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		expect(pkg.scripts.prepare, "prepare script is required for github: installs").toBeTruthy();
		expect(pkg.scripts.prepare).toContain("build");
	});
});
