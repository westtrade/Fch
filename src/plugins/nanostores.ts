/**
 * Nanostores integration. Two things at once:
 *
 * 1. **The request becomes a store.** `fch.use(nanostores())` mixes the
 *    NanoStore contract (`get`, `listen`, `subscribe`, `value`, `setKey`) onto
 *    the `Fch` instance, so `useStore(req)` works in React, Preact, Vue, Solid,
 *    Lit, Angular and Svelte without a wrapper.
 * 2. **An optional external store is mirrored.** Pass a store and it receives
 *    the same state, for views that should not know about the request object.
 *
 * ```ts
 * import { Fch } from "@westtrade/fch";
 * import { nanostores } from "@westtrade/fch/plugins/nanostores";
 *
 * const req = new Fch("https://api.example.com/houses/1").use(nanostores());
 *
 * req.subscribe((state) => render(state)); // Svelte: $req
 * const [house] = await req.json<House>(); // also fills req.get()
 * ```
 *
 * No dependency on nanostores: the instance only implements its contract.
 */
import type { Plugin, PluginApi } from '../Fch';

/** Per-request state exposed by the store. */
export interface StoreState<T = unknown> {
	/** `true` between `onRequest` and settle. */
	loading: boolean;
	/** Parsed body, once a request succeeded. */
	data?: T;
	/** Normalised error, once a request failed. */
	error?: Error;
	/** The raw `Response`, when one arrived. */
	response?: Response;
}

/** Keys that {@link StoreState} exposes to `setKey`. */
export type StoreKey = keyof StoreState;

/** A NanoStore-compatible listener. */
export type Listener<T> = (
	value: StoreState<T>,
	oldValue: StoreState<T>,
	changedKey?: StoreKey,
) => void;

/**
 * The store contract mixed into the request. Structurally compatible with
 * nanostores' `ReadableAtom`/`MapStore`, which is all a framework adapter needs.
 */
export interface FchStore<T = unknown> {
	/** Current state. Reading does not subscribe. */
	get(): StoreState<T>;
	/** Current state, as a property (`$store.value` in nanostores). */
	readonly value: StoreState<T>;
	/** Subscribe; the callback fires on every change. Returns an unsubscribe. */
	listen(listener: Listener<T>): () => void;
	/** Subscribe and fire immediately with the current state (Svelte contract). */
	subscribe(listener: Listener<T>): () => void;
	/** Replace the whole state. */
	set(state: StoreState<T>): void;
	/** Patch one key, notifying with the changed key. */
	setKey(key: StoreKey, value: unknown): void;
}

/** A plain nanostores `atom`/`map`, or anything shaped like one. */
export interface StoreLike<T> {
	setKey?: (key: string, value: unknown) => void;
	set?: (value: T) => void;
	get?: () => T;
	value?: T;
}

export interface NanostoresOptions<T = unknown> {
	/**
	 * Optional external store to mirror into. The request is a store either way;
	 * this is for views that should receive state without holding the request.
	 */
	store?: StoreLike<StoreState<T>>;
	/** Clear `data` at the start of the next request. Default `true`. */
	clearOnRequest?: boolean;
}

const INITIAL: StoreState = { loading: false };

/**
 * Turn the request into a store and run its lifecycle into it.
 *
 * @param options - Optional external store to mirror into.
 */
export function nanostores<T = unknown>(
	options: NanostoresOptions<T> = {},
): Plugin {
	const { store: mirror, clearOnRequest = true } = options;

	// Validate at construction time, not per request: a store that can receive
	// nothing would otherwise fail silently.
	if (
		mirror &&
		typeof mirror.setKey !== 'function' &&
		typeof mirror.set !== 'function'
	) {
		throw new TypeError(
			'Fch nanostores plugin: `store` must be a nanostores map (has `setKey()`) ' +
				'or atom (has `set()`). Got: ' +
				Object.keys(mirror).join(', '),
		);
	}

	return {
		// Fixed name: attaching twice must not duplicate listeners.
		name: 'nanostores',

		install({ request, onRequest, onSuccess, onError }: PluginApi): void {
			let state: StoreState<T> = { ...INITIAL } as StoreState<T>;
			const listeners = new Set<Listener<T>>();

			const emit = (old: StoreState<T>, changedKey?: StoreKey): void => {
				for (const listener of listeners) listener(state, old, changedKey);
			};

			const replace = (next: StoreState<T>, changedKey?: StoreKey): void => {
				const old = state;
				state = next;
				emit(old, changedKey);
			};

			const put = (key: StoreKey, value: unknown): void => {
				if ((state as unknown as Record<string, unknown>)[key] === value) return;
				replace({ ...state, [key]: value }, key);
			};

			// Mirror into the external store, if one was given.
			const sync = (): void => {
				if (!mirror) return;
				if (typeof mirror.setKey === 'function') {
					for (const key of ['loading', 'data', 'error', 'response'] as const) {
						mirror.setKey(key, state[key]);
					}
				} else {
					mirror.set?.(state);
				}
			};

			const set = (next: StoreState<T>): void => {
				replace(next);
				sync();
			};

			const patch = (key: StoreKey, value: unknown): void => {
				put(key, value);
				sync();
			};

			// Mix the store contract into the request instance. `Object.assign`
			// would not work for `value` (a getter), hence defineProperty.
			Object.assign(request, {
				get: () => state,
				set,
				setKey: patch,
				listen(listener: Listener<T>) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				subscribe(listener: Listener<T>) {
					listeners.add(listener);
					// The Svelte/store contract requires an immediate call.
					listener(state, state);
					return () => listeners.delete(listener);
				},
			});
			Object.defineProperty(request, 'value', {
				get: () => state,
				configurable: true,
				enumerable: false,
			});

			// Lifecycle: loading → data | error.
			onRequest(() => {
				set({
					loading: true,
					data: clearOnRequest ? undefined : state.data,
					error: undefined,
					response: undefined,
				});
			});

			onSuccess((body, response) => {
				set({ loading: false, data: body as T, error: undefined, response });
			});

			onError((error) => {
				set({
					loading: false,
					data: clearOnRequest ? undefined : state.data,
					error: error instanceof Error ? error : new Error(String(error)),
					response: undefined,
				});
			});
		},
	};
}

export default nanostores;
