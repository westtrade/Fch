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
	values: unknown[]
): FchCall<unknown> {
	const instance = new Fch(buildUrl(strings, values)).setMethod(method);
	if (body !== undefined && body !== null) applyShortcutBody(instance, body);
	return toCall(instance);
}

/** Bodyless methods: `fch.get\`…\``, `fch.del\`…\``. */
const tag =
	(method: string): UrlTag =>
	<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T> =>
		request(method, undefined, strings, values) as FchCall<T>;

/** Methods that carry a body: `fch.post(body)\`…\``. */
const bodyTag =
	(method: string) =>
	(body: FchBodyInput) =>
	<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T> =>
		request(method, body, strings, values) as FchCall<T>;

/**
 * The body-carrying form. It is a plain function returning a {@link UrlTag},
 * so the generic goes on the *template*:
 *
 * ```ts
 * fch.post(user)`https://…`          // inferred as unknown
 * fch.post(user)<User>`https://…`     // no: use the tag's generic instead
 * const tag = fch.post<User>(user);   // and here it is on the body call
 * ```
 */
export type BodyTag = <T = unknown>(body: FchBodyInput) => UrlTag & {
	(strings: TemplateStringsArray, ...values: unknown[]): FchCall<T>;
};

/**
 * The tagged template. Also carries `raw`, `Fch`, and one tag per HTTP method.
 *
 * Bodyless methods are used directly, body-carrying methods are curried with
 * the body first — the template itself only carries the URL:
 *
 * ```ts
 * fch.get`https://api.example.com/users/1`;
 * fch.delete`https://api.example.com/users/1`;
 * fch.post({ name: "Ann" })`https://api.example.com/users`;
 * fch.put(form)`https://api.example.com/users/1`;
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

	/** `GET https://…` */
	get: UrlTag;
	/** `HEAD https://…` */
	head: UrlTag;
	/** `OPTIONS https://…` */
	options: UrlTag;
	/** `DELETE https://…`. `del` is an alias, for symmetry with `delete` being reserved-ish. */
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
	return toCall<T>(new Fch(buildUrl(strings, values)));
}

export const fch: FchLiteral = Object.assign(literal, {
	raw,
	Fch,
	get: tag('GET'),
	head: tag('HEAD'),
	options: tag('OPTIONS'),
	delete: tag('DELETE'),
	del: tag('DELETE'),
	post: bodyTag('POST'),
	put: bodyTag('PUT'),
	patch: bodyTag('PATCH'),
});

export default fch;
