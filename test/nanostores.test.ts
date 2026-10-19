import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Fch } from "../src/Fch";
import { nanostores } from "../src/plugins/nanostores";

// The plugin must make the request a NanoStore and keep the lifecycle in it.

let realFetch: typeof fetch;
let calls: { url: string }[];

beforeEach(() => {
	realFetch = globalThis.fetch;
	calls = [];
	globalThis.fetch = (async (url: string) => {
		calls.push({ url: String(url) });
		return new Response(JSON.stringify({ id: 1, name: "Ann" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Minimal nanostores-shaped `map()`: `setKey` + `listen` + `value`. */
function fakeMap(initial: Record<string, unknown> = {}) {
	let value = { ...initial };
	const listeners = new Set<(v: typeof value, o: typeof value, k?: string) => void>();
	return {
		get value() {
			return value;
		},
		get: () => value,
		setKey(key: string, next: unknown) {
			const old = value;
			value = { ...value, [key]: next };
			for (const l of listeners) l(value, old, key);
		},
		listen(fn: (v: typeof value, o: typeof value, k?: string) => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
}

describe("nanostores plugin", () => {
	test("mixes the store contract into the request", () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());

		for (const member of ["get", "listen", "subscribe", "set", "setKey"]) {
			expect(typeof (req as never as Record<string, unknown>)[member], member).toBe("function");
		}
		expect(req.get()).toEqual({ loading: false });
	});

	test("is idempotent and reports its name", () => {
		const plugin = nanostores();
		const req = new Fch("https://api.example.com/x").use(plugin).use(plugin);

		expect(req.plugins).toEqual(["nanostores"]);
	});

	test("goes loading -> data through one execution", async () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());
		const states: { loading: boolean; data?: unknown }[] = [];
		req.listen((state) => states.push({ loading: state.loading, data: state.data }));

		const [house] = await req.json<{ name: string }>();

		expect(house.name).toBe("Ann");
		expect(states).toEqual([
			{ loading: true, data: undefined },
			{ loading: false, data: { id: 1, name: "Ann" } },
		]);
	});

	test("subscribe fires immediately, as Svelte requires", () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());
		const seen: boolean[] = [];

		const off = req.subscribe((state) => seen.push(state.loading));
		off();

		expect(seen).toEqual([false]);
	});

	test("stores a normalised Error on failure", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;

		const req = new Fch("https://api.example.com/x").use(nanostores({}));
		await req.json().catch(() => {});

		const state = req.get();
		expect(state.loading).toBe(false);
		expect(state.error).toBeInstanceOf(TypeError);
		expect(state.error?.message).toBe("Failed to fetch");
		expect(state.data).toBeUndefined();
	});

	test("a non-Error rejection is wrapped in an Error", async () => {
		globalThis.fetch = (async () => {
			throw "plain string";
		}) as unknown as typeof fetch;

		const req = new Fch("https://api.example.com/x").use(nanostores());
		await req.json().catch(() => {});

		expect(req.get().error).toBeInstanceOf(Error);
		expect(req.get().error?.message).toBe("plain string");
	});

	test("setKey patches one key and notifies with it", async () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());
		const keys: (string | undefined)[] = [];
		req.listen((_s, _o, key) => keys.push(key));

		req.setKey("loading", true);

		expect(req.get().loading).toBe(true);
		expect(keys).toEqual(["loading"]);
	});

	test("unsubscribe stops notifications", async () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());
		let count = 0;
		const off = req.listen(() => count++);

		await req.json();
		const afterRequest = count;
		off();
		req.setKey("loading", true);

		expect(count).toBe(afterRequest);
	});

	test("mirrors into a nanostores-style map", async () => {
		const $map = fakeMap({ loading: false });
		const req = new Fch("https://api.example.com/x").use(nanostores({ store: $map }));

		await req.json();

		expect($map.value.data).toEqual({ id: 1, name: "Ann" });
		expect($map.value.loading).toBe(false);
	});

	test("mirrors into a plain atom via set()", async () => {
		let value: unknown = { loading: false };
		const $atom = { get: () => value, set: (next: unknown) => (value = next) };

		const req = new Fch("https://api.example.com/x").use(nanostores({ store: $atom }));
		await req.json();

		expect((value as { data?: unknown }).data).toEqual({ id: 1, name: "Ann" });
	});

	test("clearOnRequest: false keeps the previous data while reloading", async () => {
		let release: (() => void) | undefined;
		globalThis.fetch = (async () => {
			await new Promise<void>((r) => (release = r));
			return new Response(JSON.stringify({ n: 2 }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const req = new Fch("https://api.example.com/x").use(
			nanostores({ clearOnRequest: false }),
		);
		req.set({ loading: false, data: { n: 1 } });

		const pending = req.json();
		await Promise.resolve();
		expect(req.get().loading).toBe(true);
		expect(req.get().data).toEqual({ n: 1 });

		release!();
		await pending;
		expect(req.get().data).toEqual({ n: 2 });
	});

	test("fires for every entry point, not just .json()", async () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());
		const seen: boolean[] = [];
		req.listen((state) => seen.push(state.loading));

		await req.send();
		await req;

		// loading -> settled, twice.
		expect(seen).toEqual([true, false, true, false]);
		expect(calls).toHaveLength(2);
	});

	test("works with the shortcut API and the tagged template", async () => {
		const req = new Fch("https://api.example.com/x").use(nanostores());
		await req.json();
		expect(req.get().data).toEqual({ id: 1, name: "Ann" });
	});

	test("rejects a store that is neither a map nor an atom", () => {
		expect(() => nanostores({ store: {} as never })).toThrow(/setKey|set\(\)/);
	});
});
