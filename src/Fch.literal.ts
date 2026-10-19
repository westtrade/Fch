/**
 * Tagged-template entry point — `import fch from "@westtrade/fch/literal"`.
 *
 * ```ts
 * const [user, response] = await fch`https://api.example.com/users/1`;
 * const request = fch`https://api.example.com/users/1`; // a full builder
 * ```
 *
 * The template is not a string: `fch` returns the same eagerly-started
 * {@link FchCall} the shortcut API returns, so the request object and the
 * awaited tuple are one value. There is no separate "build then send" step.
 *
 * Interpolation is **URL-encoded by default**, so building a path from user
 * input cannot break out of its segment:
 *
 * ```ts
 * const id = "42/../admin";         // hostile input
 * fch`https://api.example.com/users/${id}`;
 * // -> https://api.example.com/users/42%2F..%2Fadmin
 * ```
 *
 * Wrap a value in `raw` to opt out (the template literal itself is already
 * trusted, so `raw` is only needed for pre-encoded values):
 *
 * ```ts
 * fch`https://api.example.com/${raw("users/42")}`; // -> .../users/42
 * ```
 */
import { Fch, toCall, applyShortcutBody, type FchCall, type FchBodyInput } from './Fch';

/** A value that must be inserted without URL encoding. */
class Raw {
	constructor(readonly value: string) {}
	toString(): string {
		return this.value;
	}
}

/**
 * Mark a value as already encoded, so the tagged template inserts it verbatim.
 * Use this for path segments you control, not for user input.
 */
export function raw(value: string | number): string {
	return new Raw(String(value)) as unknown as string;
}

/**
 * Build a URL from a template literal, encoding every interpolation.
 * `Raw` values (from {@link raw}) are inserted as-is.
 */
function buildUrl(strings: TemplateStringsArray, values: unknown[]): string {
	let out = strings[0];
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		// `Raw` instances are smuggled through the `string` return type of `raw()`.
		const encoded =
			value instanceof Raw ? value.value : encodeURIComponent(String(value ?? ''));
		out += encoded + strings[i + 1];
	}
	return out;
}

/** A tag that starts the request when applied to a URL template. */
export interface UrlTag {
	<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T>;
}

/**
 * Build the request for one template and start it.
 * `body` is applied with the same inference as the shortcut API: a plain
 * object/array becomes JSON, a `<form>`/submit event becomes `FormData`, and
 * anything else is passed to `fetch` untouched.
 */
function request(
	method: string,
	body: FchBodyInput | undefined,
	strings: TemplateStringsArray,
	values: unknown[],
	fetchImpl?: typeof globalThis.fetch
): FchCall<unknown> {
	const instance = new Fch(buildUrl(strings, values), fetchImpl ? { fetch: fetchImpl } : {})
		.setMethod(method);
	if (body !== undefined && body !== null) applyShortcutBody(instance, body);
	return toCall(instance);
}

/**
 * Build the per-method tags for one `fetch` implementation. Shared by the
 * default tag and {@link WithFetch}, so both spellings behave identically.
 */
function tagsFor(fetchImpl?: typeof globalThis.fetch) {
	const plain = (method: string): UrlTag =>
		<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T> =>
			request(method, undefined, strings, values, fetchImpl) as FchCall<T>;

	const withBody = (method: string) => (body: FchBodyInput): UrlTag =>
		<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T> =>
			request(method, body, strings, values, fetchImpl) as FchCall<T>;

	return {
		get: plain('GET'),
		head: plain('HEAD'),
		options: plain('OPTIONS'),
		delete: plain('DELETE'),
		del: plain('DELETE'),
		post: withBody('POST'),
		put: withBody('PUT'),
		patch: withBody('PATCH'),
	};
}

/**
 * The body-carrying form: `fch.post(body)\`…\``. The generic goes on the body
 * call, so `fch.post<User>(body)` types the whole chain.
 */
export type BodyTag = <T = unknown>(body: FchBodyInput) => UrlTag & {
	(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T>;
};

/**
 * A tag bound to a custom `fetch`. A literal starts eagerly, so the
 * implementation must be known before the tag is applied — `setFetch()` on the
 * already-started request is too late.
 *
 * ```ts
 * fch.withFetch(myFetch)`https://api.example.com/x`;
 * ```
 */
export interface WithFetch {
	<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): FchCall<T>;
	/** Methods, for parity with the main tag. */
	get: UrlTag;
	delete: UrlTag;
	del: UrlTag;
	head: UrlTag;
	options: UrlTag;
	post: (body: FchBodyInput) => UrlTag;
	put: (body: FchBodyInput) => UrlTag;
	patch: (body: FchBodyInput) => UrlTag;
}

/** Bodyless methods: `fch.get\`…\``, `fch.del\`…\``. */
const tag = (method: string): UrlTag => tagsFor()[method as 'get'] as UrlTag;

/** Methods that carry a body: `fch.post(body)\`…\``. */
const bodyTag = (method: string) => tagsFor()[method as 'post'] as (body: FchBodyInput) => UrlTag;

/**
 * The tagged template. Also carries `raw`, `Fch`, one tag per HTTP method, and
 * `withFetch()` for a custom `fetch`.
 *
 * Bodyless methods are used directly, body-carrying methods are curried with
 * the body first — the template itself only carries the URL:
 *
 * ```ts
 * fch.get`https://api.example.com/users/1`;
 * fch.delete`https://api.example.com/users/1`;
 * fch.post({ name: "Ann" })`https://api.example.com/users`;
 * fch.withFetch(myFetch)`https://api.example.com/users/1`;
 * ```
 */
export interface FchLiteral {
	/**
	 * Start a request to the URL in the template.
	 * The returned call is a promise for `[parsedBody, response]` **and** the
	 * request builder (`json()`, `send()`, `abort()`, `.request`, …).
	 */
	<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): FchCall<T>;
	/** Insert a value without URL encoding. */
	raw: typeof raw;
	/** The underlying class, for `instanceof` checks or a plain builder. */
	Fch: typeof Fch;
	/**
	 * Bind a custom `fetch`. A literal starts eagerly, so the implementation must
	 * be supplied before the tag runs.
	 */
	withFetch(fetchImpl: typeof globalThis.fetch): WithFetch;

	/** `GET https://…` */
	get: UrlTag;
	/** `HEAD https://…` */
	head: UrlTag;
	/** `OPTIONS https://…` */
	options: UrlTag;
	/** `DELETE https://…`. `del` is an alias. */
	delete: UrlTag;
	/** Alias of `delete`. */
	del: UrlTag;

	/** `POST body https://…`. Supply the body type as `fch.post<T>(body)`. */
	post: BodyTag;
	/** `PUT body https://…`. Supply the body type as `fch.put<T>(body)`. */
	put: BodyTag;
	/** `PATCH body https://…`. Supply the body type as `fch.patch<T>(body)`. */
	patch: BodyTag;
}

function literal<T = unknown>(
	strings: TemplateStringsArray,
	...values: unknown[]
): FchCall<T> {
	return request('GET', undefined, strings, values) as FchCall<T>;
}

const defaultTags = tagsFor();

export const fch: FchLiteral = Object.assign(literal, {
	raw,
	Fch,
	withFetch,
	...defaultTags,
});

/** Bind a custom `fetch` to the tag and its method helpers. */
export function withFetch(fetchImpl: typeof globalThis.fetch): WithFetch {
	if (typeof fetchImpl !== 'function') {
		throw new TypeError(`withFetch() expects a function, got ${typeof fetchImpl}`);
	}

	const tags = tagsFor(fetchImpl);
	const run = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T> =>
		request('GET', undefined, strings, values, fetchImpl) as FchCall<T>;

	return Object.assign(run, tags);
}

export default fch;
