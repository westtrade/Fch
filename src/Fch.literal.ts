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
import { Fch, toCall, type FchCall } from './Fch';

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

/** The tagged template. Also carries `raw` and `Fch` for convenience. */
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
}

function literal<T = unknown>(
	strings: TemplateStringsArray,
	...values: unknown[]
): FchCall<T> {
	return toCall<T>(new Fch(buildUrl(strings, values)));
}

export const fch: FchLiteral = Object.assign(literal, { raw, Fch });

export default fch;
